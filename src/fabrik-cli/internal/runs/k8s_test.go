package runs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// setupMockKubectl creates a mock kubectl binary for testing
func setupMockKubectl(t *testing.T, responses map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")

	script := "#!/bin/sh\n"
	script += "echo \"$@\" >> " + filepath.Join(dir, "kubectl.log") + "\n"
	script += "case \"$1\" in\n"
	script += "  get|list)\n"
	script += "    case \"$*\" in\n"
	
	for pattern, response := range responses {
		escapedPattern := strings.ReplaceAll(pattern, "\"", "\\\"")
		script += "      *\"" + escapedPattern + "\"*)\n"
		script += "        printf '%s\\n' '" + strings.ReplaceAll(response, "'", "'\"'\"'") + "'\n"
		script += "        exit 0\n"
		script += "        ;;\n"
	}
	
	script += "    esac\n"
	script += "    ;;\n"
	script += "esac\n"
	script += "exit 1\n"

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir
}

func TestListReturnsRunsFromJobsAndCronJobs(t *testing.T) {
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
						"fabrik.sh/started-at": "2026-03-01T10:00:00Z",
						"fabrik.sh/progress": "{\"finished\":5,\"total\":10}"
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

	cronJobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-cron-schedule-1",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01JK7V8XCRON7890123456789A",
						"fabrik.sh/project": "myapp",
						"fabrik.sh/spec": "nightly",
						"fabrik.sh/managed-by": "fabrik"
					},
					"annotations": {
						"fabrik.sh/cron-schedule": "0 2 * * *"
					}
				},
				"spec": {
					"schedule": "0 2 * * *"
				}
			}
		]
	}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/managed-by=fabrik"*)
		printf '%s\n' '` + jobsJSON + `'
		exit 0
		;;
	*"get cronjobs"*"fabrik.sh/managed-by=fabrik"*)
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	runs, err := client.List(context.Background())
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}

	if len(runs) != 2 {
		t.Fatalf("expected 2 runs, got %d: %+v", len(runs), runs)
	}

	// Check Job run
	jobRun := runs[0]
	if jobRun.RunID != "01JK7V8X1234567890ABCDEFGH" {
		t.Errorf("expected run-id 01JK7V8X1234567890ABCDEFGH, got %s", jobRun.RunID)
	}
	if jobRun.Project != "myapp" {
		t.Errorf("expected project myapp, got %s", jobRun.Project)
	}
	if jobRun.Phase != "implement" {
		t.Errorf("expected phase implement, got %s", jobRun.Phase)
	}
	if jobRun.Status != "running" {
		t.Errorf("expected status running, got %s", jobRun.Status)
	}
	if jobRun.Task != "task-1" {
		t.Errorf("expected task task-1, got %s", jobRun.Task)
	}
	if jobRun.Image != "ghcr.io/fabrik/smithers@sha256:abc123" {
		t.Errorf("expected image ghcr.io/fabrik/smithers@sha256:abc123, got %s", jobRun.Image)
	}
	if jobRun.Progress.Finished != 5 || jobRun.Progress.Total != 10 {
		t.Errorf("expected progress 5/10, got %d/%d", jobRun.Progress.Finished, jobRun.Progress.Total)
	}
	if jobRun.IsCronJob {
		t.Errorf("expected IsCronJob false for Job run")
	}

	// Check CronJob run
	cronRun := runs[1]
	if cronRun.RunID != "01JK7V8XCRON7890123456789A" {
		t.Errorf("expected run-id 01JK7V8XCRON7890123456789A, got %s", cronRun.RunID)
	}
	if !cronRun.IsCronJob {
		t.Errorf("expected IsCronJob true for CronJob run")
	}
	if cronRun.CronSchedule != "0 2 * * *" {
		t.Errorf("expected cron schedule 0 2 * * *, got %s", cronRun.CronSchedule)
	}
}

func TestShowReturnsRunDetailsByID(t *testing.T) {
	jobJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-run-abc123",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01JK7V8XABC123DEF456GHI789",
						"fabrik.sh/project": "testproj",
						"fabrik.sh/spec": "demo",
						"fabrik.sh/phase": "run",
						"fabrik.sh/status": "running",
						"fabrik.sh/task": "step-2"
					},
					"annotations": {
						"fabrik.sh/status": "{\"phase\":\"run\",\"current_task\":\"step-2\",\"attempt\":1,\"progress\":{\"finished\":2,\"total\":5}}",
						"fabrik.sh/started-at": "2026-03-10T14:30:00Z",
						"fabrik.sh/outcome": ""
					}
				},
				"spec": {
					"template": {
						"spec": {
							"containers": [{"image": "smithers@sha256:def789"}]
						}
					}
				},
				"status": {
					"active": 1,
					"startTime": "2026-03-10T14:30:00Z"
				}
			}
		]
	}`

	podJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-run-abc123-pod-xyz",
					"namespace": "fabrik-runs",
					"labels": {
						"job-name": "fabrik-run-abc123"
					}
				},
				"status": {
					"phase": "Running",
					"containerStatuses": [{"imageID": "docker-pullable://ghcr.io/fabrik/smithers@sha256:def789"}]
				}
			}
		]
	}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=01JK7V8XABC123DEF456GHI789"*)
		printf '%s\n' '` + jobJSON + `'
		exit 0
		;;
	*"get pods"*"job-name=fabrik-run-abc123"*)
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	run, err := client.Show(context.Background(), "01JK7V8XABC123DEF456GHI789")
	if err != nil {
		t.Fatalf("Show failed: %v", err)
	}

	if run.RunID != "01JK7V8XABC123DEF456GHI789" {
		t.Errorf("expected run-id 01JK7V8XABC123DEF456GHI789, got %s", run.RunID)
	}
	if run.Project != "testproj" {
		t.Errorf("expected project testproj, got %s", run.Project)
	}
	if run.PodName != "fabrik-run-abc123-pod-xyz" {
		t.Errorf("expected pod name fabrik-run-abc123-pod-xyz, got %s", run.PodName)
	}
	if run.Progress.Finished != 2 || run.Progress.Total != 5 {
		t.Errorf("expected progress 2/5, got %d/%d", run.Progress.Finished, run.Progress.Total)
	}
}

func TestShowReturnsErrorForMissingRun(t *testing.T) {
	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\nexit 1\n"

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	client := &K8sClient{Namespace: "fabrik-runs"}
	_, err := client.Show(context.Background(), "NONEXISTENT")
	if err == nil {
		t.Fatal("expected error for missing run")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' error, got %v", err)
	}
}

func TestLogsReturnsPodLogs(t *testing.T) {
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
					"name": "logs-pod-1",
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
	*"logs"*"logs-pod-1"*)
		printf 'log line 1\nlog line 2\nlog line 3\n'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	client := &K8sClient{Namespace: "fabrik-runs"}
	logs, err := client.Logs(context.Background(), "01JK7V8XLOGS1234567890123", 100, false)
	if err != nil {
		t.Fatalf("Logs failed: %v", err)
	}

	expected := "log line 1\nlog line 2\nlog line 3"
	if !strings.Contains(logs, expected) {
		t.Errorf("expected logs to contain %q, got %q", expected, logs)
	}
}

func TestJobStatusFromConditions(t *testing.T) {
	tests := []struct {
		name       string
		active     int
		succeeded  int
		failed     int
		wantStatus string
		wantOutcome string
	}{
		{"active", 1, 0, 0, "active", ""},
		{"succeeded", 0, 1, 0, "succeeded", "succeeded"},
		{"failed", 0, 0, 1, "failed", "failed"},
		{"pending", 0, 0, 0, "pending", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			job := &runJobJSON{
				Metadata: struct {
					Name        string            `json:"name"`
					Namespace   string            `json:"namespace"`
					Labels      map[string]string `json:"labels"`
					Annotations map[string]string `json:"annotations"`
				}{
					Name:      "test-job",
					Namespace: "fabrik-runs",
					Labels:    map[string]string{"fabrik.sh/run-id": "test"},
				},
				Status: struct {
					Active    int `json:"active"`
					Succeeded int `json:"succeeded"`
					Failed    int `json:"failed"`
					StartTime string `json:"startTime"`
					CompletionTime string `json:"completionTime"`
				}{
					Active:    tt.active,
					Succeeded: tt.succeeded,
					Failed:    tt.failed,
				},
			}

			client := &K8sClient{}
			run := client.jobToRunInfo(job)

			if run.Status != tt.wantStatus {
				t.Errorf("expected status %q, got %q", tt.wantStatus, run.Status)
			}
			if run.Outcome != tt.wantOutcome {
				t.Errorf("expected outcome %q, got %q", tt.wantOutcome, run.Outcome)
			}
		})
	}
}

func TestParseStatusAnnotation(t *testing.T) {
	job := &runJobJSON{
		Metadata: struct {
			Name        string            `json:"name"`
			Namespace   string            `json:"namespace"`
			Labels      map[string]string `json:"labels"`
			Annotations map[string]string `json:"annotations"`
		}{
			Name:      "test-job",
			Namespace: "fabrik-runs",
			Labels: map[string]string{
				"fabrik.sh/run-id":  "test",
				"fabrik.sh/project": "myproj",
				"fabrik.sh/spec":    "spec-1",
			},
			Annotations: map[string]string{
				"fabrik.sh/status":   `{"phase":"review","current_task":"validate","attempt":2,"progress":{"finished":8,"total":10}}`,
				"fabrik.sh/progress": `{"finished":5,"total":10}`,
			},
		},
		Spec: struct {
			Template struct {
				Spec struct {
					Containers []struct {
						Image string `json:"image"`
					} `json:"containers"`
				} `json:"spec"`
			} `json:"template"`
		}{},
		Status: struct {
			Active    int `json:"active"`
			Succeeded int `json:"succeeded"`
			Failed    int `json:"failed"`
			StartTime string `json:"startTime"`
			CompletionTime string `json:"completionTime"`
		}{
			Active: 1,
		},
	}

	client := &K8sClient{}
	run := client.jobToRunInfo(job)

	// Status annotation should take precedence over progress annotation
	if run.Phase != "review" {
		t.Errorf("expected phase review from status annotation, got %s", run.Phase)
	}
	if run.Task != "validate" {
		t.Errorf("expected task validate from status annotation, got %s", run.Task)
	}
	// Progress from status annotation
	if run.Progress.Finished != 8 || run.Progress.Total != 10 {
		t.Errorf("expected progress 8/10 from status annotation, got %d/%d", run.Progress.Finished, run.Progress.Total)
	}
}

func TestChildJobDetection(t *testing.T) {
	// Child jobs from CronJobs have names containing run-id but may not have the label set
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-cron-01JK7V8XCRON123-1741800000",
					"namespace": "fabrik-runs",
					"labels": {
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
	*"get jobs"*"fabrik.sh/run-id=01JK7V8XCRON123"*)
		printf '{"items":[]}\n'
		exit 0
		;;
	*"get jobs"*)
		printf '%s\n' '` + jobsJSON + `'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	client := &K8sClient{Namespace: "fabrik-runs"}
	childJob, err := client.getChildJobByRunID(context.Background(), "01JK7V8XCRON123")
	if err != nil {
		t.Fatalf("getChildJobByRunID failed: %v", err)
	}

	if childJob == nil {
		t.Fatal("expected child job to be found")
	}

	if !strings.Contains(childJob.Metadata.Name, "01JK7V8XCRON123") {
		t.Errorf("expected child job name to contain run-id, got %s", childJob.Metadata.Name)
	}
}

func TestCancelDeletesJob(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += "echo \"$@\" >> " + kubectlLog + "\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=test-run-123"*)
		printf '{"items":[{"metadata":{"name":"test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"test-run-123"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{"active":1}}]}\n'
		exit 0
		;;
	*"delete job"*)
		printf 'job.batch "test-job" deleted\n'
		exit 0
		;;
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "test-run-123")
	if err != nil {
		t.Fatalf("Cancel failed: %v", err)
	}

	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.RunID != "test-run-123" {
		t.Errorf("expected run-id test-run-123, got %s", result.RunID)
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	logText := string(logData)
	if !strings.Contains(logText, "delete job") {
		t.Errorf("expected kubectl delete job to be called, got: %s", logText)
	}
}

func TestResumeDeletesPod(t *testing.T) {
	// Resume verifies job exists with immutable image, checks PVC, then deletes pod
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=test-resume"; then
		echo '{"items":[{"metadata":{"name":"test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"test-resume","fabrik.sh/managed-by":"fabrik"}},"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/fabrik/smithers@sha256:abc123def456"}]}}},"status":{"active":1}}]}'
		exit 0
	fi
	if echo "$*" | grep -q "get pvc.*data-fabrik-test-resume"; then
		echo 'Bound'
		exit 0
	fi
	if echo "$*" | grep -q "jsonpath={.items\[0\].metadata.name}"; then
		echo 'test-pod'
		exit 0
	fi
	if echo "$*" | grep -q "delete pod test-pod"; then
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	err := client.Resume(context.Background(), "test-resume")
	if err != nil {
		t.Fatalf("Resume failed: %v", err)
	}
}

func TestResumeFailsWithMutableImage(t *testing.T) {
	// Resume should fail if the job uses a mutable image (tag-based)
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=test-mutable"; then
		echo '{"items":[{"metadata":{"name":"test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"test-mutable"}},"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/fabrik/smithers:latest"}]}}},"status":{"active":1}}]}'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	err := client.Resume(context.Background(), "test-mutable")
	if err == nil {
		t.Fatal("expected Resume to fail with mutable image")
	}
	if !strings.Contains(err.Error(), "mutable image reference") {
		t.Errorf("expected 'mutable image reference' error, got %v", err)
	}
}

func TestResumeFailsWhenJobSucceeded(t *testing.T) {
	// Resume should fail if the job has already succeeded
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=test-succeeded"; then
		echo '{"items":[{"metadata":{"name":"test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"test-succeeded"}},"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/fabrik/smithers@sha256:abc123"}]}}},"status":{"succeeded":1}}]}'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	err := client.Resume(context.Background(), "test-succeeded")
	if err == nil {
		t.Fatal("expected Resume to fail when job already succeeded")
	}
	if !strings.Contains(err.Error(), "already succeeded") {
		t.Errorf("expected 'already succeeded' error, got %v", err)
	}
}

func TestResumeFailsWhenPVCMissing(t *testing.T) {
	// Resume should fail if the PVC doesn't exist (state would be lost)
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=test-missing-pvc"; then
		echo '{"items":[{"metadata":{"name":"test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"test-missing-pvc"}},"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/fabrik/smithers@sha256:abc123"}]}}},"status":{"active":1}}]}'
		exit 0
	fi
	if echo "$*" | grep -q "get pvc.*data-fabrik-test-missing-pvc"; then
		echo 'Error from server (NotFound): persistentvolumeclaims "data-fabrik-test-missing-pvc" not found' >&2
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	err := client.Resume(context.Background(), "test-missing-pvc")
	if err == nil {
		t.Fatal("expected Resume to fail when PVC missing")
	}
	if !strings.Contains(err.Error(), "PVC") {
		t.Errorf("expected PVC error, got %v", err)
	}
}

func TestResumeFailsWhenPVCPending(t *testing.T) {
	// Resume should fail if the PVC is not Bound
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=test-pending-pvc"; then
		echo '{"items":[{"metadata":{"name":"test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"test-pending-pvc"}},"spec":{"template":{"spec":{"containers":[{"image":"ghcr.io/fabrik/smithers@sha256:abc123"}]}}},"status":{"active":1}}]}'
		exit 0
	fi
	if echo "$*" | grep -q "get pvc.*data-fabrik-test-pending-pvc"; then
		echo 'Pending'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	err := client.Resume(context.Background(), "test-pending-pvc")
	if err == nil {
		t.Fatal("expected Resume to fail when PVC not Bound")
	}
	if !strings.Contains(err.Error(), "not Bound") {
		t.Errorf("expected 'not Bound' error, got %v", err)
	}
}

func TestResumeFailsWhenJobNotFound(t *testing.T) {
	// Resume should fail when job doesn't exist
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=test-no-job"; then
	echo '{"items":[]}'
	exit 0
	fi
	if echo "$*" | grep -q "get cronjobs.*fabrik.sh/run-id=test-no-job"; then
	echo '{"items":[]}'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	err := client.Resume(context.Background(), "test-no-job")
	if err == nil {
		t.Fatal("expected Resume to fail when job not found")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' error, got %v", err)
	}
}

func TestResumeFailsWithRBACPermissionError(t *testing.T) {
	// Resume should provide clear error when RBAC permissions are missing
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	err := client.Resume(context.Background(), "test-rbac-deny")
	if err == nil {
		t.Fatal("expected Resume to fail with RBAC error")
	}
	// Should mention RBAC/permissions in the error
	if !strings.Contains(err.Error(), "insufficient permissions") && !strings.Contains(err.Error(), "forbidden") {
		t.Errorf("expected error to mention permissions/RBAC, got: %v", err)
	}
	// Should reference the RBAC configuration
	if !strings.Contains(err.Error(), "rbac.yaml") && !strings.Contains(err.Error(), "Role") {
		t.Errorf("expected error to reference RBAC configuration, got: %v", err)
	}
}

func TestKubeContextPassedToKubectl(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += "echo \"$@\" >> " + kubectlLog + "\n"
	script += "printf '{\"items\":[]}\n'\n"
	script += "exit 0\n"

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	client := &K8sClient{
		KubeContext: "my-cluster",
		Namespace:   "fabrik-runs",
	}
	_, _ = client.List(context.Background())

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	logText := string(logData)
	if !strings.Contains(logText, "--context my-cluster") {
		t.Errorf("expected --context my-cluster in kubectl args, got: %s", logText)
	}
}

func TestListHandlesEmptyResults(t *testing.T) {
	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*)
		printf '{"items":[]}\n'
		exit 0
		;;
	*"get cronjobs"*)
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	runs, err := client.List(context.Background())
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}

	if len(runs) != 0 {
		t.Errorf("expected 0 runs, got %d", len(runs))
	}
}

func TestRunInfoJSONSerialization(t *testing.T) {
	started := timeMustParse("2026-03-10T10:00:00Z")
	finished := timeMustParse("2026-03-10T11:00:00Z")
	
	run := RunInfo{
		RunID:      "01JK7V8XTEST1234567890123",
		Project:    "myproj",
		Spec:       "feature",
		Phase:      "complete",
		Status:     "succeeded",
		Task:       "cleanup",
		Image:      "ghcr.io/fabrik/smithers@sha256:abc123",
		Outcome:    "succeeded",
		StartedAt:  &started,
		FinishedAt: &finished,
		Progress:   Progress{Finished: 10, Total: 10},
		PodName:    "pod-123",
		JobName:    "job-123",
		Namespace:  "fabrik-runs",
		Cluster:    "dev",
	}

	data, err := json.Marshal(run)
	if err != nil {
		t.Fatalf("marshal RunInfo: %v", err)
	}

	var decoded RunInfo
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal RunInfo: %v", err)
	}

	if decoded.RunID != run.RunID {
		t.Errorf("expected run_id %s, got %s", run.RunID, decoded.RunID)
	}
	if decoded.Progress.Finished != 10 || decoded.Progress.Total != 10 {
		t.Errorf("expected progress 10/10, got %d/%d", decoded.Progress.Finished, decoded.Progress.Total)
	}
}

func timeMustParse(s string) time.Time {
	t, _ := time.Parse("2006-01-02T15:04:05Z", s)
	return t
}

// Cancel verification tests - ensure spec guarantees are met:
// - cancel deletes the Job or CronJob-owned child run correctly
// - status/output clearly indicates what was cancelled
// - cancellation does not leave ambiguous state

func TestCancelActiveJob(t *testing.T) {
	// Active job (status.active > 0) should be cancelled with WasActive=true
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=active-run-123"; then
	echo '{"items":[{"metadata":{"name":"active-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"active-run-123","fabrik.sh/phase":"implement"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{"active":1}}]}'
	exit 0
fi
if echo "$*" | grep -q "delete job active-job"; then
	echo 'job.batch "active-job" deleted'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "active-run-123")
	if err != nil {
		t.Fatalf("Cancel failed: %v", err)
	}

	if result.RunID != "active-run-123" {
		t.Errorf("expected run-id active-run-123, got %s", result.RunID)
	}
	if result.Resource != "job" {
		t.Errorf("expected resource 'job', got %s", result.Resource)
	}
	if result.Name != "active-job" {
		t.Errorf("expected job name 'active-job', got %s", result.Name)
	}
	if !result.WasActive {
		t.Errorf("expected WasActive=true for active job")
	}
	if result.WasFinished {
		t.Errorf("expected WasFinished=false for active job")
	}
	if result.Status != "active" {
		t.Errorf("expected status 'active', got %s", result.Status)
	}
}

func TestCancelSucceededJob(t *testing.T) {
	// Already-succeeded job should be cleaned up with WasFinished=true
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=succeeded-run-456"; then
	echo '{"items":[{"metadata":{"name":"succeeded-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"succeeded-run-456"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{"succeeded":1}}]}'
	exit 0
fi
if echo "$*" | grep -q "delete job succeeded-job"; then
	echo 'job.batch "succeeded-job" deleted'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "succeeded-run-456")
	if err != nil {
		t.Fatalf("Cancel failed: %v", err)
	}

	if !result.WasFinished {
		t.Errorf("expected WasFinished=true for succeeded job")
	}
	if result.WasActive {
		t.Errorf("expected WasActive=false for succeeded job")
	}
	if result.Status != "succeeded" {
		t.Errorf("expected status 'succeeded', got %s", result.Status)
	}
}

func TestCancelFailedJob(t *testing.T) {
	// Failed job should be cleaned up with WasFinished=true
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=failed-run-789"; then
	echo '{"items":[{"metadata":{"name":"failed-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"failed-run-789"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{"failed":1}}]}'
	exit 0
fi
if echo "$*" | grep -q "delete job failed-job"; then
	echo 'job.batch "failed-job" deleted'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "failed-run-789")
	if err != nil {
		t.Fatalf("Cancel failed: %v", err)
	}

	if !result.WasFinished {
		t.Errorf("expected WasFinished=true for failed job")
	}
	if result.Status != "failed" {
		t.Errorf("expected status 'failed', got %s", result.Status)
	}
}

func TestCancelMissingRun(t *testing.T) {
	// Missing run should return clear error with no ambiguous state
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=missing-run"; then
	echo '{"items":[]}'
	exit 0
fi
if echo "$*" | grep -q "get cronjobs.*fabrik.sh/run-id=missing-run"; then
	echo '{"items":[]}'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "missing-run")
	if err == nil {
		t.Fatal("expected Cancel to fail for missing run")
	}
	if result != nil {
		t.Errorf("expected nil result for missing run, got %+v", result)
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' error, got %v", err)
	}
}

func TestCancelCronJob(t *testing.T) {
	// CronJob should be cancelled with Resource="cronjob"
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=cron-schedule-1"; then
	echo '{"items":[]}'
	exit 0
fi
if echo "$*" | grep -q "get cronjobs.*fabrik.sh/run-id=cron-schedule-1"; then
	echo '{"items":[{"metadata":{"name":"fabrik-cron-daily","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"cron-schedule-1"}},"spec":{"schedule":"0 2 * * *"}}]}'
	exit 0
fi
if echo "$*" | grep -q "delete cronjob fabrik-cron-daily"; then
	echo 'cronjob.batch "fabrik-cron-daily" deleted'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "cron-schedule-1")
	if err != nil {
		t.Fatalf("Cancel failed: %v", err)
	}

	if result.Resource != "cronjob" {
		t.Errorf("expected resource 'cronjob', got %s", result.Resource)
	}
	if result.Name != "fabrik-cron-daily" {
		t.Errorf("expected cronjob name 'fabrik-cron-daily', got %s", result.Name)
	}
	if result.Status != "scheduled" {
		t.Errorf("expected status 'scheduled', got %s", result.Status)
	}
}

func TestCancelCronJobChildJob(t *testing.T) {
	// CronJob-created child job (name contains run-id but no label) should be detected and cancelled
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=child-run-abc123"; then
	echo '{"items":[]}'
	exit 0
fi
if echo "$*" | grep -q "get cronjobs.*fabrik.sh/run-id=child-run-abc123"; then
	echo '{"items":[]}'
	exit 0
fi
if echo "$*" | grep -q "get jobs" && echo "$*" | grep -qv "fabrik.sh/run-id"; then
	# List all jobs to find child job by name
	echo '{"items":[{"metadata":{"name":"fabrik-cron-child-run-abc123-1741800000","namespace":"fabrik-runs","labels":{"fabrik.sh/managed-by":"fabrik"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{"active":1}}]}'
	exit 0
fi
if echo "$*" | grep -q "delete job fabrik-cron-child-run-abc123-1741800000"; then
	echo 'job.batch "fabrik-cron-child-run-abc123-1741800000" deleted'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "child-run-abc123")
	if err != nil {
		t.Fatalf("Cancel failed: %v", err)
	}

	if result.Resource != "child-job" {
		t.Errorf("expected resource 'child-job', got %s", result.Resource)
	}
	if !strings.Contains(result.Name, "child-run-abc123") {
		t.Errorf("expected job name to contain run-id, got %s", result.Name)
	}
	if !result.WasActive {
		t.Errorf("expected WasActive=true for active child job")
	}
}

func TestCancelRBACPermissionDenied(t *testing.T) {
	// RBAC permission error should provide clear guidance
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=rbac-deny-run"; then
	echo '{"items":[{"metadata":{"name":"denied-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"rbac-deny-run"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{"active":1}}]}'
	exit 0
fi
if echo "$*" | grep -q "delete job denied-job"; then
	echo 'Error from server (Forbidden): jobs "denied-job" is forbidden: User "system:serviceaccount:fabrik-runs:test" cannot delete resource "jobs" in API group "batch" in the namespace "fabrik-runs"' >&2
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "rbac-deny-run")
	if err == nil {
		t.Fatal("expected Cancel to fail with RBAC error")
	}
	if result != nil {
		t.Errorf("expected nil result when delete fails, got %+v", result)
	}
	if !strings.Contains(err.Error(), "insufficient permissions") && !strings.Contains(err.Error(), "rbac.yaml") {
		t.Errorf("expected error to mention permissions and rbac.yaml, got: %v", err)
	}
}

func TestCancelPendingJob(t *testing.T) {
	// Pending job (no active/succeeded/failed status) should be cancelled
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=pending-run-xyz"; then
	echo '{"items":[{"metadata":{"name":"pending-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"pending-run-xyz"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{}}]}'
	exit 0
fi
if echo "$*" | grep -q "delete job pending-job"; then
	echo 'job.batch "pending-job" deleted'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "pending-run-xyz")
	if err != nil {
		t.Fatalf("Cancel failed: %v", err)
	}

	if result.WasActive || result.WasFinished {
		t.Errorf("expected neither WasActive nor WasFinished for pending job")
	}
	if result.Status != "pending" {
		t.Errorf("expected status 'pending', got %s", result.Status)
	}
}

func TestCancelResultHasPhaseInfo(t *testing.T) {
	// Cancel result should include phase information from job labels
	script := "#!/bin/sh\n"
	script += `if echo "$*" | grep -q "get jobs.*fabrik.sh/run-id=phase-test-run"; then
	echo '{"items":[{"metadata":{"name":"phase-test-job","namespace":"fabrik-runs","labels":{"fabrik.sh/run-id":"phase-test-run","fabrik.sh/phase":"review","fabrik.sh/project":"myapp"}},"spec":{"template":{"spec":{"containers":[{"image":"test"}]}}},"status":{"active":1}}]}'
	exit 0
fi
if echo "$*" | grep -q "delete job phase-test-job"; then
	echo 'job.batch "phase-test-job" deleted'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.Cancel(context.Background(), "phase-test-run")
	if err != nil {
		t.Fatalf("Cancel failed: %v", err)
	}

	if result.Phase != "review" {
		t.Errorf("expected phase 'review', got %s", result.Phase)
	}
}
