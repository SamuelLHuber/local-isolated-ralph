package runs

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// K8sClient provides direct Kubernetes API access for run inspection.
// It uses kubectl as the underlying transport to avoid extra dependencies.
type K8sClient struct {
	KubeContext string
	Namespace   string
}

// RunInfo holds the metadata for a single run extracted from K8s resources.
type RunInfo struct {
	RunID        string     `json:"run_id"`
	Project      string     `json:"project"`
	Spec         string     `json:"spec"`
	Phase        string     `json:"phase"`
	Status       string     `json:"status"`
	Task         string     `json:"task"`
	Image        string     `json:"image"`
	Outcome      string     `json:"outcome,omitempty"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
	Progress     Progress   `json:"progress,omitempty"`
	PodName      string     `json:"pod_name,omitempty"`
	JobName      string     `json:"job_name,omitempty"`
	Namespace    string     `json:"namespace"`
	Cluster      string     `json:"cluster,omitempty"`
	IsCronJob    bool       `json:"is_cron_job,omitempty"`
	CronSchedule string     `json:"cron_schedule,omitempty"`
}

// Progress represents the task completion progress.
type Progress struct {
	Finished int `json:"finished"`
	Total    int `json:"total"`
}

// runJobJSON represents the kubectl JSON output for Jobs.
type runJobJSON struct {
	Metadata struct {
		Name        string            `json:"name"`
		Namespace   string            `json:"namespace"`
		Labels      map[string]string `json:"labels"`
		Annotations map[string]string `json:"annotations"`
	} `json:"metadata"`
	Spec struct {
		Template struct {
			Spec struct {
				Containers []struct {
					Image string `json:"image"`
				} `json:"containers"`
			} `json:"spec"`
		} `json:"template"`
	} `json:"spec"`
	Status struct {
		Active    int `json:"active"`
		Succeeded int `json:"succeeded"`
		Failed    int `json:"failed"`
		StartTime string `json:"startTime"`
		CompletionTime string `json:"completionTime"`
	} `json:"status"`
}

// runCronJobJSON represents the kubectl JSON output for CronJobs.
type runCronJobJSON struct {
	Metadata struct {
		Name        string            `json:"name"`
		Namespace   string            `json:"namespace"`
		Labels      map[string]string `json:"labels"`
		Annotations map[string]string `json:"annotations"`
	} `json:"metadata"`
	Spec struct {
		Schedule string `json:"schedule"`
	} `json:"spec"`
}

// runPodJSON represents the kubectl JSON output for Pods.
type runPodJSON struct {
	Metadata struct {
		Name        string            `json:"name"`
		Namespace   string            `json:"namespace"`
		Labels      map[string]string `json:"labels"`
		Annotations map[string]string `json:"annotations"`
	} `json:"metadata"`
	Status struct {
		Phase string `json:"phase"`
		ContainerStatuses []struct {
			ImageID string `json:"imageID"`
		} `json:"containerStatuses"`
	} `json:"status"`
}

// runStatusAnnotation represents the fabrik.sh/status annotation structure.
type runStatusAnnotation struct {
	Phase       string   `json:"phase"`
	CurrentTask string   `json:"current_task"`
	Attempt     int      `json:"attempt"`
	Progress    Progress `json:"progress"`
}

// List returns all Fabrik runs from Jobs and CronJobs in the configured namespace.
func (c *K8sClient) List(ctx context.Context) ([]RunInfo, error) {
	var runs []RunInfo

	// Query Jobs
	jobs, err := c.listJobs(ctx)
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	runs = append(runs, jobs...)

	// Query CronJobs
	cronJobs, err := c.listCronJobs(ctx)
	if err != nil {
		return nil, fmt.Errorf("list cronjobs: %w", err)
	}
	runs = append(runs, cronJobs...)

	return runs, nil
}

// Show returns detailed information for a specific run by ID.
func (c *K8sClient) Show(ctx context.Context, runID string) (*RunInfo, error) {
	// First try to find a Job with the run-id label
	job, err := c.getJobByRunID(ctx, runID)
	if err == nil && job != nil {
		return c.enrichJobInfo(ctx, job)
	}

	// Try CronJob
	cronJob, err := c.getCronJobByRunID(ctx, runID)
	if err == nil && cronJob != nil {
		info := c.cronJobToRunInfo(cronJob)
		return &info, nil
	}

	// Try child jobs of cronjobs (they have the run-id in their name but not label)
	childJob, err := c.getChildJobByRunID(ctx, runID)
	if err == nil && childJob != nil {
		return c.enrichJobInfo(ctx, childJob)
	}

	return nil, fmt.Errorf("run %q not found", runID)
}

// Logs returns the pod logs for a specific run.
func (c *K8sClient) Logs(ctx context.Context, runID string, tail int, follow bool) (string, error) {
	// Find the run first to get the pod name
	info, err := c.Show(ctx, runID)
	if err != nil {
		return "", err
	}

	if info.PodName == "" {
		// Try to find pod by run-id label
		podName, err := c.getPodNameByRunID(ctx, runID)
		if err != nil {
			return "", fmt.Errorf("no pod found for run %q: %w", runID, err)
		}
		info.PodName = podName
	}

	return c.getPodLogs(ctx, info.PodName, tail, follow)
}

func (c *K8sClient) runKubectl(ctx context.Context, args ...string) (string, error) {
	cmdArgs := make([]string, 0, len(args)+2)
	if strings.TrimSpace(c.KubeContext) != "" {
		cmdArgs = append(cmdArgs, "--context", c.KubeContext)
	}
	cmdArgs = append(cmdArgs, args...)

	cmd := exec.CommandContext(ctx, "kubectl", cmdArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(cmdArgs, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func (c *K8sClient) listJobs(ctx context.Context) ([]RunInfo, error) {
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "jobs",
		"-l", "fabrik.sh/managed-by=fabrik",
		"-o", "json")
	if err != nil {
		// If no jobs found, return empty list
		if strings.Contains(err.Error(), "No resources found") {
			return nil, nil
		}
		return nil, err
	}

	var result struct {
		Items []runJobJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, fmt.Errorf("parse jobs: %w", err)
	}

	var runs []RunInfo
	for _, job := range result.Items {
		run := c.jobToRunInfo(&job)
		runs = append(runs, run)
	}

	return runs, nil
}

func (c *K8sClient) listCronJobs(ctx context.Context) ([]RunInfo, error) {
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "cronjobs",
		"-l", "fabrik.sh/managed-by=fabrik",
		"-o", "json")
	if err != nil {
		if strings.Contains(err.Error(), "No resources found") {
			return nil, nil
		}
		return nil, err
	}

	var result struct {
		Items []runCronJobJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, fmt.Errorf("parse cronjobs: %w", err)
	}

	var runs []RunInfo
	for _, cj := range result.Items {
		run := c.cronJobToRunInfo(&cj)
		runs = append(runs, run)
	}

	return runs, nil
}

func (c *K8sClient) getJobByRunID(ctx context.Context, runID string) (*runJobJSON, error) {
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "jobs",
		"-l", "fabrik.sh/run-id="+runID,
		"-o", "json")
	if err != nil {
		return nil, err
	}

	var result struct {
		Items []runJobJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, err
	}

	if len(result.Items) == 0 {
		return nil, fmt.Errorf("job not found")
	}

	return &result.Items[0], nil
}

func (c *K8sClient) getChildJobByRunID(ctx context.Context, runID string) (*runJobJSON, error) {
	// Child jobs from CronJobs have names like "fabrik-cron-<run-id>-<timestamp>"
	// but don't have the run-id label set by default. We look for jobs with names containing the run-id.
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "jobs",
		"-o", "json")
	if err != nil {
		return nil, err
	}

	var result struct {
		Items []runJobJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, err
	}

	for _, job := range result.Items {
		// Check if job name contains the run-id (for cron-created child jobs)
		if strings.Contains(job.Metadata.Name, runID) {
			return &job, nil
		}
	}

	return nil, fmt.Errorf("child job not found")
}

func (c *K8sClient) getCronJobByRunID(ctx context.Context, runID string) (*runCronJobJSON, error) {
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "cronjobs",
		"-l", "fabrik.sh/run-id="+runID,
		"-o", "json")
	if err != nil {
		return nil, err
	}

	var result struct {
		Items []runCronJobJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, err
	}

	if len(result.Items) == 0 {
		return nil, fmt.Errorf("cronjob not found")
	}

	return &result.Items[0], nil
}

func (c *K8sClient) getPodNameByRunID(ctx context.Context, runID string) (string, error) {
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "pods",
		"-l", "fabrik.sh/run-id="+runID,
		"-o", "jsonpath={.items[0].metadata.name}")
	if err != nil {
		return "", err
	}

	podName := strings.TrimSpace(output)
	if podName == "" {
		return "", fmt.Errorf("no pod found")
	}

	return podName, nil
}

func (c *K8sClient) getPodForJob(ctx context.Context, jobName string) (*runPodJSON, error) {
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "pods",
		"-l", "job-name="+jobName,
		"-o", "json")
	if err != nil {
		return nil, err
	}

	var result struct {
		Items []runPodJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, err
	}

	if len(result.Items) == 0 {
		return nil, fmt.Errorf("no pod found for job %s", jobName)
	}

	return &result.Items[0], nil
}

func (c *K8sClient) enrichJobInfo(ctx context.Context, job *runJobJSON) (*RunInfo, error) {
	run := c.jobToRunInfo(job)

	// Try to get pod information for richer data
	pod, err := c.getPodForJob(ctx, job.Metadata.Name)
	if err == nil && pod != nil {
		run.PodName = pod.Metadata.Name
		// If pod is running, use pod phase; otherwise use job status
		if run.Status == "" || run.Status == "unknown" {
			run.Status = strings.ToLower(pod.Status.Phase)
		}
		// Get image digest from container status if available
		if len(pod.Status.ContainerStatuses) > 0 && pod.Status.ContainerStatuses[0].ImageID != "" {
			run.Image = pod.Status.ContainerStatuses[0].ImageID
		}
	}

	return &run, nil
}

func (c *K8sClient) getPodLogs(ctx context.Context, podName string, tail int, follow bool) (string, error) {
	args := []string{"-n", c.Namespace, "logs", podName}
	if tail > 0 {
		args = append(args, fmt.Sprintf("--tail=%d", tail))
	}
	if follow {
		args = append(args, "--follow")
	}

	return c.runKubectl(ctx, args...)
}

func (c *K8sClient) jobToRunInfo(job *runJobJSON) RunInfo {
	labels := job.Metadata.Labels
	if labels == nil {
		labels = make(map[string]string)
	}
	annotations := job.Metadata.Annotations
	if annotations == nil {
		annotations = make(map[string]string)
	}

	run := RunInfo{
		RunID:     labels["fabrik.sh/run-id"],
		Project:   labels["fabrik.sh/project"],
		Spec:      labels["fabrik.sh/spec"],
		Phase:     labels["fabrik.sh/phase"],
		Status:    labels["fabrik.sh/status"],
		Task:      labels["fabrik.sh/task"],
		JobName:   job.Metadata.Name,
		Namespace: job.Metadata.Namespace,
		Cluster:   c.KubeContext,
		IsCronJob: false,
	}

	// Extract image from spec
	if len(job.Spec.Template.Spec.Containers) > 0 {
		run.Image = job.Spec.Template.Spec.Containers[0].Image
	}

	// Parse timestamps
	if job.Status.StartTime != "" {
		if t, err := time.Parse(time.RFC3339, job.Status.StartTime); err == nil {
			run.StartedAt = &t
		}
	}
	if job.Status.CompletionTime != "" {
		if t, err := time.Parse(time.RFC3339, job.Status.CompletionTime); err == nil {
			run.FinishedAt = &t
		}
	}

	// Determine status from job conditions if not in labels
	if run.Status == "" {
		switch {
		case job.Status.Active > 0:
			run.Status = "active"
		case job.Status.Succeeded > 0:
			run.Status = "succeeded"
			run.Outcome = "succeeded"
		case job.Status.Failed > 0:
			run.Status = "failed"
			run.Outcome = "failed"
		default:
			run.Status = "pending"
		}
	}

	// Parse status annotation for progress and task
	if statusJSON := annotations["fabrik.sh/status"]; statusJSON != "" {
		var status runStatusAnnotation
		if err := json.Unmarshal([]byte(statusJSON), &status); err == nil {
			if run.Phase == "" {
				run.Phase = status.Phase
			}
			if run.Task == "" {
				run.Task = status.CurrentTask
			}
			run.Progress = status.Progress
		}
	}

	// Parse progress annotation as fallback
	if progressJSON := annotations["fabrik.sh/progress"]; progressJSON != "" && run.Progress.Total == 0 {
		var progress Progress
		if err := json.Unmarshal([]byte(progressJSON), &progress); err == nil {
			run.Progress = progress
		}
	}

	// Parse outcome annotation
	if outcome := annotations["fabrik.sh/outcome"]; outcome != "" {
		run.Outcome = outcome
	}

	// Parse started-at annotation if not in status
	if run.StartedAt == nil {
		if startedAt := annotations["fabrik.sh/started-at"]; startedAt != "" {
			if t, err := time.Parse(time.RFC3339, startedAt); err == nil {
				run.StartedAt = &t
			}
		}
	}

	// Parse finished-at annotation
	if run.FinishedAt == nil {
		if finishedAt := annotations["fabrik.sh/finished-at"]; finishedAt != "" {
			if t, err := time.Parse(time.RFC3339, finishedAt); err == nil {
				run.FinishedAt = &t
			}
		}
	}

	return run
}

func (c *K8sClient) cronJobToRunInfo(cj *runCronJobJSON) RunInfo {
	labels := cj.Metadata.Labels
	if labels == nil {
		labels = make(map[string]string)
	}
	annotations := cj.Metadata.Annotations
	if annotations == nil {
		annotations = make(map[string]string)
	}

	run := RunInfo{
		RunID:        labels["fabrik.sh/run-id"],
		Project:      labels["fabrik.sh/project"],
		Spec:         labels["fabrik.sh/spec"],
		Phase:        labels["fabrik.sh/phase"],
		Status:       "scheduled",
		Task:         labels["fabrik.sh/task"],
		JobName:      cj.Metadata.Name,
		Namespace:    cj.Metadata.Namespace,
		Cluster:      c.KubeContext,
		IsCronJob:    true,
		CronSchedule: cj.Spec.Schedule,
	}

	// Override schedule from annotation if present
	if schedule := annotations["fabrik.sh/cron-schedule"]; schedule != "" {
		run.CronSchedule = schedule
	}

	// Parse status annotation
	if statusJSON := annotations["fabrik.sh/status"]; statusJSON != "" {
		var status runStatusAnnotation
		if err := json.Unmarshal([]byte(statusJSON), &status); err == nil {
			if run.Phase == "" {
				run.Phase = status.Phase
			}
			run.Progress = status.Progress
		}
	}

	return run
}

// Cancel deletes a run by deleting its Job or CronJob.
func (c *K8sClient) Cancel(ctx context.Context, runID string) error {
	// Try to find and delete Job first
	_, err := c.getJobByRunID(ctx, runID)
	if err == nil {
		_, err = c.runKubectl(ctx, "-n", c.Namespace, "delete", "job",
			"-l", "fabrik.sh/run-id="+runID,
			"--ignore-not-found")
		return err
	}

	// Try CronJob
	_, err = c.getCronJobByRunID(ctx, runID)
	if err == nil {
		_, err = c.runKubectl(ctx, "-n", c.Namespace, "delete", "cronjob",
			"-l", "fabrik.sh/run-id="+runID,
			"--ignore-not-found")
		return err
	}

	return fmt.Errorf("run %q not found", runID)
}

// sanitizeName converts a value to a DNS-safe lowercase name.
func sanitizeName(value string) string {
	value = strings.ToLower(value)
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteRune('-')
			lastDash = true
		}
	}

	result := strings.Trim(b.String(), "-")
	if result == "" {
		return "run"
	}

	return result
}

// trimK8sName ensures a name fits within Kubernetes 63-character limit.
func trimK8sName(value string) string {
	value = sanitizeName(value)
	if len(value) > 63 {
		value = value[:63]
	}
	return strings.Trim(value, "-")
}

// Resume deletes the pod for a run to trigger job recreation.
// Guarantees:
//   - Uses the same image digest as the original run (immutable image check)
//   - Preserves the PVC and Smithers DB state
//   - Deletes only the pod, letting the Job controller recreate it natively
//   - Does not mutate the execution model (image, command, env remain unchanged)
func (c *K8sClient) Resume(ctx context.Context, runID string) error {
	// Find the job to verify it exists and check its state
	job, err := c.getJobByRunID(ctx, runID)
	if err != nil {
		return fmt.Errorf("cannot resume: job not found for run %q: %w", runID, err)
	}

	// Verify this is not a CronJob (CronJobs are templates, not runnable workloads)
	if job == nil {
		// Try to check if it's a cronjob
		_, err := c.getCronJobByRunID(ctx, runID)
		if err == nil {
			return fmt.Errorf("cannot resume a CronJob directly; resume individual job executions instead")
		}
		return fmt.Errorf("run %q not found", runID)
	}

	// Verify immutable image reference
	if len(job.Spec.Template.Spec.Containers) == 0 {
		return fmt.Errorf("cannot resume: job %s has no containers", job.Metadata.Name)
	}
	image := job.Spec.Template.Spec.Containers[0].Image
	if !isImmutableImageRef(image) {
		return fmt.Errorf("cannot resume: job %s uses mutable image reference %q (must use digest: repo/image@sha256:<digest>)", job.Metadata.Name, image)
	}

	// Verify job is still active (not completed or failed)
	// Completed jobs should not be resumed - they're done
	if job.Status.Succeeded > 0 {
		return fmt.Errorf("cannot resume: job %s has already succeeded (status: succeeded)", job.Metadata.Name)
	}

	// Verify PVC exists - resume requires the PVC to preserve state
	pvcName := trimK8sName("data-fabrik-" + sanitizeName(runID))
	if err := c.verifyPVCExists(ctx, pvcName); err != nil {
		return fmt.Errorf("cannot resume: %w", err)
	}

	// Find pod and delete it - Job controller will recreate with same spec
	podName, err := c.getPodNameByRunID(ctx, runID)
	if err != nil {
		// Check if job is active but pod is not yet created
		if job.Status.Active > 0 {
			return fmt.Errorf("cannot resume: job %s is active but no pod found (may be starting up)", job.Metadata.Name)
		}
		return fmt.Errorf("cannot resume: no active pod for run %q", runID)
	}

	// Delete the pod - the Job controller will recreate it with the same spec
	// including the same immutable image and PVC mount
	_, err = c.runKubectl(ctx, "-n", c.Namespace, "delete", "pod", podName, "--ignore-not-found")
	if err != nil {
		// Check for RBAC permission errors and provide helpful guidance
		if isRBACPermissionError(err) {
			return fmt.Errorf("cannot resume: insufficient permissions to delete pod %s. "+
				"Ensure your service account has 'pods/delete' permission in namespace %s. "+
				"See k8s/rbac.yaml for the required Role and RoleBinding: %w", podName, c.Namespace, err)
		}
		return fmt.Errorf("failed to delete pod %s for resume: %w", podName, err)
	}

	return nil
}

// isImmutableImageRef checks if an image reference uses a digest (immutable)
func isImmutableImageRef(image string) bool {
	return strings.Contains(image, "@sha256:")
}

// isRBACPermissionError detects if an error is due to insufficient RBAC permissions
func isRBACPermissionError(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	return strings.Contains(errStr, "forbidden") ||
		strings.Contains(errStr, "cannot delete resource") ||
		strings.Contains(errStr, "user \"system:serviceaccount")
}

// verifyPVCExists checks that the PVC exists and is bound
func (c *K8sClient) verifyPVCExists(ctx context.Context, pvcName string) error {
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "pvc", pvcName, "-o", "jsonpath={.status.phase}")
	if err != nil {
		return fmt.Errorf("PVC %s not found: %w", pvcName, err)
	}

	phase := strings.TrimSpace(output)
	if phase != "Bound" {
		return fmt.Errorf("PVC %s is not Bound (phase: %s)", pvcName, phase)
	}

	return nil
}
