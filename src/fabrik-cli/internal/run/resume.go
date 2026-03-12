package run

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// ResumeOptions configures the resume behavior.
type ResumeOptions struct {
	Namespace   string
	KubeContext string
	RunID       string
}

// ResumeRun deletes the stuck pod for a run, allowing the Job to recreate it.
// The Job retains the same image digest and PVC, ensuring state continuity.
func ResumeRun(ctx context.Context, stdout, stderr io.Writer, opts ResumeOptions) error {
	if strings.TrimSpace(opts.RunID) == "" {
		return fmt.Errorf("missing required flag: --id")
	}

	// Resolve namespace default
	if strings.TrimSpace(opts.Namespace) == "" {
		opts.Namespace = "fabrik-runs"
	}

	// Find the job for this run
	jobName, jobImage, err := findJobForRun(ctx, opts)
	if err != nil {
		return err
	}

	// Verify the job uses an immutable image reference
	if !isImmutableImageReference(jobImage) {
		return fmt.Errorf("cannot resume run %s: original job %s uses mutable image reference %s (resume requires immutable digest)", opts.RunID, jobName, jobImage)
	}

	// Find the PVC associated with this job
	pvcName, err := findPVCFOrJob(ctx, opts, jobName)
	if err != nil {
		return err
	}

	// Find the pod(s) for this job
	pods, err := findPodsForJob(ctx, opts, jobName)
	if err != nil {
		return err
	}

	if len(pods) == 0 {
		// No pod to delete - check if job is already complete
		completed, err := isJobCompleted(ctx, opts, jobName)
		if err != nil {
			return err
		}
		if completed {
			return fmt.Errorf("run %s (job %s) is already completed; create a new run instead", opts.RunID, jobName)
		}
		// Job is active but has no pod - it will create one automatically
		_, err = fmt.Fprintf(stdout, "resuming run %s (job %s): no active pod found, job will create a new pod automatically\n", opts.RunID, jobName)
		return err
	}

	// Delete the stuck pod(s) - Job controller will recreate
	for _, pod := range pods {
		_, err = fmt.Fprintf(stdout, "deleting stuck pod %s for run %s\n", pod, opts.RunID)
		if err != nil {
			return err
		}
		if _, err := kubectlOutput(ctx, opts.KubeContext, "-n", opts.Namespace, "delete", "pod", pod, "--ignore-not-found"); err != nil {
			return fmt.Errorf("failed to delete pod %s: %w", pod, err)
		}
	}

	_, err = fmt.Fprintf(stdout, "resumed run %s (job %s, pvc %s)\n  image: %s\n  smithers will resume from last completed task\n", opts.RunID, jobName, pvcName, jobImage)
	return err
}

// findJobForRun locates the Job for a given run ID and returns its name and image.
func findJobForRun(ctx context.Context, opts ResumeOptions) (string, string, error) {
	args := []string{"-n", opts.Namespace, "get", "job", "-l", "fabrik.sh/run-id=" + opts.RunID, "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		if strings.Contains(err.Error(), "No resources found") {
			return "", "", fmt.Errorf("run %s not found in namespace %s: no job with label fabrik.sh/run-id=%s", opts.RunID, opts.Namespace, opts.RunID)
		}
		return "", "", fmt.Errorf("failed to find job for run %s: %w", opts.RunID, err)
	}

	var jobList struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
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
		} `json:"items"`
	}

	if err := json.Unmarshal([]byte(out), &jobList); err != nil {
		return "", "", fmt.Errorf("parse job for run %s: %w", opts.RunID, err)
	}

	if len(jobList.Items) == 0 {
		return "", "", fmt.Errorf("run %s not found in namespace %s: no job with label fabrik.sh/run-id=%s", opts.RunID, opts.Namespace, opts.RunID)
	}

	job := jobList.Items[0]
	image := ""
	if len(job.Spec.Template.Spec.Containers) > 0 {
		image = job.Spec.Template.Spec.Containers[0].Image
	}

	return job.Metadata.Name, image, nil
}

// findPVCFOrJob locates the PVC associated with a job.
func findPVCFOrJob(ctx context.Context, opts ResumeOptions, jobName string) (string, error) {
	// Look for PVCs with the same run-id label
	args := []string{"-n", opts.Namespace, "get", "pvc", "-l", "fabrik.sh/run-id=" + opts.RunID, "-o", "json"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		// Also try by name pattern
		pvcName := trimK8sName("data-fabrik-" + sanitizeName(opts.RunID))
		out2, err2 := kubectlOutput(ctx, opts.KubeContext, "-n", opts.Namespace, "get", "pvc", pvcName, "-o", "jsonpath={.metadata.name}")
		if err2 != nil {
			return "", fmt.Errorf("failed to find PVC for run %s: %w", opts.RunID, err)
		}
		return strings.TrimSpace(out2), nil
	}

	var pvcList struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		} `json:"items"`
	}

	if err := json.Unmarshal([]byte(out), &pvcList); err != nil {
		return "", fmt.Errorf("parse pvc for run %s: %w", opts.RunID, err)
	}

	if len(pvcList.Items) == 0 {
		// Try by name pattern as fallback
		pvcName := trimK8sName("data-fabrik-" + sanitizeName(opts.RunID))
		out2, err2 := kubectlOutput(ctx, opts.KubeContext, "-n", opts.Namespace, "get", "pvc", pvcName, "-o", "jsonpath={.metadata.name}")
		if err2 != nil {
			return "", fmt.Errorf("PVC not found for run %s: %w", opts.RunID, err)
		}
		return strings.TrimSpace(out2), nil
	}

	return pvcList.Items[0].Metadata.Name, nil
}

// findPodsForJob finds all pods associated with a job.
func findPodsForJob(ctx context.Context, opts ResumeOptions, jobName string) ([]string, error) {
	args := []string{"-n", opts.Namespace, "get", "pods", "-l", "job-name=" + jobName, "-o", "jsonpath={.items[*].metadata.name}"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to find pods for job %s: %w", jobName, err)
	}

	out = strings.TrimSpace(out)
	if out == "" {
		return []string{}, nil
	}

	return strings.Fields(out), nil
}

// isJobCompleted checks if a job has completed.
func isJobCompleted(ctx context.Context, opts ResumeOptions, jobName string) (bool, error) {
	args := []string{"-n", opts.Namespace, "get", "job", jobName, "-o", "jsonpath={.status.conditions[?(@.type=='Complete')].status}"}
	out, err := kubectlOutput(ctx, opts.KubeContext, args...)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(out) == "True", nil
}
