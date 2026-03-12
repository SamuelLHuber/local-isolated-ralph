package run

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCancelRunRequiresRunID(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer

	opts := CancelOptions{
		Namespace:   "fabrik-runs",
		KubeContext: "",
		RunID:       "",
	}

	result, err := CancelRun(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected error for missing run-id")
	}
	if !strings.Contains(err.Error(), "missing required flag: --id") {
		t.Fatalf("expected missing --id error, got: %v", err)
	}
	if result != nil {
		t.Fatalf("expected nil result on error, got: %v", result)
	}
}

func TestCancelRunFailsWhenRunNotFound(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'No resources found in fabrik-runs namespace.\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"cronjob\" ]; then\n" +
		"      printf 'No resources found in fabrik-runs namespace.\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := CancelOptions{
		Namespace: "fabrik-runs",
		RunID:     "run-not-found",
	}

	result, err := CancelRun(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected error when run not found")
	}
	if !strings.Contains(err.Error(), "run-not-found not found") {
		t.Fatalf("expected run not found error, got: %v", err)
	}
	if result != nil {
		t.Fatalf("expected nil result on error, got: %v", result)
	}
}

func TestCancelRunSucceedsForActiveJob(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")

	jobList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]any{
					"name": "fabrik-active-run",
				},
				"status": map[string]any{
					"active":    1,
					"succeeded": 0,
					"failed":    0,
				},
			},
		},
	}
	jobJSON, _ := json.Marshal(jobList)

	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf '%s\\n' '" + string(jobJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"delete\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'job \"%s\" deleted\\n' \"$5\"\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := CancelOptions{
		Namespace: "fabrik-runs",
		RunID:     "active-run",
	}

	result, err := CancelRun(context.Background(), &out, &errOut, opts)
	if err != nil {
		t.Fatalf("expected success: %v", err)
	}
	if result == nil {
		t.Fatalf("expected non-nil result")
	}
	if result.RunID != "active-run" {
		t.Fatalf("expected run ID active-run, got: %s", result.RunID)
	}
	if result.Kind != "Job" {
		t.Fatalf("expected kind Job, got: %s", result.Kind)
	}
	if result.Name != "fabrik-active-run" {
		t.Fatalf("expected name fabrik-active-run, got: %s", result.Name)
	}
	if !result.WasActive {
		t.Fatalf("expected WasActive to be true")
	}
	if result.WasFinished {
		t.Fatalf("expected WasFinished to be false")
	}

	output := out.String()
	if !strings.Contains(output, "cancelled run active-run") {
		t.Fatalf("expected cancellation message, got: %s", output)
	}
	if !strings.Contains(output, "fabrik-active-run") {
		t.Fatalf("expected job name in output, got: %s", output)
	}
	if !strings.Contains(output, "Active") {
		t.Fatalf("expected 'Active' status in output, got: %s", output)
	}
}

func TestCancelRunSucceedsForFinishedJob(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")

	jobList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]any{
					"name": "fabrik-finished-run",
				},
				"status": map[string]any{
					"active":    0,
					"succeeded": 1,
					"failed":    0,
					"conditions": []map[string]any{
						{
							"type":   "Complete",
							"status": "True",
						},
					},
				},
			},
		},
	}
	jobJSON, _ := json.Marshal(jobList)

	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf '%s\\n' '" + string(jobJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"delete\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'job \"%s\" deleted\\n' \"$5\"\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := CancelOptions{
		Namespace: "fabrik-runs",
		RunID:     "finished-run",
	}

	result, err := CancelRun(context.Background(), &out, &errOut, opts)
	if err != nil {
		t.Fatalf("expected success: %v", err)
	}
	if result == nil {
		t.Fatalf("expected non-nil result")
	}
	if !result.WasFinished {
		t.Fatalf("expected WasFinished to be true")
	}
	if result.WasActive {
		t.Fatalf("expected WasActive to be false")
	}

	output := out.String()
	if !strings.Contains(output, "already finished") {
		t.Fatalf("expected 'already finished' message, got: %s", output)
	}
}

func TestCancelRunSucceedsForCronJob(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")

	cronJobList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]any{
					"name": "fabrik-cron-run",
				},
				"status": map[string]any{
					"active": []map[string]any{
						{"name": "fabrik-cron-run-abc123"},
					},
				},
			},
		},
	}
	cronJobJSON, _ := json.Marshal(cronJobList)

	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'No resources found in fabrik-runs namespace.\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"cronjob\" ]; then\n" +
		"      printf '%s\\n' '" + string(cronJobJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"delete\" ] && [ \"$4\" = \"cronjob\" ]; then\n" +
		"      printf 'cronjob \"%s\" deleted\\n' \"$5\"\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := CancelOptions{
		Namespace: "fabrik-runs",
		RunID:     "cron-run",
	}

	result, err := CancelRun(context.Background(), &out, &errOut, opts)
	if err != nil {
		t.Fatalf("expected success: %v", err)
	}
	if result == nil {
		t.Fatalf("expected non-nil result")
	}
	if result.Kind != "CronJob" {
		t.Fatalf("expected kind CronJob, got: %s", result.Kind)
	}
	if result.Name != "fabrik-cron-run" {
		t.Fatalf("expected name fabrik-cron-run, got: %s", result.Name)
	}
	if !result.WasActive {
		t.Fatalf("expected WasActive to be true for active cronjob")
	}

	output := out.String()
	if !strings.Contains(output, "cancelled run cron-run") {
		t.Fatalf("expected cancellation message, got: %s", output)
	}
	if !strings.Contains(output, "CronJob") {
		t.Fatalf("expected CronJob in output, got: %s", output)
	}
}

func TestCancelRunSucceedsForCronChildJob(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")

	jobList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]any{
					"name": "fabrik-cron-child-run",
					"ownerReferences": []map[string]any{
						{
							"kind": "CronJob",
							"name": "fabrik-cron-parent",
						},
					},
				},
				"status": map[string]any{
					"active":    1,
					"succeeded": 0,
					"failed":    0,
				},
			},
		},
	}
	jobJSON, _ := json.Marshal(jobList)

	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf '%s\\n' '" + string(jobJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"delete\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'job \"%s\" deleted\\n' \"$5\"\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := CancelOptions{
		Namespace: "fabrik-runs",
		RunID:     "cron-child-run",
	}

	result, err := CancelRun(context.Background(), &out, &errOut, opts)
	if err != nil {
		t.Fatalf("expected success: %v", err)
	}
	if result == nil {
		t.Fatalf("expected non-nil result")
	}
	if result.Kind != "CronJobChild" {
		t.Fatalf("expected kind CronJobChild, got: %s", result.Kind)
	}
	if result.Name != "fabrik-cron-child-run" {
		t.Fatalf("expected name fabrik-cron-child-run, got: %s", result.Name)
	}

	output := out.String()
	if !strings.Contains(output, "cancelled run cron-child-run") {
		t.Fatalf("expected cancellation message, got: %s", output)
	}
}

func TestCancelRunUsesDefaultNamespace(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")

	jobList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]any{
					"name": "fabrik-default-ns",
				},
				"status": map[string]any{
					"active": 1,
				},
			},
		},
	}
	jobJSON, _ := json.Marshal(jobList)

	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$2\" = \"fabrik-runs\" ] && [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf '%s\\n' '" + string(jobJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"delete\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'job \"%s\" deleted\\n' \"$5\"\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := CancelOptions{
		// Namespace not set - should default to fabrik-runs
		RunID: "default-ns-test",
	}

	result, err := CancelRun(context.Background(), &out, &errOut, opts)
	if err != nil {
		t.Fatalf("expected success: %v", err)
	}
	if result == nil {
		t.Fatalf("expected non-nil result")
	}
	if result.Namespace != "fabrik-runs" {
		t.Fatalf("expected namespace fabrik-runs, got: %s", result.Namespace)
	}
}

func TestCancelRunHandlesFailedJob(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")

	jobList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]any{
					"name": "fabrik-failed-run",
				},
				"status": map[string]any{
					"active":    0,
					"succeeded": 0,
					"failed":    1,
					"conditions": []map[string]any{
						{
							"type":   "Failed",
							"status": "True",
						},
					},
				},
			},
		},
	}
	jobJSON, _ := json.Marshal(jobList)

	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf '%s\\n' '" + string(jobJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"delete\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'job \"%s\" deleted\\n' \"$5\"\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := CancelOptions{
		Namespace: "fabrik-runs",
		RunID:     "failed-run",
	}

	result, err := CancelRun(context.Background(), &out, &errOut, opts)
	if err != nil {
		t.Fatalf("expected success: %v", err)
	}
	if result == nil {
		t.Fatalf("expected non-nil result")
	}
	if !result.WasFinished {
		t.Fatalf("expected WasFinished to be true for failed job")
	}
}

func TestFormatCancelMessage(t *testing.T) {
	tests := []struct {
		kind     string
		name     string
		active   bool
		finished bool
		expected string
	}{
		{"Job", "test-job", true, false, "Active Job test-job"},
		{"Job", "test-job", false, true, "already finished"},
		{"Job", "test-job", false, false, "Job test-job"},
		{"CronJob", "test-cron", true, false, "Active CronJob test-cron"},
		{"CronJobChild", "test-child", true, false, "Active CronJobChild test-child"},
	}

	for _, tt := range tests {
		msg := formatCancelMessage(tt.kind, tt.name, tt.active, tt.finished)
		if !strings.Contains(msg, tt.expected) {
			t.Errorf("formatCancelMessage(%q, %q, %v, %v) = %q, expected to contain %q",
				tt.kind, tt.name, tt.active, tt.finished, msg, tt.expected)
		}
	}
}
