package cmd

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunsListOutputsTable(t *testing.T) {
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-run-01",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01JK7V8X1234567890ABCDEFGH",
						"fabrik.sh/project": "myapp",
						"fabrik.sh/spec": "feature-x",
						"fabrik.sh/phase": "implement",
						"fabrik.sh/status": "running",
						"fabrik.sh/task": "task-1",
						"fabrik.sh/managed-by": "fabrik"
					},
					"annotations": {
						"fabrik.sh/status": "{\"phase\":\"implement\",\"current_task\":\"task-1\",\"attempt\":1,\"progress\":{\"finished\":5,\"total\":10}}",
						"fabrik.sh/started-at": "2026-03-01T10:00:00Z"
					}
				},
				"spec": {
					"template": {
						"spec": {
							"containers": [{"image": "ghcr.io/fabrik/smithers@sha256:abc123"}]
						}
					}
				},
				"status": {
					"active": 1,
					"startTime": "2026-03-01T10:00:00Z"
				}
			}
		]
	}`

	cronJobsJSON := `{"items":[]}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*)
		printf '%s\n' '` + jobsJSON + `'
		exit 0
		;;
	*"get cronjobs"*)
		printf '%s\n' '` + cronJobsJSON + `'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runsListOptions{
		Namespace: "fabrik-runs",
		Output:    "table",
	}

	if err := runRunsList(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunsList failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "01JK7V8X1234567890ABCDEFGH") {
		t.Errorf("expected output to contain run-id, got:\n%s", output)
	}
	if !strings.Contains(output, "myapp") {
		t.Errorf("expected output to contain project, got:\n%s", output)
	}
	if !strings.Contains(output, "implement") {
		t.Errorf("expected output to contain phase, got:\n%s", output)
	}
	if !strings.Contains(output, "running") {
		t.Errorf("expected output to contain status, got:\n%s", output)
	}
	if !strings.Contains(output, "5/10") {
		t.Errorf("expected output to contain progress, got:\n%s", output)
	}
}

func TestRunsListOutputsJSON(t *testing.T) {
	jobsJSON := `{"items":[]}`
	cronJobsJSON := `{"items":[]}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*)
		printf '%s\n' '` + jobsJSON + `'
		exit 0
		;;
	*"get cronjobs"*)
		printf '%s\n' '` + cronJobsJSON + `'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runsListOptions{
		Namespace: "fabrik-runs",
		Output:    "json",
	}

	if err := runRunsList(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunsList failed: %v", err)
	}

	output := out.String()
	// An empty list returns "null" in JSON when the array is nil, or "[]" when empty
	// Both are valid; we just need valid JSON
	if !strings.Contains(output, "[") && !strings.Contains(output, "null") {
		t.Errorf("expected JSON array or null output, got:\n%s", output)
	}
}

func TestRunsListOutputsNames(t *testing.T) {
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-run-01",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01JK7V8X1234567890ABCDEFGH",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {"template": {"spec": {"containers": [{"image": "test"}]}}},
				"status": {"active": 1}
			}
		]
	}`

	cronJobsJSON := `{"items":[]}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*)
		printf '%s\n' '` + jobsJSON + `'
		exit 0
		;;
	*"get cronjobs"*)
		printf '%s\n' '` + cronJobsJSON + `'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runsListOptions{
		Namespace: "fabrik-runs",
		Output:    "name",
	}

	if err := runRunsList(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunsList failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "01JK7V8X1234567890ABCDEFGH") {
		t.Errorf("expected output to contain run-id, got:\n%s", output)
	}
}

func TestRunsShowOutputsTable(t *testing.T) {
	jobJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-run-show",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01JK7V8XSHOW1234567890123",
						"fabrik.sh/project": "demo",
						"fabrik.sh/spec": "test",
						"fabrik.sh/phase": "run",
						"fabrik.sh/status": "succeeded",
						"fabrik.sh/task": "cleanup",
						"fabrik.sh/managed-by": "fabrik"
					},
					"annotations": {
						"fabrik.sh/status": "{\"phase\":\"run\",\"current_task\":\"cleanup\",\"attempt\":1,\"progress\":{\"finished\":10,\"total\":10}}",
						"fabrik.sh/started-at": "2026-03-10T10:00:00Z",
						"fabrik.sh/finished-at": "2026-03-10T11:00:00Z",
						"fabrik.sh/outcome": "succeeded"
					}
				},
				"spec": {
					"template": {
						"spec": {
							"containers": [{"image": "smithers@sha256:def"}]
						}
					}
				},
				"status": {
					"succeeded": 1,
					"startTime": "2026-03-10T10:00:00Z",
					"completionTime": "2026-03-10T11:00:00Z"
				}
			}
		]
	}`

	podJSON := `{"items":[]}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=01JK7V8XSHOW1234567890123"*)
		printf '%s\n' '` + jobJSON + `'
		exit 0
		;;
	*"get pods"*)
		printf '%s\n' '` + podJSON + `'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runsShowOptions{
		RunID:     "01JK7V8XSHOW1234567890123",
		Namespace: "fabrik-runs",
		Output:    "table",
	}

	if err := runRunsShow(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunsShow failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "01JK7V8XSHOW1234567890123") {
		t.Errorf("expected output to contain run-id, got:\n%s", output)
	}
	if !strings.Contains(output, "demo") {
		t.Errorf("expected output to contain project, got:\n%s", output)
	}
	if !strings.Contains(output, "succeeded") {
		t.Errorf("expected output to contain status succeeded, got:\n%s", output)
	}
}

func TestRunsShowOutputsJSON(t *testing.T) {
	jobJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-run-json",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01JK7V8XJSON1234567890123",
						"fabrik.sh/project": "demo",
						"fabrik.sh/spec": "test",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {"template": {"spec": {"containers": [{"image": "test"}]}}},
				"status": {"active": 1}
			}
		]
	}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=01JK7V8XJSON1234567890123"*)
		printf '%s\n' '` + jobJSON + `'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runsShowOptions{
		RunID:     "01JK7V8XJSON1234567890123",
		Namespace: "fabrik-runs",
		Output:    "json",
	}

	if err := runRunsShow(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunsShow failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, `"run_id"`) {
		t.Errorf("expected JSON output with run_id field, got:\n%s", output)
	}
	if !strings.Contains(output, "01JK7V8XJSON1234567890123") {
		t.Errorf("expected JSON output to contain run-id, got:\n%s", output)
	}
}

func TestRunLogsReturnsLogs(t *testing.T) {
	jobJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-run-logs",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01JK7V8XLOGS1234567890123",
						"fabrik.sh/project": "test",
						"fabrik.sh/spec": "test",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {"template": {"spec": {"containers": [{"image": "test"}]}}},
				"status": {"active": 1}
			}
		]
	}`

	podJSON := `{
		"items": [
			{
				"metadata": {
					"name": "logs-pod",
					"namespace": "fabrik-runs",
					"labels": {"fabrik.sh/run-id": "01JK7V8XLOGS1234567890123"}
				},
				"status": {"phase": "Running"}
			}
		]
	}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=01JK7V8XLOGS1234567890123"*)
		printf '%s\n' '` + jobJSON + `'
		exit 0
		;;
	*"get pods"*"fabrik.sh/run-id=01JK7V8XLOGS1234567890123"*)
		printf '%s\n' '` + podJSON + `'
		exit 0
		;;
	*"logs"*)
		printf 'log output line 1\nlog output line 2\n'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runLogsOptions{
		RunID:     "01JK7V8XLOGS1234567890123",
		Namespace: "fabrik-runs",
		Tail:      200,
	}

	if err := runRunLogs(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunLogs failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "log output line 1") {
		t.Errorf("expected output to contain log line 1, got:\n%s", output)
	}
	if !strings.Contains(output, "log output line 2") {
		t.Errorf("expected output to contain log line 2, got:\n%s", output)
	}
}

func TestRunCancel(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += "echo \"$@\" >> " + kubectlLog + "\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=test-cancel-run"*)
		printf '{"items":[{"metadata":{"name":"test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"test-cancel-run"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{"active":1}}]}\n'
		exit 0
		;;
	*"delete job"*)
		printf 'job deleted\n'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runCancelOptions{
		RunID:     "test-cancel-run",
		Namespace: "fabrik-runs",
	}

	if err := runRunCancel(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunCancel failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "Canceled") {
		t.Errorf("expected output to confirm cancel, got:\n%s", output)
	}
	if !strings.Contains(output, "active") {
		t.Errorf("expected output to mention 'active' for active job, got:\n%s", output)
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	if !strings.Contains(string(logData), "delete job") {
		t.Errorf("expected kubectl delete to be called")
	}
}

func TestRunCancelFinishedJob(t *testing.T) {
	// Canceling a finished job should indicate cleanup, not active cancellation
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=finished-cancel-run"*)
		printf '{"items":[{"metadata":{"name":"finished-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"finished-cancel-run"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{"succeeded":1}}]}\n'
		exit 0
		;;
	*"delete job"*)
		printf 'job deleted\n'
		exit 0
		;;
esac
exit 1
`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runCancelOptions{
		RunID:     "finished-cancel-run",
		Namespace: "fabrik-runs",
	}

	if err := runRunCancel(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunCancel failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "Cleaned up") {
		t.Errorf("expected output to say 'Cleaned up' for finished job, got:\n%s", output)
	}
	if !strings.Contains(output, "succeeded") {
		t.Errorf("expected output to mention 'succeeded' status, got:\n%s", output)
	}
}

func TestRunCancelMissingRun(t *testing.T) {
	// Canceling a missing run should return error
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=missing-run"*)
		printf '{"items":[]}\n'
		exit 0
		;;
	*"get cronjobs"*"fabrik.sh/run-id=missing-run"*)
		printf '{"items":[]}\n'
		exit 0
		;;
esac
exit 1
`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runCancelOptions{
		RunID:     "missing-run",
		Namespace: "fabrik-runs",
	}

	err := runRunCancel(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatal("expected runRunCancel to fail for missing run")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected error to mention 'not found', got: %v", err)
	}
}

func TestRunResume(t *testing.T) {
	// Mock that handles the resume flow with immutable image and PVC verification
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=test-resume-run"; then
		echo '{"items":[{"metadata":{"name":"test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"test-resume-run","fabrik.sh/managed-by":"fabrik"}},"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/fabrik/smithers@sha256:abc123def456789"}]}}},"status":{"active":1}}]}'
		exit 0
	fi
	if echo "$*" | grep -q "get pvc.*data-fabrik-test-resume-run"; then
		echo 'Bound'
		exit 0
	fi
	if echo "$*" | grep -q "get pods.*job-name=test-job"; then
		echo '{"items":[]}'
		exit 0
	fi
	if echo "$*" | grep -q "jsonpath={.items\[0\].metadata.name}"; then
		echo 'resume-pod'
		exit 0
	fi
	if echo "$*" | grep -q "delete pod resume-pod"; then
		echo 'pod deleted'
		exit 0
	fi
	exit 1
`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runResumeOptions{
		RunID:     "test-resume-run",
		Namespace: "fabrik-runs",
	}

	if err := runRunResume(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunResume failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "Resumed") {
		t.Errorf("expected output to confirm resume, got:\n%s", output)
	}
}

func TestRunResumeRBACError(t *testing.T) {
	// Mock that simulates RBAC permission denied error
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=test-rbac-deny"; then
		echo '{"items":[{"metadata":{"name":"test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"test-rbac-deny"}},"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/fabrik/smithers@sha256:abc123"}]}}},"status":{"active":1}}]}'
		exit 0
	fi
	if echo "$*" | grep -q "get pvc.*data-fabrik-test-rbac-deny"; then
		echo 'Bound'
		exit 0
	fi
	if echo "$*" | grep -q "jsonpath={.items\[0\].metadata.name}"; then
		echo 'test-pod'
		exit 0
	fi
	if echo "$*" | grep -q "delete pod test-pod"; then
		echo 'Error from server (Forbidden): pods "test-pod" is forbidden: User "system:serviceaccount:fabrik-runs:test-runner" cannot delete resource "pods" in API group "" in the namespace "fabrik-runs"' >&2
		exit 1
	fi
	exit 1
`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runResumeOptions{
		RunID:     "test-rbac-deny",
		Namespace: "fabrik-runs",
	}

	err := runRunResume(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatal("expected runRunResume to fail with RBAC error")
	}

	// Error should mention permissions or RBAC
	errStr := err.Error()
	if !strings.Contains(errStr, "permission") && !strings.Contains(errStr, "forbidden") && !strings.Contains(errStr, "RBAC") && !strings.Contains(errStr, "insufficient") {
		t.Errorf("expected error to mention permissions/RBAC, got: %v", err)
	}
}

func TestTruncate(t *testing.T) {
	if truncate("short", 10) != "short" {
		t.Errorf("expected short string to be unchanged")
	}
	if truncate("this is a very long string", 10) != "this is a " {
		t.Errorf("expected truncation to 10 chars")
	}
}

func TestFormatAge(t *testing.T) {
	now := time.Now()
	
	// Test with nil time
	if formatAge(nil, now) != "unknown" {
		t.Errorf("expected unknown for nil time")
	}
	
	// Test recent time (30 seconds ago)
	recent := now.Add(-30 * time.Second)
	result := formatAge(&recent, now)
	if result != "<1m" {
		t.Errorf("expected <1m for 30 seconds ago, got %s", result)
	}
	
	// Test hours ago
	hoursAgo := now.Add(-3 * time.Hour)
	result = formatAge(&hoursAgo, now)
	if result != "3h" {
		t.Errorf("expected 3h for 3 hours ago, got %s", result)
	}
	
	// Test days ago
	daysAgo := now.Add(-72 * time.Hour)
	result = formatAge(&daysAgo, now)
	if result != "3d" {
		t.Errorf("expected 3d for 72 hours ago, got %s", result)
	}
}

func TestRunsCleanupDeletesOldFinishedRuns(t *testing.T) {
	// Job finished 8 days ago
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-old-run",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01OLD",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {"template": {"spec": {"containers": [{"image": "test"}]}}},
				"status": {"succeeded": 1, "completionTime": "` + time.Now().UTC().Add(-8*24*time.Hour).Format(time.RFC3339) + `"}
			}
		]
	}`

	cronJobsJSON := `{"items":[]}`

	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += "echo \"$@\" >> " + kubectlLog + "\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/managed-by=fabrik"*)
		printf '%s\n' '` + jobsJSON + `'
		exit 0
		;;
	*"get cronjobs"*)
		printf '%s\n' '` + cronJobsJSON + `'
		exit 0
		;;
	*"delete job"*)
		printf 'job deleted\n'
		exit 0
		;;
	*"delete pvc"*)
		printf 'pvc deleted\n'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runsCleanupOptions{
		Namespace: "fabrik-runs",
		OlderThan: "7d",
		Status:    "finished",
	}

	if err := runRunsCleanup(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunsCleanup failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "Deleted 1 run(s)") {
		t.Errorf("expected 'Deleted 1 run(s)', got:\n%s", output)
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	if !strings.Contains(string(logData), "delete job") {
		t.Errorf("expected kubectl delete job to be called")
	}
}

func TestRunsCleanupDryRun(t *testing.T) {
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-old-run",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01OLD",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {"template": {"spec": {"containers": [{"image": "test"}]}}},
				"status": {"succeeded": 1, "completionTime": "` + time.Now().UTC().Add(-8*24*time.Hour).Format(time.RFC3339) + `"}
			}
		]
	}`

	cronJobsJSON := `{"items":[]}`

	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += "echo \"$@\" >> " + kubectlLog + "\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/managed-by=fabrik"*)
		printf '%s\n' '` + jobsJSON + `'
		exit 0
		;;
	*"get cronjobs"*)
		printf '%s\n' '` + cronJobsJSON + `'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runsCleanupOptions{
		Namespace: "fabrik-runs",
		OlderThan: "7d",
		DryRun:    true,
	}

	if err := runRunsCleanup(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunsCleanup dry-run failed: %v", err)
	}

	output := out.String()
	// In dry-run mode, items are shown as "skipped" with (dry-run) suffix
	if !strings.Contains(output, "Would delete 0 run(s)") {
		t.Errorf("expected 'Would delete 0 run(s)' in dry-run output, got:\n%s", output)
	}
	if !strings.Contains(output, "Skipped 1 run(s)") {
		t.Errorf("expected 'Skipped 1 run(s)' in dry-run output, got:\n%s", output)
	}
	if !strings.Contains(output, "01OLD (dry-run)") {
		t.Errorf("expected run to be marked with (dry-run), got:\n%s", output)
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	// Should not call delete in dry-run mode
	if strings.Contains(string(logData), "delete job") {
		t.Errorf("expected no kubectl delete job in dry-run mode")
	}
}

func TestVolumesCleanupDeletesOrphanedPVCs(t *testing.T) {
	pvcJSON := `{
		"items": [
			{
				"metadata": {
					"name": "data-fabrik-orphan",
					"namespace": "fabrik-runs",
					"labels": {"fabrik.sh/managed-by": "fabrik"}
				},
				"spec": {},
				"status": {"phase": "Released"}
			}
		]
	}`

	jobsJSON := `{"items":[]}`

	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += "echo \"$@\" >> " + kubectlLog + "\n"
	script += `case "$*" in
	*"get pvc"*"fabrik.sh/managed-by=fabrik"*)
		printf '%s\n' '` + pvcJSON + `'
		exit 0
		;;
	*"get jobs"*"fabrik.sh/managed-by=fabrik"*)
		printf '%s\n' '` + jobsJSON + `'
		exit 0
		;;
	*"delete pvc"*)
		printf 'pvc deleted\n'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := volumesCleanupOptions{
		Namespace: "fabrik-runs",
		Unused:    true,
	}

	if err := runVolumesCleanup(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runVolumesCleanup failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "Deleted 1 orphaned volume(s)") {
		t.Errorf("expected 'Deleted 1 orphaned volume(s)', got:\n%s", output)
	}
}

func TestRunRetain(t *testing.T) {
	jobJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-retain-run",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01RETAIN",
						"fabrik.sh/managed-by": "fabrik"
					},
					"uid": "job-uid-123"
				},
				"spec": {
					"template": {"spec": {"containers": [{"image": "test"}]}},
					"ttlSecondsAfterFinished": 604800
				},
				"status": {"succeeded": 1}
			}
		]
	}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=01RETAIN"*)
		printf '%s\n' '` + jobJSON + `'
		exit 0
		;;
	*"patch job"*)
		printf 'job patched\n'
		exit 0
		;;
	*"get pvc"*)
		printf '{"items":[]}\n'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := runRetainOptions{
		RunID:     "01RETAIN",
		Namespace: "fabrik-runs",
		Days:      30,
	}

	if err := runRunRetain(context.Background(), &out, &errOut, opts); err != nil {
		t.Fatalf("runRunRetain failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "Retained run 01RETAIN for 30 days") {
		t.Errorf("expected retention confirmation, got:\n%s", output)
	}
	if !strings.Contains(output, "Retained until:") {
		t.Errorf("expected retained until timestamp, got:\n%s", output)
	}
}

func TestParseDuration(t *testing.T) {
	tests := []struct {
		input    string
		expected time.Duration
		wantErr  bool
	}{
		{"7d", 7 * 24 * time.Hour, false},
		{"30d", 30 * 24 * time.Hour, false},
		{"24h", 24 * time.Hour, false},
		{"1h30m", time.Hour + 30*time.Minute, false},
		{"invalid", 0, true},
		{"", 0, true},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result, err := parseDuration(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Errorf("expected error for input %q", tt.input)
				}
				return
			}
			if err != nil {
				t.Errorf("unexpected error for input %q: %v", tt.input, err)
				return
			}
			if result != tt.expected {
				t.Errorf("parseDuration(%q) = %v, want %v", tt.input, result, tt.expected)
			}
		})
	}
}
