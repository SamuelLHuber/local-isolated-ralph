package run

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// CancelOptions configures the cancel behavior.
type CancelOptions struct {
	Namespace   string
	KubeContext string
	RunID       string
}

// CancelResult describes the outcome of a cancellation.
type CancelResult struct {
	RunID       string `json:"run_id"`
	Kind        string `json:"kind"`        // Job, CronJob, or ChildJob
	Name        string `json:"name"`        // Resource name that was deleted
	Namespace   string `json:"namespace"`
	WasActive   bool   `json:"was_active"`  // true if the resource was active
	WasFinished bool   `json:"was_finished"` // true if the resource was already complete
	Message     string `json:"message"`
}

// CancelRun deletes the Job or CronJob-owned child run for a given run ID.
// It provides clear status about what was cancelled and ensures no ambiguous state remains.
func CancelRun(ctx context.Context, stdout, stderr io.Writer, opts CancelOptions) (*CancelResult, error) {
	if strings.TrimSpace(opts.RunID) == "" {
		return nil, fmt.Errorf("missing required flag: --id")
	}

	// Resolve namespace default
	if strings.TrimSpace(opts.Namespace) == "" {
		opts.Namespace = "fabrik-runs"
	}

	// Try to find and delete as a Job first
	result, err := cancelJob(ctx, opts)
	if err == nil && result != nil {
		printCancelResult(stdout, result)
		return result, nil
	}

	// If not found as a Job, try as a CronJob
	result, err = cancelCronJob(ctx, opts)
	if err == nil && result != nil {
		printCancelResult(stdout, result)
		return result, nil
	}

	// If still not found, try to find a CronJob-owned child Job
	result, err = cancelCronChildJob(ctx, opts)
	if err == nil && result != nil {
		printCancelResult(stdout, result)
		return result, nil
	}

	return nil, fmt.Errorf("run %s not found in namespace %s: no Job or CronJob with label fabrik.sh/run-id=%s", opts.RunID, opts.Namespace, opts.RunID)
}

// cancelJob attempts to cancel a Job-based run.
func cancelJob(ctx context.Context, opts CancelOptions) (*CancelResult, error) {
	jobInfo, err := findJobInfo(ctx, opts)
	if err != nil {
		return nil, err
	}

	// Delete the job
	_, err = kubectlOutput(ctx, opts.KubeContext, "-n", opts.Namespace, "delete", "job", jobInfo.Name, "--ignore-not-found")
	if err != nil {
		return nil, fmt.Errorf("failed to delete job %s: %w", jobInfo.Name, err)
	}

	// Determine the kind based on ownership
	kind := "Job"
	if jobInfo.OwnerCronJob != "" {
		kind = "CronJobChild"
	}

	return &CancelResult{
		RunID:       opts.RunID,
		Kind:        kind,
		Name:        jobInfo.Name,
		Namespace:   opts.Namespace,
		WasActive:   jobInfo.Active,
		WasFinished: jobInfo.Finished,
		Message:     formatCancelMessage(kind, jobInfo.Name, jobInfo.Active, jobInfo.Finished),
	}, nil
}

// cancelCronJob attempts to cancel a CronJob-based run.
func cancelCronJob(ctx context.Context, opts CancelOptions) (*CancelResult, error) {
	cronJobName, active, err := findCronJobStatus(ctx, opts)
	if err != nil {
		return nil, err
	}

	// Delete the cronjob
	_, err = kubectlOutput(ctx, opts.KubeContext, "-n", opts.Namespace, "delete", "cronjob", cronJobName, "--ignore-not-found")
	if err != nil {
		return nil, fmt.Errorf("failed to delete cronjob %s: %w", cronJobName, err)
	}

	// Also delete any active child jobs created by this cronjob
	childJobs, err := findCronChildJobs(ctx, opts, cronJobName)
	if err == nil && len(childJobs) > 0 {
		for _, childJob := range childJobs {
			_, _ = kubectlOutput(ctx, opts.KubeContext, "-n", opts.Namespace, "delete", "job", childJob, "--ignore-not-found")
		}
	}

	return &CancelResult{
		RunID:       opts.RunID,
		Kind:        "CronJob",
		Name:        cronJobName,
		Namespace:   opts.Namespace,
		WasActive:   active,
		WasFinished: false, // CronJobs don't finish, they schedule
		Message:     formatCancelMessage("CronJob", cronJobName, active, false),
	}, nil
}

// cancelCronChildJob attempts to cancel a child Job created by a CronJob.
func cancelCronChildJob(ctx context.Context, opts CancelOptions) (*CancelResult, error) {
	// Look for child jobs with the run-id label that may have been created by a CronJob
	args := []string{"-n", opts.Namespace, "get", "jobs", "-l", "fabrik.sh/run-id=" + opts.RunID, "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		return nil, err
	}

	var jobList struct {
		Items []struct {
			Metadata struct {
				Name              string            `json:"name"`
				Labels            map[string]string `json:"labels"`
				OwnerReferences   []struct {
					Kind string `json:"kind"`
					Name string `json:"name"`
				} `json:"ownerReferences"`
			} `json:"metadata"`
			Status struct {
				Active     int `json:"active"`
				Succeeded  int `json:"succeeded"`
				Failed     int `json:"failed"`
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}

	if err := json.Unmarshal([]byte(out), &jobList); err != nil {
		return nil, fmt.Errorf("parse job list: %w", err)
	}

	if len(jobList.Items) == 0 {
		return nil, fmt.Errorf("no jobs found")
	}

	// Process the first matching job
	job := jobList.Items[0]
	jobName := job.Metadata.Name

	// Check if owned by a CronJob
	var ownerCronJob string
	for _, owner := range job.Metadata.OwnerReferences {
		if owner.Kind == "CronJob" {
			ownerCronJob = owner.Name
			break
		}
	}

	active := job.Status.Active > 0
	finished := job.Status.Succeeded > 0 || job.Status.Failed > 0

	// Check completion condition
	for _, cond := range job.Status.Conditions {
		if cond.Type == "Complete" && cond.Status == "True" {
			finished = true
		}
	}

	// Delete the child job
	_, err = kubectlOutput(ctx, opts.KubeContext, "-n", opts.Namespace, "delete", "job", jobName, "--ignore-not-found")
	if err != nil {
		return nil, fmt.Errorf("failed to delete job %s: %w", jobName, err)
	}

	kind := "ChildJob"
	if ownerCronJob != "" {
		kind = "CronJobChild"
	}

	return &CancelResult{
		RunID:       opts.RunID,
		Kind:        kind,
		Name:        jobName,
		Namespace:   opts.Namespace,
		WasActive:   active,
		WasFinished: finished,
		Message:     formatCancelMessage(kind, jobName, active, finished),
	}, nil
}

// jobInfo holds information about a found Job.
type jobInfo struct {
	Name         string
	Active       bool
	Finished     bool
	OwnerCronJob string // empty if not owned by a CronJob
}

// findJobInfo locates a Job and returns detailed information.
func findJobInfo(ctx context.Context, opts CancelOptions) (*jobInfo, error) {
	args := []string{"-n", opts.Namespace, "get", "job", "-l", "fabrik.sh/run-id=" + opts.RunID, "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		if strings.Contains(err.Error(), "No resources found") {
			return nil, fmt.Errorf("job not found")
		}
		return nil, fmt.Errorf("failed to find job: %w", err)
	}

	var jobList struct {
		Items []struct {
			Metadata struct {
				Name            string `json:"name"`
				OwnerReferences []struct {
					Kind string `json:"kind"`
					Name string `json:"name"`
				} `json:"ownerReferences"`
			} `json:"metadata"`
			Status struct {
				Active     int `json:"active"`
				Succeeded  int `json:"succeeded"`
				Failed     int `json:"failed"`
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}

	if err := json.Unmarshal([]byte(out), &jobList); err != nil {
		return nil, fmt.Errorf("parse job: %w", err)
	}

	if len(jobList.Items) == 0 {
		return nil, fmt.Errorf("job not found")
	}

	job := jobList.Items[0]
	active := job.Status.Active > 0
	finished := job.Status.Succeeded > 0 || job.Status.Failed > 0

	// Check completion condition
	for _, cond := range job.Status.Conditions {
		if cond.Type == "Complete" && cond.Status == "True" {
			finished = true
		}
		if cond.Type == "Failed" && cond.Status == "True" {
			finished = true
		}
	}

	// Check if owned by a CronJob
	var ownerCronJob string
	for _, owner := range job.Metadata.OwnerReferences {
		if owner.Kind == "CronJob" {
			ownerCronJob = owner.Name
			break
		}
	}

	return &jobInfo{
		Name:         job.Metadata.Name,
		Active:       active,
		Finished:     finished,
		OwnerCronJob: ownerCronJob,
	}, nil
}

// findCronJobStatus locates a CronJob and returns its name and whether it has active jobs.
func findCronJobStatus(ctx context.Context, opts CancelOptions) (string, bool, error) {
	args := []string{"-n", opts.Namespace, "get", "cronjob", "-l", "fabrik.sh/run-id=" + opts.RunID, "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		if strings.Contains(err.Error(), "No resources found") {
			return "", false, fmt.Errorf("cronjob not found")
		}
		return "", false, fmt.Errorf("failed to find cronjob: %w", err)
	}

	var cronJobList struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Active []struct {
					Name string `json:"name"`
				} `json:"active"`
			} `json:"status"`
		} `json:"items"`
	}

	if err := json.Unmarshal([]byte(out), &cronJobList); err != nil {
		return "", false, fmt.Errorf("parse cronjob: %w", err)
	}

	if len(cronJobList.Items) == 0 {
		return "", false, fmt.Errorf("cronjob not found")
	}

	cj := cronJobList.Items[0]
	active := len(cj.Status.Active) > 0

	return cj.Metadata.Name, active, nil
}

// findCronChildJobs finds child Jobs created by a CronJob.
func findCronChildJobs(ctx context.Context, opts CancelOptions, cronJobName string) ([]string, error) {
	args := []string{"-n", opts.Namespace, "get", "jobs", "-l", "fabrik.sh/run-id=" + opts.RunID, "-o", "jsonpath={.items[*].metadata.name}"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		return nil, err
	}

	out = strings.TrimSpace(out)
	if out == "" {
		return []string{}, nil
	}

	return strings.Fields(out), nil
}

// formatCancelMessage creates a human-readable cancellation message.
func formatCancelMessage(kind, name string, active, finished bool) string {
	if finished {
		return fmt.Sprintf("%s %s was already finished and has been cleaned up", kind, name)
	}
	if active {
		return fmt.Sprintf("Active %s %s has been cancelled and its pod(s) deleted", kind, name)
	}
	return fmt.Sprintf("%s %s has been deleted", kind, name)
}

// printCancelResult outputs the cancellation result.
func printCancelResult(stdout io.Writer, result *CancelResult) {
	fmt.Fprintf(stdout, "cancelled run %s\n", result.RunID)
	fmt.Fprintf(stdout, "  resource: %s/%s\n", result.Kind, result.Name)
	fmt.Fprintf(stdout, "  namespace: %s\n", result.Namespace)
	fmt.Fprintf(stdout, "  status: %s\n", result.Message)
}
