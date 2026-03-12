package runs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestListPVCsReturnsFabrikPVCs(t *testing.T) {
	pvcJSON := `{
		"items": [
			{
				"metadata": {
					"name": "data-fabrik-01abc",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/managed-by": "fabrik",
						"fabrik.sh/run-id": "01ABC"
					},
					"creationTimestamp": "2026-03-01T10:00:00Z",
					"ownerReferences": [
						{
							"apiVersion": "batch/v1",
							"kind": "Job",
							"name": "fabrik-01abc",
							"uid": "job-uid-123"
						}
					]
				},
				"spec": {
					"storageClassName": "local-path",
					"resources": {
						"requests": {
							"storage": "10Gi"
						}
					}
				},
				"status": {
					"phase": "Bound"
				}
			}
		]
	}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get pvc"*"fabrik.sh/managed-by=fabrik"*)
		printf '%s\n' '` + pvcJSON + `'
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
	pvcs, err := client.ListPVCs(context.Background())
	if err != nil {
		t.Fatalf("ListPVCs failed: %v", err)
	}

	if len(pvcs) != 1 {
		t.Fatalf("expected 1 PVC, got %d", len(pvcs))
	}

	pvc := pvcs[0]
	if pvc.Name != "data-fabrik-01abc" {
		t.Errorf("expected PVC name data-fabrik-01abc, got %s", pvc.Name)
	}
	if !pvc.IsBound {
		t.Errorf("expected PVC to be bound")
	}
	if len(pvc.OwnerReferences) != 1 {
		t.Errorf("expected 1 owner reference, got %d", len(pvc.OwnerReferences))
	}
	if pvc.OwnerReferences[0].Kind != "Job" {
		t.Errorf("expected owner kind Job, got %s", pvc.OwnerReferences[0].Kind)
	}
}

func TestListOrphanedPVCsExcludesPVCsWithActiveJobOwner(t *testing.T) {
	// PVC with active job owner
	pvcJSON := `{
		"items": [
			{
				"metadata": {
					"name": "data-fabrik-active",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/managed-by": "fabrik",
						"fabrik.sh/run-id": "ACTIVE"
					},
					"creationTimestamp": "2026-03-01T10:00:00Z",
					"ownerReferences": [
						{
							"apiVersion": "batch/v1",
							"kind": "Job",
							"name": "fabrik-active",
							"uid": "job-uid-active"
						}
					]
				},
				"spec": {
					"storageClassName": "local-path",
					"resources": {
						"requests": {
							"storage": "10Gi"
						}
					}
				},
				"status": {
					"phase": "Bound"
				}
			},
			{
				"metadata": {
					"name": "data-fabrik-orphan",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/managed-by": "fabrik",
						"fabrik.sh/run-id": "ORPHAN"
					},
					"creationTimestamp": "2026-03-01T10:00:00Z",
					"ownerReferences": [
						{
							"apiVersion": "batch/v1",
							"kind": "Job",
							"name": "fabrik-orphan-job",
							"uid": "job-uid-orphan"
						}
					]
				},
				"spec": {
					"storageClassName": "local-path",
					"resources": {
						"requests": {
							"storage": "10Gi"
						}
					}
				},
				"status": {
					"phase": "Bound"
				}
			}
		]
	}`

	// Active job (the one that owns data-fabrik-active)
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-active",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/managed-by": "fabrik",
						"fabrik.sh/run-id": "ACTIVE"
					}
				},
				"spec": {
					"template": {
						"spec": {
							"containers": [{"image": "test"}]
						}
					}
				},
				"status": {
					"active": 1
				}
			}
		]
	}`

	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get pvc"*"fabrik.sh/managed-by=fabrik"*)
		printf '%s\n' '` + pvcJSON + `'
		exit 0
		;;
	*"get jobs"*"fabrik.sh/managed-by=fabrik"*)
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
	orphaned, err := client.ListOrphanedPVCs(context.Background())
	if err != nil {
		t.Fatalf("ListOrphanedPVCs failed: %v", err)
	}

	// Should only return the orphan PVC
	if len(orphaned) != 1 {
		t.Fatalf("expected 1 orphaned PVC, got %d", len(orphaned))
	}

	if orphaned[0].Name != "data-fabrik-orphan" {
		t.Errorf("expected orphaned PVC data-fabrik-orphan, got %s", orphaned[0].Name)
	}
}

func TestCleanupOrphanedPVCsDeletesUnboundPVCs(t *testing.T) {
	pvcJSON := `{
		"items": [
			{
				"metadata": {
					"name": "data-fabrik-orphan1",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/managed-by": "fabrik"
					},
					"creationTimestamp": "2026-03-01T10:00:00Z"
				},
				"spec": {
					"storageClassName": "local-path",
					"resources": {
						"requests": {
							"storage": "10Gi"
						}
					}
				},
				"status": {
					"phase": "Released"
				}
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.CleanupOrphanedPVCs(context.Background(), false)
	if err != nil {
		t.Fatalf("CleanupOrphanedPVCs failed: %v", err)
	}

	if result.Total != 1 {
		t.Errorf("expected 1 PVC to cleanup, got %d", result.Total)
	}
	if len(result.Deleted) != 1 {
		t.Errorf("expected 1 PVC deleted, got %d", len(result.Deleted))
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	if !strings.Contains(string(logData), "delete pvc") {
		t.Errorf("expected kubectl delete pvc to be called")
	}
}

func TestCleanupOrphanedPVCsDryRunDoesNotDelete(t *testing.T) {
	pvcJSON := `{
		"items": [
			{
				"metadata": {
					"name": "data-fabrik-orphan1",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/managed-by": "fabrik"
					},
					"creationTimestamp": "2026-03-01T10:00:00Z"
				},
				"spec": {
					"storageClassName": "local-path"
				},
				"status": {
					"phase": "Released"
				}
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
esac
exit 1
`

	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write mock kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	client := &K8sClient{Namespace: "fabrik-runs"}
	result, err := client.CleanupOrphanedPVCs(context.Background(), true)
	if err != nil {
		t.Fatalf("CleanupOrphanedPVCs dry-run failed: %v", err)
	}

	if result.Total != 1 {
		t.Errorf("expected 1 PVC found, got %d", result.Total)
	}
	if len(result.Skipped) != 1 {
		t.Errorf("expected 1 PVC skipped in dry-run, got %d", len(result.Skipped))
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	// Should not call delete in dry-run mode
	if strings.Contains(string(logData), "delete pvc") {
		t.Errorf("expected no kubectl delete pvc in dry-run mode")
	}
}

func TestCleanupRunsDeletesFinishedRuns(t *testing.T) {
	// Job that finished 8 days ago
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-old-finished",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01OLD",
						"fabrik.sh/project": "myapp",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {
					"template": {
						"spec": {
							"containers": [{"image": "test"}]
						}
					}
				},
				"status": {
					"succeeded": 1,
					"completionTime": "` + time.Now().UTC().Add(-8*24*time.Hour).Format(time.RFC3339) + `"
				}
			},
			{
				"metadata": {
					"name": "fabrik-recent",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01RECENT",
						"fabrik.sh/project": "myapp",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {
					"template": {
						"spec": {
							"containers": [{"image": "test"}]
						}
					}
				},
				"status": {
					"succeeded": 1,
					"completionTime": "` + time.Now().UTC().Add(-1*time.Hour).Format(time.RFC3339) + `"
				}
			}
		]
	}`

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
		printf '{"items":[]}'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	opts := CleanupOptions{
		OlderThan: 7 * 24 * time.Hour,
		Status:    "finished",
	}
	result, err := client.CleanupRuns(context.Background(), opts)
	if err != nil {
		t.Fatalf("CleanupRuns failed: %v", err)
	}

	// Only the old finished job should be selected
	if result.Total != 1 {
		t.Errorf("expected 1 run to cleanup (older than 7d), got %d", result.Total)
	}
	if len(result.Deleted) != 1 {
		t.Errorf("expected 1 run deleted, got %d", len(result.Deleted))
	}
}

func TestCleanupRunsFiltersByProject(t *testing.T) {
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-proj-a",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01A",
						"fabrik.sh/project": "project-a",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {"template": {"spec": {"containers": [{"image": "test"}]}}},
				"status": {"succeeded": 1, "completionTime": "` + time.Now().UTC().Add(-8*24*time.Hour).Format(time.RFC3339) + `"}
			},
			{
				"metadata": {
					"name": "fabrik-proj-b",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01B",
						"fabrik.sh/project": "project-b",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {"template": {"spec": {"containers": [{"image": "test"}]}}},
				"status": {"succeeded": 1, "completionTime": "` + time.Now().UTC().Add(-8*24*time.Hour).Format(time.RFC3339) + `"}
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
	*"get cronjobs"*)
		printf '{"items":[]}'
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

	client := &K8sClient{Namespace: "fabrik-runs"}
	opts := CleanupOptions{
		OlderThan: 7 * 24 * time.Hour,
		Status:    "finished",
		Project:   "project-a",
	}
	result, err := client.CleanupRuns(context.Background(), opts)
	if err != nil {
		t.Fatalf("CleanupRuns failed: %v", err)
	}

	if result.Total != 1 {
		t.Errorf("expected 1 run (project-a only), got %d", result.Total)
	}
}

func TestRetainUpdatesJobTTL(t *testing.T) {
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

	pvcJSON := `{
		"items": [
			{
				"metadata": {
					"name": "data-fabrik-01retain",
					"namespace": "fabrik-runs",
					"labels": {"fabrik.sh/managed-by": "fabrik"}
				},
				"spec": {},
				"status": {"phase": "Bound"}
			}
		]
	}`

	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += "echo \"$@\" >> " + kubectlLog + "\n"
	script += `case "$*" in
	*"get jobs"*"fabrik.sh/run-id=01RETAIN"*)
		printf '%s\n' '` + jobJSON + `'
		exit 0
		;;
	*"get pvc"*"data-fabrik-01retain"*)
		printf '%s\n' '` + pvcJSON + `'
		exit 0
		;;
	*"patch job"*"ttlSecondsAfterFinished"*)
		printf 'job patched\n'
		exit 0
		;;
	*"patch pvc"*"ownerReferences"*)
		printf 'pvc patched\n'
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
	result, err := client.Retain(context.Background(), "01RETAIN", 30)
	if err != nil {
		t.Fatalf("Retain failed: %v", err)
	}

	if result.RunID != "01RETAIN" {
		t.Errorf("expected run-id 01RETAIN, got %s", result.RunID)
	}
	if result.NewTTL != 30*24*time.Hour {
		t.Errorf("expected 30 day TTL, got %v", result.NewTTL)
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	if !strings.Contains(string(logData), "patch job") {
		t.Errorf("expected kubectl patch job to be called")
	}
}

func TestRetainRequiresPositiveDays(t *testing.T) {
	client := &K8sClient{Namespace: "fabrik-runs"}
	_, err := client.Retain(context.Background(), "01TEST", 0)
	if err == nil {
		t.Fatal("expected Retain to fail with 0 days")
	}
	if !strings.Contains(err.Error(), "positive") {
		t.Errorf("expected error to mention 'positive', got %v", err)
	}

	_, err = client.Retain(context.Background(), "01TEST", -5)
	if err == nil {
		t.Fatal("expected Retain to fail with negative days")
	}
}

func TestRetainFailsForMissingJob(t *testing.T) {
	dir := t.TempDir()
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n"
	script += `case "$*" in
	*"get jobs"*)
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
	_, err := client.Retain(context.Background(), "01MISSING", 30)
	if err == nil {
		t.Fatal("expected Retain to fail for missing job")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' error, got %v", err)
	}
}

func TestCleanupRunsDryRun(t *testing.T) {
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-old",
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
		printf '{"items":[]}'
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
	opts := CleanupOptions{
		OlderThan: 7 * 24 * time.Hour,
		Status:    "finished",
		DryRun:    true,
	}
	result, err := client.CleanupRuns(context.Background(), opts)
	if err != nil {
		t.Fatalf("CleanupRuns dry-run failed: %v", err)
	}

	if result.Total != 1 {
		t.Errorf("expected 1 run found, got %d", result.Total)
	}
	if len(result.Skipped) != 1 {
		t.Errorf("expected 1 run skipped in dry-run, got %d", len(result.Skipped))
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

func TestCleanupRunsFiltersByStatus(t *testing.T) {
	jobsJSON := `{
		"items": [
			{
				"metadata": {
					"name": "fabrik-succeeded",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01SUCCESS",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {"template": {"spec": {"containers": [{"image": "test"}]}}},
				"status": {"succeeded": 1, "completionTime": "` + time.Now().UTC().Add(-8*24*time.Hour).Format(time.RFC3339) + `"}
			},
			{
				"metadata": {
					"name": "fabrik-failed",
					"namespace": "fabrik-runs",
					"labels": {
						"fabrik.sh/run-id": "01FAILED",
						"fabrik.sh/managed-by": "fabrik"
					}
				},
				"spec": {"template": {"spec": {"containers": [{"image": "test"}]}}},
				"status": {"failed": 1, "completionTime": "` + time.Now().UTC().Add(-8*24*time.Hour).Format(time.RFC3339) + `"}
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
	*"get cronjobs"*)
		printf '{"items":[]}'
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

	client := &K8sClient{Namespace: "fabrik-runs"}

	// Test cleanup of succeeded jobs only
	opts := CleanupOptions{
		OlderThan: 7 * 24 * time.Hour,
		Status:    "succeeded",
	}
	result, err := client.CleanupRuns(context.Background(), opts)
	if err != nil {
		t.Fatalf("CleanupRuns failed: %v", err)
	}

	if result.Total != 1 {
		t.Errorf("expected 1 succeeded run, got %d", result.Total)
	}

	// Test cleanup of failed jobs only
	opts.Status = "failed"
	result, err = client.CleanupRuns(context.Background(), opts)
	if err != nil {
		t.Fatalf("CleanupRuns failed: %v", err)
	}

	if result.Total != 1 {
		t.Errorf("expected 1 failed run, got %d", result.Total)
	}

	// Test cleanup of all finished jobs
	opts.Status = "finished"
	result, err = client.CleanupRuns(context.Background(), opts)
	if err != nil {
		t.Fatalf("CleanupRuns failed: %v", err)
	}

	if result.Total != 2 {
		t.Errorf("expected 2 finished runs (both succeeded and failed), got %d", result.Total)
	}
}
