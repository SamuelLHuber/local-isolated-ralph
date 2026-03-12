package runs

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// PVCInfo holds metadata about a PersistentVolumeClaim.
type PVCInfo struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Phase       string            `json:"phase"`
	Age         time.Duration     `json:"age"`
	Size        string            `json:"size"`
	StorageClass string           `json:"storage_class"`
	Labels      map[string]string `json:"labels,omitempty"`
	OwnerReferences []OwnerRef    `json:"owner_references,omitempty"`
	IsBound     bool              `json:"is_bound"`
	IsOrphaned  bool              `json:"is_orphaned"`
}

// OwnerRef represents an owner reference.
type OwnerRef struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	UID        string `json:"uid,omitempty"`
}

// CleanupResult holds the result of a cleanup operation.
type CleanupResult struct {
	Deleted   []string `json:"deleted"`
	Failed    []string `json:"failed"`
	Skipped   []string `json:"skipped"`
	Total     int      `json:"total"`
}

// RetainResult holds the result of a retain operation.
type RetainResult struct {
	RunID        string        `json:"run_id"`
	JobName      string        `json:"job_name"`
	PVCName      string        `json:"pvc_name"`
	PreviousTTL  time.Duration `json:"previous_ttl,omitempty"`
	NewTTL       time.Duration `json:"new_ttl"`
	RetainedUntil time.Time    `json:"retained_until"`
}

// runPVCJSON represents the kubectl JSON output for PVCs.
type runPVCJSON struct {
	Metadata struct {
		Name            string            `json:"name"`
		Namespace       string            `json:"namespace"`
		Labels          map[string]string `json:"labels"`
		CreationTimestamp string          `json:"creationTimestamp"`
		OwnerReferences []struct {
			APIVersion string `json:"apiVersion"`
			Kind       string `json:"kind"`
			Name       string `json:"name"`
			UID        string `json:"uid"`
		} `json:"ownerReferences"`
	} `json:"metadata"`
	Spec struct {
		StorageClassName string `json:"storageClassName"`
		Resources        struct {
			Requests struct {
				Storage string `json:"storage"`
			} `json:"requests"`
		} `json:"resources"`
	} `json:"spec"`
	Status struct {
		Phase string `json:"phase"`
	} `json:"status"`
}

// ListPVCs returns all PVCs in the namespace with fabrik.sh/managed-by label.
func (c *K8sClient) ListPVCs(ctx context.Context) ([]PVCInfo, error) {
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "pvc",
		"-l", "fabrik.sh/managed-by=fabrik",
		"-o", "json")
	if err != nil {
		if strings.Contains(err.Error(), "No resources found") {
			return nil, nil
		}
		return nil, fmt.Errorf("list pvcs: %w", err)
	}

	var result struct {
		Items []runPVCJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, fmt.Errorf("parse pvcs: %w", err)
	}

	now := time.Now()
	var pvcs []PVCInfo
	for _, pvc := range result.Items {
		info := c.pvcToInfo(&pvc, now)
		pvcs = append(pvcs, info)
	}

	return pvcs, nil
}

// ListOrphanedPVCs returns PVCs that are not bound to any active Job.
func (c *K8sClient) ListOrphanedPVCs(ctx context.Context) ([]PVCInfo, error) {
	allPVCs, err := c.ListPVCs(ctx)
	if err != nil {
		return nil, err
	}

	// Get all active jobs
	activeJobs, err := c.listActiveJobs(ctx)
	if err != nil {
		return nil, fmt.Errorf("list active jobs for orphan detection: %w", err)
	}

	// Build set of job names that own PVCs
	activeJobNames := make(map[string]bool)
	for _, job := range activeJobs {
		activeJobNames[job.Metadata.Name] = true
	}

	var orphaned []PVCInfo
	for _, pvc := range allPVCs {
		isOrphaned := true
		for _, owner := range pvc.OwnerReferences {
			if owner.Kind == "Job" && activeJobNames[owner.Name] {
				isOrphaned = false
				break
			}
		}
		// PVCs without owner references are also considered orphaned
		if len(pvc.OwnerReferences) == 0 {
			isOrphaned = true
		}
		
		if isOrphaned {
			pvc.IsOrphaned = true
			orphaned = append(orphaned, pvc)
		}
	}

	return orphaned, nil
}

// CleanupOrphanedPVCs deletes PVCs that are not bound to any active Job.
func (c *K8sClient) CleanupOrphanedPVCs(ctx context.Context, dryRun bool) (*CleanupResult, error) {
	orphaned, err := c.ListOrphanedPVCs(ctx)
	if err != nil {
		return nil, err
	}

	result := &CleanupResult{
		Total: len(orphaned),
	}

	for _, pvc := range orphaned {
		if dryRun {
			result.Skipped = append(result.Skipped, pvc.Name+" (dry-run)")
			continue
		}

		// Verify PVC is not bound before deleting
		if pvc.Phase == "Bound" {
			// Double-check by looking up the owner
			hasOwner := false
			for _, owner := range pvc.OwnerReferences {
				if owner.Kind == "Job" {
					hasOwner = true
					break
				}
			}
			if hasOwner {
				result.Skipped = append(result.Skipped, pvc.Name+" (still has job owner)")
				continue
			}
		}

		_, err := c.runKubectl(ctx, "-n", c.Namespace, "delete", "pvc", pvc.Name, "--ignore-not-found")
		if err != nil {
			result.Failed = append(result.Failed, pvc.Name+": "+err.Error())
		} else {
			result.Deleted = append(result.Deleted, pvc.Name)
		}
	}

	return result, nil
}

// CleanupRuns deletes runs (Jobs) matching the specified filters.
func (c *K8sClient) CleanupRuns(ctx context.Context, opts CleanupOptions) (*CleanupResult, error) {
	runs, err := c.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list runs for cleanup: %w", err)
	}

	// Apply filters
	var toDelete []RunInfo
	for _, run := range runs {
		if !c.matchesCleanupFilters(&run, opts) {
			continue
		}
		toDelete = append(toDelete, run)
	}

	result := &CleanupResult{
		Total: len(toDelete),
	}

	for _, run := range toDelete {
		if opts.DryRun {
			result.Skipped = append(result.Skipped, run.RunID+" (dry-run)")
			continue
		}

		// Delete the job
		_, err := c.runKubectl(ctx, "-n", c.Namespace, "delete", "job", run.JobName, "--ignore-not-found")
		if err != nil {
			// Check for RBAC errors
			if isRBACPermissionError(err) {
				result.Failed = append(result.Failed, run.RunID+": insufficient permissions to delete job")
			} else {
				result.Failed = append(result.Failed, run.RunID+": "+err.Error())
			}
			continue
		}

		// Also delete associated PVC
		pvcName := trimK8sName("data-fabrik-" + sanitizeName(run.RunID))
		_, _ = c.runKubectl(ctx, "-n", c.Namespace, "delete", "pvc", pvcName, "--ignore-not-found")

		result.Deleted = append(result.Deleted, run.RunID)
	}

	return result, nil
}

// CleanupOptions defines filters for cleanup operations.
type CleanupOptions struct {
	OlderThan   time.Duration
	Status      string // "finished", "failed", "succeeded", or empty for all
	Project     string // Filter by project, or empty for all
	DryRun      bool
}

func (c *K8sClient) matchesCleanupFilters(run *RunInfo, opts CleanupOptions) bool {
	// Check age filter
	if opts.OlderThan > 0 && run.FinishedAt != nil {
		age := time.Since(*run.FinishedAt)
		if age < opts.OlderThan {
			return false
		}
	}

	// Check status filter
	if opts.Status != "" {
		status := strings.ToLower(run.Status)
		outcome := strings.ToLower(run.Outcome)
		
		switch opts.Status {
		case "finished":
			if status != "succeeded" && status != "failed" {
				return false
			}
		case "succeeded":
			if outcome != "succeeded" && status != "succeeded" {
				return false
			}
		case "failed":
			if outcome != "failed" && status != "failed" {
				return false
			}
		default:
			// Custom status match
			if status != opts.Status && outcome != opts.Status {
				return false
			}
		}
	}

	// Check project filter
	if opts.Project != "" && run.Project != opts.Project {
		return false
	}

	return true
}

// Retain extends the lifetime of a run by updating its Job's TTL.
func (c *K8sClient) Retain(ctx context.Context, runID string, days int) (*RetainResult, error) {
	if days <= 0 {
		return nil, fmt.Errorf("retain days must be positive, got %d", days)
	}

	// Find the job
	job, err := c.getJobByRunID(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("cannot retain: job not found for run %q: %w", runID, err)
	}

	// Get PVC name
	pvcName := trimK8sName("data-fabrik-" + sanitizeName(runID))

	// Get current TTL if set
	var previousTTL time.Duration
	ttlOutput, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "job", job.Metadata.Name, "-o", "jsonpath={.spec.ttlSecondsAfterFinished}")
	if err == nil && strings.TrimSpace(ttlOutput) != "" {
		if ttlSecs, err := strconv.Atoi(strings.TrimSpace(ttlOutput)); err == nil {
			previousTTL = time.Duration(ttlSecs) * time.Second
		}
	}

	// Calculate new TTL
	newTTL := time.Duration(days) * 24 * time.Hour
	newTTLSeconds := int(newTTL.Seconds())

	// Update the job's TTL
	patch := fmt.Sprintf(`{"spec":{"ttlSecondsAfterFinished":%d}}`, newTTLSeconds)
	_, err = c.runKubectl(ctx, "-n", c.Namespace, "patch", "job", job.Metadata.Name, "--type=merge", "-p", patch)
	if err != nil {
		return nil, fmt.Errorf("failed to update job TTL: %w", err)
	}

	// Also ensure PVC has owner reference to the job for proper cleanup
	if err := c.ensurePVCOwnerReference(ctx, job.Metadata.Name, pvcName); err != nil {
		// Log but don't fail - the job TTL was already updated
		// PVC may already have owner reference
	}

	return &RetainResult{
		RunID:         runID,
		JobName:       job.Metadata.Name,
		PVCName:       pvcName,
		PreviousTTL:   previousTTL,
		NewTTL:        newTTL,
		RetainedUntil: time.Now().Add(newTTL),
	}, nil
}

// ensurePVCOwnerReference ensures the PVC has an owner reference to the Job.
func (c *K8sClient) ensurePVCOwnerReference(ctx context.Context, jobName, pvcName string) error {
	// Get job UID
	jobUID, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "job", jobName, "-o", "jsonpath={.metadata.uid}")
	if err != nil {
		return fmt.Errorf("get job UID: %w", err)
	}
	jobUID = strings.TrimSpace(jobUID)

	// Check if PVC already has owner reference
	ownerOutput, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "pvc", pvcName, "-o", "jsonpath={.metadata.ownerReferences}")
	if err == nil && strings.TrimSpace(ownerOutput) != "" && strings.Contains(ownerOutput, jobUID) {
		// Already has owner reference to this job
		return nil
	}

	// Patch PVC with owner reference
	payload, err := json.Marshal(map[string]any{
		"metadata": map[string]any{
			"ownerReferences": []map[string]string{
				{
					"apiVersion": "batch/v1",
					"kind":       "Job",
					"name":       jobName,
					"uid":        jobUID,
				},
			},
		},
	})
	if err != nil {
		return fmt.Errorf("marshal owner reference: %w", err)
	}

	_, err = c.runKubectl(ctx, "-n", c.Namespace, "patch", "pvc", pvcName, "--type=merge", "-p", string(payload))
	return err
}

func (c *K8sClient) pvcToInfo(pvc *runPVCJSON, now time.Time) PVCInfo {
	// Parse creation timestamp
	age := time.Duration(0)
	if pvc.Metadata.CreationTimestamp != "" {
		if t, err := time.Parse(time.RFC3339, pvc.Metadata.CreationTimestamp); err == nil {
			age = now.Sub(t)
		}
	}

	// Build owner references
	var owners []OwnerRef
	for _, owner := range pvc.Metadata.OwnerReferences {
		owners = append(owners, OwnerRef{
			APIVersion: owner.APIVersion,
			Kind:       owner.Kind,
			Name:       owner.Name,
			UID:        owner.UID,
		})
	}

	return PVCInfo{
		Name:            pvc.Metadata.Name,
		Namespace:       pvc.Metadata.Namespace,
		Phase:           pvc.Status.Phase,
		Age:             age,
		Size:            pvc.Spec.Resources.Requests.Storage,
		StorageClass:    pvc.Spec.StorageClassName,
		Labels:          pvc.Metadata.Labels,
		OwnerReferences: owners,
		IsBound:         pvc.Status.Phase == "Bound",
	}
}

func (c *K8sClient) listActiveJobs(ctx context.Context) ([]*runJobJSON, error) {
	output, err := c.runKubectl(ctx, "-n", c.Namespace, "get", "jobs",
		"-l", "fabrik.sh/managed-by=fabrik",
		"-o", "json")
	if err != nil {
		if strings.Contains(err.Error(), "No resources found") {
			return nil, nil
		}
		return nil, err
	}

	var result struct {
		Items []runJobJSON `json:"items"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return nil, err
	}

	var active []*runJobJSON
	for i := range result.Items {
		job := &result.Items[i]
		// Consider active if it has active pods or hasn't finished
		if job.Status.Active > 0 || (job.Status.Succeeded == 0 && job.Status.Failed == 0) {
			active = append(active, job)
		}
	}

	return active, nil
}
