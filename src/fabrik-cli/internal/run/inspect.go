package run

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// RunInfo holds the metadata for a single run extracted from K8s resources.
type RunInfo struct {
	RunID       string    `json:"run_id"`
	Project     string    `json:"project"`
	Spec        string    `json:"spec"`
	Phase       string    `json:"phase"`
	Status      string    `json:"status"`
	Task        string    `json:"task"`
	Outcome     string    `json:"outcome"`
	StartedAt   time.Time `json:"started_at"`
	FinishedAt  time.Time `json:"finished_at,omitempty"`
	Image       string    `json:"image"`
	Namespace   string    `json:"namespace"`
	Kind        string    `json:"kind"` // Job or CronJob
	JobName     string    `json:"job_name,omitempty"`
	CronJobName string    `json:"cronjob_name,omitempty"`
	PodName     string    `json:"pod_name,omitempty"`
	Progress    Progress  `json:"progress"`
	Age         string    `json:"age"`
}

// Progress holds task progress information.
type Progress struct {
	Finished int `json:"finished"`
	Total    int `json:"total"`
}

// RunStatus holds detailed status for a specific run.
type RunStatus struct {
	RunInfo
	Attempts       int               `json:"attempts"`
	Conditions     []JobCondition    `json:"conditions,omitempty"`
	Pods           []PodInfo         `json:"pods,omitempty"`
	Annotations    map[string]string `json:"annotations,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
}

// JobCondition represents a Job status condition.
type JobCondition struct {
	Type               string    `json:"type"`
	Status             string    `json:"status"`
	LastProbeTime      time.Time `json:"last_probe_time,omitempty"`
	LastTransitionTime time.Time `json:"last_transition_time,omitempty"`
	Reason             string    `json:"reason,omitempty"`
	Message            string    `json:"message,omitempty"`
}

// PodInfo holds information about a pod associated with a run.
type PodInfo struct {
	Name       string            `json:"name"`
	Phase      string            `json:"phase"`
	StartTime  time.Time         `json:"start_time,omitempty"`
	ExitCode   int               `json:"exit_code,omitempty"`
	Reason     string            `json:"reason,omitempty"`
	Message    string            `json:"message,omitempty"`
	Containers []ContainerStatus `json:"containers,omitempty"`
}

// ContainerStatus holds container-level status.
type ContainerStatus struct {
	Name      string `json:"name"`
	Ready     bool   `json:"ready"`
	Restarted int    `json:"restarted"`
	ExitCode  int    `json:"exit_code,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// InspectOptions configures run inspection behavior.
type InspectOptions struct {
	Namespace   string
	KubeContext string
	RunID       string
	All         bool
}

// ListRuns queries K8s for all Fabrik runs across Jobs and CronJobs.
func ListRuns(ctx context.Context, stdout io.Writer, opts InspectOptions) error {
	runs, err := fetchRuns(ctx, opts)
	if err != nil {
		return err
	}

	if len(runs) == 0 {
		_, err := fmt.Fprintln(stdout, "no runs found")
		return err
	}

	// Header
	_, err = fmt.Fprintf(stdout, "%-26s %-12s %-10s %-12s %-8s %s\n", "RUN ID", "PROJECT", "PHASE", "STATUS", "AGE", "KIND")
	if err != nil {
		return err
	}

	for _, run := range runs {
		_, err := fmt.Fprintf(stdout, "%-26s %-12s %-10s %-12s %-8s %s\n",
			run.RunID,
			truncate(run.Project, 12),
			run.Phase,
			run.Status,
			run.Age,
			run.Kind,
		)
		if err != nil {
			return err
		}
	}

	return nil
}

// ShowRun returns detailed information about a specific run.
func ShowRun(ctx context.Context, stdout io.Writer, opts InspectOptions) error {
	if strings.TrimSpace(opts.RunID) == "" {
		return fmt.Errorf("missing required flag: --id")
	}

	status, err := fetchRunStatus(ctx, opts)
	if err != nil {
		return err
	}

	// Print main run information
	fmt.Fprintf(stdout, "Run ID:       %s\n", status.RunID)
	fmt.Fprintf(stdout, "Project:      %s\n", status.Project)
	fmt.Fprintf(stdout, "Spec:         %s\n", status.Spec)
	fmt.Fprintf(stdout, "Namespace:    %s\n", status.Namespace)
	fmt.Fprintf(stdout, "Kind:         %s\n", status.Kind)
	fmt.Fprintf(stdout, "\n")

	fmt.Fprintf(stdout, "Phase:        %s\n", status.Phase)
	fmt.Fprintf(stdout, "Status:       %s\n", status.Status)
	fmt.Fprintf(stdout, "Task:         %s\n", status.Task)
	fmt.Fprintf(stdout, "Outcome:      %s\n", status.Outcome)
	fmt.Fprintf(stdout, "Progress:     %d/%d\n", status.Progress.Finished, status.Progress.Total)
	fmt.Fprintf(stdout, "\n")

	fmt.Fprintf(stdout, "Started:      %s\n", formatTime(status.StartedAt))
	if !status.FinishedAt.IsZero() {
		fmt.Fprintf(stdout, "Finished:     %s\n", formatTime(status.FinishedAt))
		duration := status.FinishedAt.Sub(status.StartedAt)
		fmt.Fprintf(stdout, "Duration:     %s\n", formatDuration(duration))
	}
	fmt.Fprintf(stdout, "\n")

	if status.Image != "" {
		fmt.Fprintf(stdout, "Image:        %s\n", status.Image)
	}
	if status.JobName != "" {
		fmt.Fprintf(stdout, "Job:          %s\n", status.JobName)
	}
	if status.CronJobName != "" {
		fmt.Fprintf(stdout, "CronJob:      %s\n", status.CronJobName)
	}
	if status.PodName != "" {
		fmt.Fprintf(stdout, "Pod:          %s\n", status.PodName)
	}

	// Print conditions if available
	if len(status.Conditions) > 0 {
		fmt.Fprintf(stdout, "\nConditions:\n")
		for _, cond := range status.Conditions {
			fmt.Fprintf(stdout, "  - %s: %s", cond.Type, cond.Status)
			if cond.Reason != "" {
				fmt.Fprintf(stdout, " (%s)", cond.Reason)
			}
			if cond.Message != "" {
				fmt.Fprintf(stdout, " - %s", cond.Message)
			}
			fmt.Fprintln(stdout)
		}
	}

	// Print pod information if available
	if len(status.Pods) > 0 {
		fmt.Fprintf(stdout, "\nPods:\n")
		for _, pod := range status.Pods {
			fmt.Fprintf(stdout, "  - %s: %s", pod.Name, pod.Phase)
			if pod.ExitCode != 0 {
				fmt.Fprintf(stdout, " (exit: %d)", pod.ExitCode)
			}
			if pod.Reason != "" {
				fmt.Fprintf(stdout, " - %s", pod.Reason)
			}
			fmt.Fprintln(stdout)
		}
	}

	return nil
}

// RunLogs returns the pod logs for a specific run.
func RunLogs(ctx context.Context, stdout, stderr io.Writer, opts InspectOptions) error {
	if strings.TrimSpace(opts.RunID) == "" {
		return fmt.Errorf("missing required flag: --id")
	}

	// Find the pod for this run
	podName, err := findRunPod(ctx, opts)
	if err != nil {
		return err
	}

	if podName == "" {
		return fmt.Errorf("no active pod found for run %s", opts.RunID)
	}

	// Fetch logs
	logs, err := fetchPodLogs(ctx, opts, podName)
	if err != nil {
		return err
	}

	_, err = io.WriteString(stdout, logs)
	return err
}

// fetchRuns queries Jobs and CronJobs for Fabrik runs.
func fetchRuns(ctx context.Context, opts InspectOptions) ([]RunInfo, error) {
	var runs []RunInfo

	// Query Jobs with fabrik.sh/managed-by=fabrik label
	jobRuns, err := fetchJobRuns(ctx, opts)
	if err != nil {
		return nil, err
	}
	runs = append(runs, jobRuns...)

	// Query CronJobs with fabrik.sh/managed-by=fabrik label
	cronJobRuns, err := fetchCronJobRuns(ctx, opts)
	if err != nil {
		return nil, err
	}
	runs = append(runs, cronJobRuns...)

	return runs, nil
}

// fetchJobRuns queries K8s Jobs for Fabrik runs.
func fetchJobRuns(ctx context.Context, opts InspectOptions) ([]RunInfo, error) {
	args := []string{"-n", opts.Namespace, "get", "jobs", "-l", "fabrik.sh/managed-by=fabrik", "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		// No jobs found is not an error
		if strings.Contains(err.Error(), "No resources found") {
			return []RunInfo{}, nil
		}
		return nil, err
	}

	var jobList struct {
		Items []struct {
			Metadata struct {
				Name              string            `json:"name"`
				Labels            map[string]string `json:"labels"`
				Annotations       map[string]string `json:"annotations"`
				CreationTimestamp string            `json:"creationTimestamp"`
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
				StartTime      string `json:"startTime"`
				CompletionTime string `json:"completionTime"`
				Conditions     []struct {
					Type               string `json:"type"`
					Status             string `json:"status"`
					LastProbeTime      string `json:"lastProbeTime"`
					LastTransitionTime string `json:"lastTransitionTime"`
					Reason             string `json:"reason"`
					Message            string `json:"message"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}

	if err := json.Unmarshal([]byte(out), &jobList); err != nil {
		return nil, fmt.Errorf("parse job list: %w", err)
	}

	var runs []RunInfo
	for _, job := range jobList.Items {
		runID := job.Metadata.Labels["fabrik.sh/run-id"]
		if runID == "" {
			continue
		}

		created, _ := time.Parse(time.RFC3339, job.Metadata.CreationTimestamp)
		runs = append(runs, RunInfo{
			RunID:     runID,
			Project:   job.Metadata.Labels["fabrik.sh/project"],
			Spec:      job.Metadata.Labels["fabrik.sh/spec"],
			Phase:     job.Metadata.Labels["fabrik.sh/phase"],
			Status:    job.Metadata.Labels["fabrik.sh/status"],
			Task:      job.Metadata.Labels["fabrik.sh/task"],
			Outcome:   job.Metadata.Annotations["fabrik.sh/outcome"],
			StartedAt: parseTime(job.Status.StartTime),
			Age:       formatAge(created),
			Namespace: opts.Namespace,
			Kind:      "Job",
			JobName:   job.Metadata.Name,
		})
	}

	return runs, nil
}

// fetchCronJobRuns queries K8s CronJobs for Fabrik runs.
func fetchCronJobRuns(ctx context.Context, opts InspectOptions) ([]RunInfo, error) {
	args := []string{"-n", opts.Namespace, "get", "cronjobs", "-l", "fabrik.sh/managed-by=fabrik", "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		// No cronjobs found is not an error
		if strings.Contains(err.Error(), "No resources found") {
			return []RunInfo{}, nil
		}
		return nil, err
	}

	var cronJobList struct {
		Items []struct {
			Metadata struct {
				Name              string            `json:"name"`
				Labels            map[string]string `json:"labels"`
				Annotations       map[string]string `json:"annotations"`
				CreationTimestamp string            `json:"creationTimestamp"`
			} `json:"metadata"`
			Spec struct {
				Schedule string `json:"schedule"`
			} `json:"spec"`
		} `json:"items"`
	}

	if err := json.Unmarshal([]byte(out), &cronJobList); err != nil {
		return nil, fmt.Errorf("parse cronjob list: %w", err)
	}

	var runs []RunInfo
	for _, cj := range cronJobList.Items {
		runID := cj.Metadata.Labels["fabrik.sh/run-id"]
		if runID == "" {
			continue
		}

		created, _ := time.Parse(time.RFC3339, cj.Metadata.CreationTimestamp)
		runs = append(runs, RunInfo{
			RunID:       runID,
			Project:     cj.Metadata.Labels["fabrik.sh/project"],
			Spec:        cj.Metadata.Labels["fabrik.sh/spec"],
			Phase:       cj.Metadata.Labels["fabrik.sh/phase"],
			Status:      "scheduled",
			Task:        cj.Metadata.Labels["fabrik.sh/task"],
			Outcome:     "",
			Age:         formatAge(created),
			Namespace:   opts.Namespace,
			Kind:        "CronJob",
			CronJobName: cj.Metadata.Name,
		})
	}

	return runs, nil
}

// fetchRunStatus retrieves detailed status for a specific run.
func fetchRunStatus(ctx context.Context, opts InspectOptions) (*RunStatus, error) {
	// First try to find as a Job
	status, err := fetchJobStatus(ctx, opts)
	if err == nil && status != nil {
		return status, nil
	}

	// Try as a CronJob
	status, err = fetchCronJobStatus(ctx, opts)
	if err == nil && status != nil {
		return status, nil
	}

	return nil, fmt.Errorf("run %s not found in namespace %s", opts.RunID, opts.Namespace)
}

// fetchJobStatus retrieves detailed status for a Job-based run.
func fetchJobStatus(ctx context.Context, opts InspectOptions) (*RunStatus, error) {
	args := []string{"-n", opts.Namespace, "get", "job", "-l", "fabrik.sh/run-id=" + opts.RunID, "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		return nil, err
	}

	var jobList struct {
		Items []struct {
			Metadata struct {
				Name              string            `json:"name"`
				Labels            map[string]string `json:"labels"`
				Annotations       map[string]string `json:"annotations"`
				CreationTimestamp string            `json:"creationTimestamp"`
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
				StartTime      string `json:"startTime"`
				CompletionTime string `json:"completionTime"`
				Conditions     []struct {
					Type               string `json:"type"`
					Status             string `json:"status"`
					LastProbeTime      string `json:"lastProbeTime"`
					LastTransitionTime string `json:"lastTransitionTime"`
					Reason             string `json:"reason"`
					Message            string `json:"message"`
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

	// Parse status JSON from annotations
	var statusJSON struct {
		Phase       string   `json:"phase"`
		CurrentTask string   `json:"current_task"`
		Attempt     int      `json:"attempt"`
		Progress    Progress `json:"progress"`
	}
	if statusData := job.Metadata.Annotations["fabrik.sh/status"]; statusData != "" {
		_ = json.Unmarshal([]byte(statusData), &statusJSON)
	}

	// Parse progress JSON
	var progress Progress
	if progressData := job.Metadata.Annotations["fabrik.sh/progress"]; progressData != "" {
		_ = json.Unmarshal([]byte(progressData), &progress)
	}

	// Build conditions
	var conditions []JobCondition
	for _, c := range job.Status.Conditions {
		conditions = append(conditions, JobCondition{
			Type:               c.Type,
			Status:             c.Status,
			LastProbeTime:      parseTime(c.LastProbeTime),
			LastTransitionTime: parseTime(c.LastTransitionTime),
			Reason:             c.Reason,
			Message:            c.Message,
		})
	}

	// Get associated pods
	pods, err := fetchRunPods(ctx, opts)
	if err != nil {
		pods = []PodInfo{}
	}

	// Determine image from job spec
	image := ""
	if len(job.Spec.Template.Spec.Containers) > 0 {
		image = job.Spec.Template.Spec.Containers[0].Image
	}

	return &RunStatus{
		RunInfo: RunInfo{
			RunID:      job.Metadata.Labels["fabrik.sh/run-id"],
			Project:    job.Metadata.Labels["fabrik.sh/project"],
			Spec:       job.Metadata.Labels["fabrik.sh/spec"],
			Phase:      coalesce(job.Metadata.Labels["fabrik.sh/phase"], statusJSON.Phase),
			Status:     coalesce(job.Metadata.Labels["fabrik.sh/status"], "unknown"),
			Task:       coalesce(job.Metadata.Labels["fabrik.sh/task"], statusJSON.CurrentTask),
			Outcome:    job.Metadata.Annotations["fabrik.sh/outcome"],
			StartedAt:  parseTime(job.Status.StartTime),
			FinishedAt:   parseTime(job.Status.CompletionTime),
			Image:      image,
			Namespace:  opts.Namespace,
			Kind:       "Job",
			JobName:    job.Metadata.Name,
			Progress:   coalesceProgress(progress, statusJSON.Progress),
		},
		Attempts:    statusJSON.Attempt,
		Conditions:  conditions,
		Pods:        pods,
		Annotations: job.Metadata.Annotations,
		Labels:      job.Metadata.Labels,
	}, nil
}

// fetchCronJobStatus retrieves detailed status for a CronJob-based run.
func fetchCronJobStatus(ctx context.Context, opts InspectOptions) (*RunStatus, error) {
	args := []string{"-n", opts.Namespace, "get", "cronjob", "-l", "fabrik.sh/run-id=" + opts.RunID, "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		return nil, err
	}

	var cronJobList struct {
		Items []struct {
			Metadata struct {
				Name              string            `json:"name"`
				Labels            map[string]string `json:"labels"`
				Annotations       map[string]string `json:"annotations"`
				CreationTimestamp string            `json:"creationTimestamp"`
			} `json:"metadata"`
			Spec struct {
				Schedule string `json:"schedule"`
			} `json:"spec"`
			Status struct {
				Active []struct {
					Name string `json:"name"`
					Kind string `json:"kind"`
					UID  string `json:"uid"`
				} `json:"active"`
				LastScheduleTime string `json:"lastScheduleTime"`
				LastSuccessfulTime string `json:"lastSuccessfulTime"`
			} `json:"status"`
		} `json:"items"`
	}

	if err := json.Unmarshal([]byte(out), &cronJobList); err != nil {
		return nil, fmt.Errorf("parse cronjob: %w", err)
	}

	if len(cronJobList.Items) == 0 {
		return nil, fmt.Errorf("cronjob not found")
	}

	cj := cronJobList.Items[0]

	return &RunStatus{
		RunInfo: RunInfo{
			RunID:       cj.Metadata.Labels["fabrik.sh/run-id"],
			Project:     cj.Metadata.Labels["fabrik.sh/project"],
			Spec:        cj.Metadata.Labels["fabrik.sh/spec"],
			Phase:       cj.Metadata.Labels["fabrik.sh/phase"],
			Status:      "scheduled",
			Task:        cj.Metadata.Labels["fabrik.sh/task"],
			Outcome:     "",
			Namespace:   opts.Namespace,
			Kind:        "CronJob",
			CronJobName: cj.Metadata.Name,
		},
		Annotations: cj.Metadata.Annotations,
		Labels:      cj.Metadata.Labels,
	}, nil
}

// fetchRunPods retrieves pod information for a run.
func fetchRunPods(ctx context.Context, opts InspectOptions) ([]PodInfo, error) {
	args := []string{"-n", opts.Namespace, "get", "pods", "-l", "fabrik.sh/run-id=" + opts.RunID, "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		return nil, err
	}

	var podList struct {
		Items []struct {
			Metadata struct {
				Name              string `json:"name"`
				CreationTimestamp string `json:"creationTimestamp"`
			} `json:"metadata"`
			Status struct {
				Phase      string `json:"phase"`
				StartTime  string `json:"startTime"`
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
					Reason string `json:"reason"`
				} `json:"conditions"`
				ContainerStatuses []struct {
					Name         string `json:"name"`
					Ready        bool   `json:"ready"`
					RestartCount int    `json:"restartCount"`
					State        struct {
						Terminated *struct {
							ExitCode int    `json:"exitCode"`
							Reason   string `json:"reason"`
							Message  string `json:"message"`
						} `json:"terminated"`
						Waiting *struct {
							Reason  string `json:"reason"`
							Message string `json:"message"`
						} `json:"waiting"`
					} `json:"state"`
					LastTerminationState struct {
						Terminated *struct {
							ExitCode int    `json:"exitCode"`
							Reason   string `json:"reason"`
							Message  string `json:"message"`
						} `json:"terminated"`
					} `json:"lastState"`
				} `json:"containerStatuses"`
			} `json:"status"`
		} `json:"items"`
	}

	if err := json.Unmarshal([]byte(out), &podList); err != nil {
		return nil, fmt.Errorf("parse pods: %w", err)
	}

	var pods []PodInfo
	for _, pod := range podList.Items {
		podInfo := PodInfo{
			Name:      pod.Metadata.Name,
			Phase:     pod.Status.Phase,
			StartTime: parseTime(pod.Status.StartTime),
		}

		// Get container status
		for _, cs := range pod.Status.ContainerStatuses {
			containerStatus := ContainerStatus{
				Name:      cs.Name,
				Ready:     cs.Ready,
				Restarted: cs.RestartCount,
			}

			if cs.State.Terminated != nil {
				containerStatus.ExitCode = cs.State.Terminated.ExitCode
				containerStatus.Reason = cs.State.Terminated.Reason
				podInfo.ExitCode = cs.State.Terminated.ExitCode
				podInfo.Reason = cs.State.Terminated.Reason
				podInfo.Message = cs.State.Terminated.Message
			} else if cs.State.Waiting != nil {
				containerStatus.Reason = cs.State.Waiting.Reason
				podInfo.Reason = cs.State.Waiting.Reason
				podInfo.Message = cs.State.Waiting.Message
			}

			podInfo.Containers = append(podInfo.Containers, containerStatus)
		}

		pods = append(pods, podInfo)
	}

	return pods, nil
}

// findRunPod finds the primary pod for a run.
func findRunPod(ctx context.Context, opts InspectOptions) (string, error) {
	pods, err := fetchRunPods(ctx, opts)
	if err != nil {
		return "", err
	}

	if len(pods) == 0 {
		return "", nil
	}

	// Return the most recent active pod, or the first one
	for _, pod := range pods {
		if pod.Phase == "Running" || pod.Phase == "Pending" {
			return pod.Name, nil
		}
	}

	// Return the first pod (likely completed or failed)
	return pods[0].Name, nil
}

// fetchPodLogs retrieves logs from a specific pod.
func fetchPodLogs(ctx context.Context, opts InspectOptions, podName string) (string, error) {
	args := []string{"-n", opts.Namespace, "logs", podName}
	return kubectlOutput(ctx, opts.KubeContext, args...)
}

// kubectlOutput executes kubectl and returns the output.
func kubectlOutput(ctx context.Context, contextName string, args ...string) (string, error) {
	cmdArgs := make([]string, 0, len(args)+2)
	if strings.TrimSpace(contextName) != "" {
		cmdArgs = append(cmdArgs, "--context", contextName)
	}
	cmdArgs = append(cmdArgs, args...)

	cmd := exec.CommandContext(ctx, "kubectl", cmdArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(cmdArgs, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// Helper functions
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-1] + "…"
}

func parseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.Format(time.RFC3339)
}

func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return d.Round(time.Second).String()
	}
	return d.Round(time.Minute).String()
}

func formatAge(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	d := time.Since(t)
	if d < time.Hour {
		return d.Round(time.Minute).String()
	}
	if d < 24*time.Hour {
		return d.Round(time.Hour).String()
	}
	return d.Round(24 * time.Hour).String()
}

func coalesce(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func coalesceProgress(p1, p2 Progress) Progress {
	if p1.Total > 0 {
		return p1
	}
	return p2
}
