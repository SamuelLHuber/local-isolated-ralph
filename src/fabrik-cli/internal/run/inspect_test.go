package run

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestListRunsQueriesJobsWithCorrectLabelSelector(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")

	// Mock kubectl that returns a list of jobs
	jobList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]any{
					"name":              "fabrik-test-run-1",
					"creationTimestamp": "2026-03-01T10:00:00Z",
					"labels": map[string]string{
						"fabrik.sh/run-id":     "test-run-1",
						"fabrik.sh/project":    "myproject",
						"fabrik.sh/spec":       "demo",
						"fabrik.sh/phase":      "run",
						"fabrik.sh/status":     "running",
						"fabrik.sh/task":       "dispatch",
						"fabrik.sh/managed-by": "fabrik",
					},
					"annotations": map[string]string{
						"fabrik.sh/outcome": "",
					},
				},
				"spec": map[string]any{
					"template": map[string]any{
						"spec": map[string]any{
							"containers": []map[string]string{
								{"image": "test@sha256:abc123"},
							},
						},
					},
				},
				"status": map[string]any{
					"startTime": "2026-03-01T10:00:00Z",
				},
			},
		},
	}
	jobJSON, _ := json.Marshal(jobList)

	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"jobs\" ]; then\n" +
		"      printf '%s\\n' '" + string(jobJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"cronjobs\" ]; then\n" +
		"      printf '{\"items\":[]}'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"

	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := InspectOptions{
		Namespace:   "fabrik-runs",
		KubeContext: "",
	}

	var out bytes.Buffer
	if err := ListRuns(context.Background(), &out, opts); err != nil {
		t.Fatalf("ListRuns failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "RUN ID") {
		t.Fatalf("expected header in output, got: %s", output)
	}
	if !strings.Contains(output, "test-run-1") {
		t.Fatalf("expected run ID in output, got: %s", output)
	}
	if !strings.Contains(output, "myproject") {
		t.Fatalf("expected project in output, got: %s", output)
	}

	// Verify kubectl was called with correct label selector
	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	logText := string(logData)
	if !strings.Contains(logText, "-l fabrik.sh/managed-by=fabrik") {
		t.Fatalf("expected label selector in kubectl call, got: %s", logText)
	}
}

func TestListRunsHandlesEmptyResult(t *testing.T) {
	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")

	// Mock kubectl that returns empty lists
	kubectlScript := "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ]; then\n" +
		"      printf '{\"items\":[]}'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"

	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := InspectOptions{
		Namespace: "fabrik-runs",
	}

	var out bytes.Buffer
	if err := ListRuns(context.Background(), &out, opts); err != nil {
		t.Fatalf("ListRuns failed: %v", err)
	}

	if !strings.Contains(out.String(), "no runs found") {
		t.Fatalf("expected 'no runs found' message, got: %s", out.String())
	}
}

func TestShowRunRequiresID(t *testing.T) {
	opts := InspectOptions{
		Namespace: "fabrik-runs",
		RunID:     "", // Empty - should fail
	}

	var out bytes.Buffer
	err := ShowRun(context.Background(), &out, opts)
	if err == nil {
		t.Fatal("expected error for missing --id")
	}
	if !strings.Contains(err.Error(), "missing required flag: --id") {
		t.Fatalf("expected missing --id error, got: %v", err)
	}
}

func TestShowRunReturnsJobDetails(t *testing.T) {
	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")

	// Mock job response
	jobList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]any{
					"name":              "fabrik-test-run-2",
					"creationTimestamp": "2026-03-01T12:00:00Z",
					"labels": map[string]string{
						"fabrik.sh/run-id":     "test-run-2",
						"fabrik.sh/project":    "demo",
						"fabrik.sh/spec":       "feature-x",
						"fabrik.sh/phase":      "implement",
						"fabrik.sh/status":     "running",
						"fabrik.sh/task":       "task-1",
						"fabrik.sh/managed-by": "fabrik",
					},
					"annotations": map[string]string{
						"fabrik.sh/outcome": "succeeded",
						"fabrik.sh/status":  `{"phase":"implement","current_task":"task-1","attempt":1,"progress":{"finished":5,"total":10}}`,
						"fabrik.sh/progress": `{"finished":5,"total":10}`,
					},
				},
				"spec": map[string]any{
					"template": map[string]any{
						"spec": map[string]any{
							"containers": []map[string]string{
								{"image": "fabrik-smithers@sha256:def456"},
							},
						},
					},
				},
				"status": map[string]any{
					"startTime":      "2026-03-01T12:00:00Z",
					"completionTime": "2026-03-01T12:30:00Z",
					"conditions": []map[string]any{
						{
							"type":    "Complete",
							"status":  "True",
							"reason":  "JobComplete",
							"message": "Job completed successfully",
						},
					},
				},
			},
		},
	}
	jobJSON, _ := json.Marshal(jobList)

	// Mock empty pod list
	podList := map[string]any{
		"items": []map[string]any{},
	}
	podJSON, _ := json.Marshal(podList)

	kubectlScript := "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf '%s\\n' '" + string(jobJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"cronjob\" ]; then\n" +
		"      printf '{\"items\":[]}'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pods\" ]; then\n" +
		"      printf '%s\\n' '" + string(podJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"

	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := InspectOptions{
		Namespace: "fabrik-runs",
		RunID:     "test-run-2",
	}

	var out bytes.Buffer
	if err := ShowRun(context.Background(), &out, opts); err != nil {
		t.Fatalf("ShowRun failed: %v", err)
	}

	output := out.String()

	// Verify key fields are present
	if !strings.Contains(output, "test-run-2") {
		t.Fatalf("expected run ID in output, got: %s", output)
	}
	if !strings.Contains(output, "demo") {
		t.Fatalf("expected project in output, got: %s", output)
	}
	if !strings.Contains(output, "feature-x") {
		t.Fatalf("expected spec in output, got: %s", output)
	}
	if !strings.Contains(output, "implement") {
		t.Fatalf("expected phase in output, got: %s", output)
	}
	if !strings.Contains(output, "succeeded") {
		t.Fatalf("expected outcome in output, got: %s", output)
	}
	if !strings.Contains(output, "fabrik-smithers@sha256:def456") {
		t.Fatalf("expected image in output, got: %s", output)
	}
	if !strings.Contains(output, "5/10") {
		t.Fatalf("expected progress in output, got: %s", output)
	}
}

func TestRunLogsRequiresID(t *testing.T) {
	opts := InspectOptions{
		Namespace: "fabrik-runs",
		RunID:     "", // Empty - should fail
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	err := RunLogs(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatal("expected error for missing --id")
	}
	if !strings.Contains(err.Error(), "missing required flag: --id") {
		t.Fatalf("expected missing --id error, got: %v", err)
	}
}

func TestRunLogsRetrievesPodLogs(t *testing.T) {
	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")

	// Mock pod list response
	podList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]string{
					"name":              "fabrik-test-run-3-pod-abc",
					"creationTimestamp": "2026-03-01T14:00:00Z",
				},
				"status": map[string]any{
					"phase":     "Succeeded",
					"startTime": "2026-03-01T14:00:00Z",
					"containerStatuses": []map[string]any{
						{
							"name":         "fabrik",
							"ready":        false,
							"restartCount": 0,
							"state": map[string]any{
								"terminated": map[string]any{
									"exitCode": 0,
									"reason":   "Completed",
								},
							},
						},
					},
				},
			},
		},
	}
	podJSON, _ := json.Marshal(podList)

	expectedLogs := "Hello from Fabrik\nRun completed successfully\n"

	kubectlScript := "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pods\" ]; then\n" +
		"      printf '%s\\n' '" + string(podJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"logs\" ]; then\n" +
		"      printf '%s\\n' '" + expectedLogs + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"

	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := InspectOptions{
		Namespace: "fabrik-runs",
		RunID:     "test-run-3",
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := RunLogs(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("RunLogs failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "Hello from Fabrik") {
		t.Fatalf("expected log content in output, got: %s", output)
	}
	if !strings.Contains(output, "Run completed successfully") {
		t.Fatalf("expected log content in output, got: %s", output)
	}
}

func TestFetchRunPodsParsesContainerStatusCorrectly(t *testing.T) {
	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")

	// Mock pod list with various container states
	podList := map[string]any{
		"items": []map[string]any{
			{
				"metadata": map[string]string{
					"name":              "test-pod-1",
					"creationTimestamp": "2026-03-01T15:00:00Z",
				},
				"status": map[string]any{
					"phase":     "Failed",
					"startTime": "2026-03-01T15:00:00Z",
					"containerStatuses": []map[string]any{
						{
							"name":         "fabrik",
							"ready":        false,
							"restartCount": 2,
							"state": map[string]any{
								"terminated": map[string]any{
									"exitCode": 1,
									"reason":   "Error",
									"message":  "Container crashed",
								},
							},
						},
					},
				},
			},
			{
				"metadata": map[string]string{
					"name":              "test-pod-2",
					"creationTimestamp": "2026-03-01T15:05:00Z",
				},
				"status": map[string]any{
					"phase":     "Pending",
					"startTime": "2026-03-01T15:05:00Z",
					"containerStatuses": []map[string]any{
						{
							"name":         "fabrik",
							"ready":        false,
							"restartCount": 0,
							"state": map[string]any{
								"waiting": map[string]any{
									"reason":  "ImagePullBackOff",
									"message": "Back-off pulling image",
								},
							},
						},
					},
				},
			},
		},
	}
	podJSON, _ := json.Marshal(podList)

	kubectlScript := "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pods\" ]; then\n" +
		"      printf '%s\\n' '" + string(podJSON) + "'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"

	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := InspectOptions{
		Namespace: "fabrik-runs",
		RunID:     "test-run-4",
	}

	pods, err := fetchRunPods(context.Background(), opts)
	if err != nil {
		t.Fatalf("fetchRunPods failed: %v", err)
	}

	if len(pods) != 2 {
		t.Fatalf("expected 2 pods, got %d", len(pods))
	}

	// Check first pod (failed)
	if pods[0].Name != "test-pod-1" {
		t.Errorf("expected pod name test-pod-1, got %s", pods[0].Name)
	}
	if pods[0].Phase != "Failed" {
		t.Errorf("expected phase Failed, got %s", pods[0].Phase)
	}
	if pods[0].ExitCode != 1 {
		t.Errorf("expected exit code 1, got %d", pods[0].ExitCode)
	}
	if pods[0].Reason != "Error" {
		t.Errorf("expected reason Error, got %s", pods[0].Reason)
	}
	if len(pods[0].Containers) != 1 {
		t.Fatalf("expected 1 container, got %d", len(pods[0].Containers))
	}
	if pods[0].Containers[0].Restarted != 2 {
		t.Errorf("expected 2 restarts, got %d", pods[0].Containers[0].Restarted)
	}

	// Check second pod (pending/waiting)
	if pods[1].Name != "test-pod-2" {
		t.Errorf("expected pod name test-pod-2, got %s", pods[1].Name)
	}
	if pods[1].Phase != "Pending" {
		t.Errorf("expected phase Pending, got %s", pods[1].Phase)
	}
	if pods[1].Reason != "ImagePullBackOff" {
		t.Errorf("expected reason ImagePullBackOff, got %s", pods[1].Reason)
	}
}

func TestTruncateHelper(t *testing.T) {
	tests := []struct {
		input    string
		maxLen   int
		expected string
	}{
		{"hello", 10, "hello"},
		{"hello world", 8, "hello w…"},
		{"", 5, ""},
		{"exact", 5, "exact"},
	}

	for _, tt := range tests {
		result := truncate(tt.input, tt.maxLen)
		if result != tt.expected {
			t.Errorf("truncate(%q, %d) = %q, expected %q", tt.input, tt.maxLen, result, tt.expected)
		}
	}
}

func TestCoalesceHelper(t *testing.T) {
	if got := coalesce("", "b", ""); got != "b" {
		t.Errorf("coalesce(\"\", \"b\", \"\") = %q, expected \"b\"", got)
	}
	if got := coalesce("a", "b"); got != "a" {
		t.Errorf("coalesce(\"a\", \"b\") = %q, expected \"a\"", got)
	}
	if got := coalesce("", "", "c"); got != "c" {
		t.Errorf("coalesce(\"\", \"\", \"c\") = %q, expected \"c\"", got)
	}
	if got := coalesce("", ""); got != "" {
		t.Errorf("coalesce(\"\", \"\") = %q, expected \"\"", got)
	}
}

func TestFormatAge(t *testing.T) {
	now := time.Now()

	tests := []struct {
		time     time.Time
		expected string
	}{
		{time.Time{}, "-"},
		{now.Add(-5 * time.Minute), "5m0s"},
	}

	for _, tt := range tests {
		result := formatAge(tt.time)
		// For non-zero times, we just check it doesn't panic and returns something
		if tt.expected == "-" && result != "-" {
			t.Errorf("formatAge(zero) = %q, expected \"-\"", result)
		}
	}
}
