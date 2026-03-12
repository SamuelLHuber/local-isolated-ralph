package cmd

import (
	"context"
	"encoding/json"
	"fabrik-cli/internal/runs"
	"fmt"
	"io"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

func newRunsCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "runs",
		Short: "Inspect and manage Fabrik runs",
		Long:  "List, inspect, and cleanup Fabrik runs directly from Kubernetes resources.",
	}

	cmd.AddCommand(newRunsListCommand())
	cmd.AddCommand(newRunsShowCommand())
	cmd.AddCommand(newRunsCleanupCommand())

	return cmd
}

type runsListOptions struct {
	Namespace   string
	KubeContext string
	All         bool
	Output      string
}

func newRunsListCommand() *cobra.Command {
	opts := runsListOptions{
		Namespace: "fabrik-runs",
	}

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List Fabrik runs",
		Long: "List Fabrik runs directly from Kubernetes Jobs and CronJobs.\n\n" +
			"This command reads directly from the Kubernetes API and shows current state " +
			"including phase, status, and progress. The output is stable for scripting.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRunsList(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")
	flags.BoolVarP(&opts.All, "all", "a", false, "Show all namespaces")
	flags.StringVarP(&opts.Output, "output", "o", "table", "Output format: table, json, or name")

	return cmd
}

type runsShowOptions struct {
	RunID       string
	Namespace   string
	KubeContext string
	Output      string
}

func newRunsShowCommand() *cobra.Command {
	opts := runsShowOptions{
		Namespace: "fabrik-runs",
	}

	cmd := &cobra.Command{
		Use:   "show",
		Short: "Show details of a Fabrik run",
		Long: "Show detailed information about a Fabrik run including current phase, " +
			"task, progress, timestamps, image digest, and outcome.\n\n" +
			"This command reads directly from Kubernetes Job/Pod labels and annotations. " +
			"K8s is the source of truth for runtime state.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRunsShow(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "id", "", "Run identifier (required)")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")
	flags.StringVarP(&opts.Output, "output", "o", "table", "Output format: table, json, or yaml")

	_ = cmd.MarkFlagRequired("id")

	return cmd
}

type runLogsOptions struct {
	RunID       string
	Namespace   string
	KubeContext string
	Follow      bool
	Tail        int
	Previous    bool
}

func newRunLogsCommand() *cobra.Command {
	opts := runLogsOptions{
		Namespace: "fabrik-runs",
		Tail:      200,
	}

	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Get logs for a Fabrik run",
		Long: "Retrieve logs from the pod running a Fabrik run.\n\n" +
			"This command reads directly from Kubernetes pod logs. Use --follow to stream " +
			"logs in real-time. K8s is the source of truth for runtime output.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRunLogs(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "id", "", "Run identifier (required)")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")
	flags.BoolVarP(&opts.Follow, "follow", "f", false, "Stream logs in real-time")
	flags.IntVar(&opts.Tail, "tail", opts.Tail, "Number of lines to show from end of logs")
	flags.BoolVarP(&opts.Previous, "previous", "p", false, "Show logs from previous container instance")

	_ = cmd.MarkFlagRequired("id")

	return cmd
}

type runCancelOptions struct {
	RunID       string
	Namespace   string
	KubeContext string
}

func newRunCancelCommand() *cobra.Command {
	opts := runCancelOptions{
		Namespace: "fabrik-runs",
	}

	cmd := &cobra.Command{
		Use:   "cancel",
		Short: "Cancel a Fabrik run",
		Long:  "Cancel a running Fabrik run by deleting its Kubernetes Job.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRunCancel(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "id", "", "Run identifier (required)")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")

	_ = cmd.MarkFlagRequired("id")

	return cmd
}

type runResumeOptions struct {
	RunID       string
	Namespace   string
	KubeContext string
}

func newRunResumeCommand() *cobra.Command {
	opts := runResumeOptions{
		Namespace: "fabrik-runs",
	}

	cmd := &cobra.Command{
		Use:   "resume",
		Short: "Resume a stuck Fabrik run",
		Long: "Resume a Fabrik run by deleting its pod, causing the Job controller to " +
			"recreate it with the same specification.\n\n" +
			"Guarantees:\n" +
			"  - The same immutable image digest is used (resume rejects mutable tags)\n" +
			"  - The PVC and Smithers SQLite state are preserved\n" +
			"  - Only the pod is deleted; Job controller recreates it natively\n" +
			"  - Execution model (image, command, env, resources) remains unchanged\n\n" +
			"Requirements:\n" +
			"  - The Job must exist and be active (not already succeeded/failed)\n" +
			"  - The PVC must exist and be Bound\n" +
			"  - The image must use a digest reference (repo/image@sha256:<digest>)\n\n" +
			"Operator Caveats:\n" +
			"  - Resume does NOT change the image, command, or environment\n" +
			"  - Resume does NOT reset the Smithers state; it continues from the last task\n" +
			"  - Resume does NOT work on CronJobs (resume their child Jobs instead)\n" +
			"  - If the Job spec itself needs changes, cancel and create a new run",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRunResume(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "id", "", "Run identifier (required)")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")

	_ = cmd.MarkFlagRequired("id")

	return cmd
}

func runRunsList(ctx context.Context, stdout, stderr io.Writer, opts runsListOptions) error {
	client := &runs.K8sClient{
		KubeContext: opts.KubeContext,
		Namespace:   opts.Namespace,
	}

	runList, err := client.List(ctx)
	if err != nil {
		return fmt.Errorf("list runs: %w", err)
	}

	switch opts.Output {
	case "json":
		return outputRunsJSON(stdout, runList)
	case "name":
		return outputRunsName(stdout, runList)
	default:
		return outputRunsTable(stdout, runList)
	}
}

func runRunsShow(ctx context.Context, stdout, stderr io.Writer, opts runsShowOptions) error {
	client := &runs.K8sClient{
		KubeContext: opts.KubeContext,
		Namespace:   opts.Namespace,
	}

	run, err := client.Show(ctx, opts.RunID)
	if err != nil {
		return err
	}

	switch opts.Output {
	case "json":
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(run)
	case "yaml":
		// Simple YAML-like output for now; full YAML would require a dependency
		return outputRunYAML(stdout, run)
	default:
		return outputRunTable(stdout, run)
	}
}

func runRunLogs(ctx context.Context, stdout, stderr io.Writer, opts runLogsOptions) error {
	client := &runs.K8sClient{
		KubeContext: opts.KubeContext,
		Namespace:   opts.Namespace,
	}

	// If follow mode, we need to stream output differently
	if opts.Follow {
		return streamLogs(ctx, stdout, stderr, client, opts)
	}

	logs, err := client.Logs(ctx, opts.RunID, opts.Tail, false)
	if err != nil {
		return err
	}

	_, err = fmt.Fprint(stdout, logs)
	return err
}

func streamLogs(ctx context.Context, stdout, stderr io.Writer, client *runs.K8sClient, opts runLogsOptions) error {
	// For follow mode, we need to use kubectl directly with follow flag
	// This is a simplified implementation
	fmt.Fprintf(stderr, "Streaming logs for run %s...\n", opts.RunID)
	
	logs, err := client.Logs(ctx, opts.RunID, opts.Tail, true)
	if err != nil {
		return err
	}
	
	_, err = fmt.Fprint(stdout, logs)
	return err
}

func runRunCancel(ctx context.Context, stdout, stderr io.Writer, opts runCancelOptions) error {
	client := &runs.K8sClient{
		KubeContext: opts.KubeContext,
		Namespace:   opts.Namespace,
	}

	result, err := client.Cancel(ctx, opts.RunID)
	if err != nil {
		return err
	}

	// Provide clear status based on what was cancelled
	if result.WasActive {
		_, err := fmt.Fprintf(stdout, "Canceled active run %s (%s %s)\n", opts.RunID, result.Resource, result.Name)
		return err
	}

	if result.WasFinished {
		_, err := fmt.Fprintf(stdout, "Cleaned up finished run %s (status: %s, %s %s)\n",
			opts.RunID, result.Status, result.Resource, result.Name)
		return err
	}

	_, err = fmt.Fprintf(stdout, "Canceled run %s (%s %s)\n", opts.RunID, result.Resource, result.Name)
	return err
}

func runRunResume(ctx context.Context, stdout, stderr io.Writer, opts runResumeOptions) error {
	client := &runs.K8sClient{
		KubeContext: opts.KubeContext,
		Namespace:   opts.Namespace,
	}

	if err := client.Resume(ctx, opts.RunID); err != nil {
		return err
	}

	_, err := fmt.Fprintf(stdout, "Resumed run %s (pod deleted, Job will recreate)\n", opts.RunID)
	return err
}

func outputRunsJSON(stdout io.Writer, runList []runs.RunInfo) error {
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(runList)
}

func outputRunsName(stdout io.Writer, runList []runs.RunInfo) error {
	for _, run := range runList {
		if _, err := fmt.Fprintln(stdout, run.RunID); err != nil {
			return err
		}
	}
	return nil
}

func outputRunsTable(stdout io.Writer, runList []runs.RunInfo) error {
	if len(runList) == 0 {
		fmt.Fprintln(stdout, "No runs found.")
		return nil
	}

	w := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "RUN ID\tPROJECT\tPHASE\tSTATUS\tTASK\tPROGRESS\tAGE\tTYPE")

	now := time.Now()
	for _, run := range runList {
		age := formatAge(run.StartedAt, now)
		progress := formatProgress(run.Progress)
		typ := "job"
		if run.IsCronJob {
			typ = "cron"
		}
		
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			truncate(run.RunID, 26),
			truncate(run.Project, 15),
			truncate(run.Phase, 12),
			truncate(run.Status, 12),
			truncate(run.Task, 20),
			progress,
			age,
			typ,
		)
	}

	return w.Flush()
}

func outputRunTable(stdout io.Writer, run *runs.RunInfo) error {
	w := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	
	fmt.Fprintf(w, "Run ID:\t%s\n", run.RunID)
	fmt.Fprintf(w, "Project:\t%s\n", run.Project)
	fmt.Fprintf(w, "Spec:\t%s\n", run.Spec)
	fmt.Fprintf(w, "Namespace:\t%s\n", run.Namespace)
	if run.Cluster != "" {
		fmt.Fprintf(w, "Cluster:\t%s\n", run.Cluster)
	}
	fmt.Fprintf(w, "Phase:\t%s\n", run.Phase)
	fmt.Fprintf(w, "Status:\t%s\n", run.Status)
	if run.Task != "" {
		fmt.Fprintf(w, "Task:\t%s\n", run.Task)
	}
	if run.Outcome != "" {
		fmt.Fprintf(w, "Outcome:\t%s\n", run.Outcome)
	}
	if run.Progress.Total > 0 {
		fmt.Fprintf(w, "Progress:\t%d/%d\n", run.Progress.Finished, run.Progress.Total)
	}
	if run.StartedAt != nil {
		fmt.Fprintf(w, "Started:\t%s\n", run.StartedAt.Format(time.RFC3339))
	}
	if run.FinishedAt != nil {
		fmt.Fprintf(w, "Finished:\t%s\n", run.FinishedAt.Format(time.RFC3339))
	}
	if run.Image != "" {
		fmt.Fprintf(w, "Image:\t%s\n", run.Image)
	}
	if run.PodName != "" {
		fmt.Fprintf(w, "Pod:\t%s\n", run.PodName)
	}
	if run.JobName != "" {
		fmt.Fprintf(w, "Job:\t%s\n", run.JobName)
	}
	if run.IsCronJob {
		fmt.Fprintf(w, "CronJob:\tyes\n")
		fmt.Fprintf(w, "Schedule:\t%s\n", run.CronSchedule)
	}
	
	return w.Flush()
}

func outputRunYAML(stdout io.Writer, run *runs.RunInfo) error {
	// Simple YAML-like output without external dependencies
	fmt.Fprintf(stdout, "run_id: %s\n", run.RunID)
	fmt.Fprintf(stdout, "project: %s\n", run.Project)
	fmt.Fprintf(stdout, "spec: %s\n", run.Spec)
	fmt.Fprintf(stdout, "phase: %s\n", run.Phase)
	fmt.Fprintf(stdout, "status: %s\n", run.Status)
	if run.Task != "" {
		fmt.Fprintf(stdout, "task: %s\n", run.Task)
	}
	if run.Outcome != "" {
		fmt.Fprintf(stdout, "outcome: %s\n", run.Outcome)
	}
	if run.Progress.Total > 0 {
		fmt.Fprintf(stdout, "progress:\n")
		fmt.Fprintf(stdout, "  finished: %d\n", run.Progress.Finished)
		fmt.Fprintf(stdout, "  total: %d\n", run.Progress.Total)
	}
	if run.StartedAt != nil {
		fmt.Fprintf(stdout, "started_at: %s\n", run.StartedAt.Format(time.RFC3339))
	}
	if run.FinishedAt != nil {
		fmt.Fprintf(stdout, "finished_at: %s\n", run.FinishedAt.Format(time.RFC3339))
	}
	if run.Image != "" {
		fmt.Fprintf(stdout, "image: %s\n", run.Image)
	}
	fmt.Fprintf(stdout, "namespace: %s\n", run.Namespace)
	if run.PodName != "" {
		fmt.Fprintf(stdout, "pod_name: %s\n", run.PodName)
	}
	if run.JobName != "" {
		fmt.Fprintf(stdout, "job_name: %s\n", run.JobName)
	}
	if run.IsCronJob {
		fmt.Fprintf(stdout, "is_cron_job: true\n")
		fmt.Fprintf(stdout, "cron_schedule: %s\n", run.CronSchedule)
	}
	return nil
}

type runsCleanupOptions struct {
	Namespace   string
	KubeContext string
	OlderThan   string
	Status      string
	Project     string
	DryRun      bool
}

func newRunsCleanupCommand() *cobra.Command {
	opts := runsCleanupOptions{
		Namespace: "fabrik-runs",
		Status:    "",
	}

	cmd := &cobra.Command{
		Use:   "cleanup",
		Short: "Cleanup finished Fabrik runs",
		Long: "Cleanup Fabrik runs (Jobs) and their associated PVCs based on age and status filters.\n\n" +
			"This command uses Kubernetes-native TTL mechanisms and ownerReferences for safe cleanup.\n\n" +
			"Examples:\n" +
			"  # Cleanup runs finished more than 7 days ago\n" +
			"  fabrik runs cleanup --older-than 7d\n\n" +
			"  # Cleanup only failed runs older than 30 days\n" +
			"  fabrik runs cleanup --older-than 30d --status failed\n\n" +
			"  # Preview what would be cleaned up without deleting\n" +
			"  fabrik runs cleanup --older-than 7d --dry-run",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRunsCleanup(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")
	flags.StringVar(&opts.OlderThan, "older-than", "", "Delete runs finished older than this duration (e.g., 7d, 24h)")
	flags.StringVar(&opts.Status, "status", opts.Status, "Filter by status: finished, succeeded, failed, or empty for all")
	flags.StringVar(&opts.Project, "project", "", "Filter by project ID")
	flags.BoolVar(&opts.DryRun, "dry-run", false, "Preview what would be deleted without making changes")

	return cmd
}

func runRunsCleanup(ctx context.Context, stdout, stderr io.Writer, opts runsCleanupOptions) error {
	client := &runs.K8sClient{
		KubeContext: opts.KubeContext,
		Namespace:   opts.Namespace,
	}

	cleanupOpts := runs.CleanupOptions{
		Status: opts.Status,
		DryRun: opts.DryRun,
	}

	// Parse duration if provided
	if opts.OlderThan != "" {
		duration, err := parseDuration(opts.OlderThan)
		if err != nil {
			return fmt.Errorf("invalid --older-than duration: %w", err)
		}
		cleanupOpts.OlderThan = duration
	}

	if opts.Project != "" {
		cleanupOpts.Project = opts.Project
	}

	result, err := client.CleanupRuns(ctx, cleanupOpts)
	if err != nil {
		return fmt.Errorf("cleanup runs: %w", err)
	}

	// Output results
	if result.Total == 0 {
		_, err := fmt.Fprintln(stdout, "No runs matched the cleanup criteria.")
		return err
	}

	action := "Deleted"
	if opts.DryRun {
		action = "Would delete"
	}

	_, err = fmt.Fprintf(stdout, "%s %d run(s)\n", action, len(result.Deleted))
	if err != nil {
		return err
	}

	for _, id := range result.Deleted {
		_, err := fmt.Fprintf(stdout, "  %s\n", id)
		if err != nil {
			return err
		}
	}

	if len(result.Skipped) > 0 {
		_, err = fmt.Fprintf(stdout, "\nSkipped %d run(s)\n", len(result.Skipped))
		if err != nil {
			return err
		}
		for _, id := range result.Skipped {
			_, err := fmt.Fprintf(stdout, "  %s\n", id)
			if err != nil {
				return err
			}
		}
	}

	if len(result.Failed) > 0 {
		_, err = fmt.Fprintf(stderr, "\nFailed to delete %d run(s)\n", len(result.Failed))
		if err != nil {
			return err
		}
		for _, msg := range result.Failed {
			_, err := fmt.Fprintf(stderr, "  %s\n", msg)
			if err != nil {
				return err
			}
		}
	}

	return nil
}

func parseDuration(s string) (time.Duration, error) {
	// Support days as 'd' in addition to standard Go durations
	s = strings.TrimSpace(s)
	
	// Handle days
	if strings.HasSuffix(s, "d") {
		daysStr := strings.TrimSuffix(s, "d")
		days, err := strconv.Atoi(daysStr)
		if err != nil {
			return 0, fmt.Errorf("invalid day count: %w", err)
		}
		return time.Duration(days) * 24 * time.Hour, nil
	}

	// Standard Go duration parsing
	return time.ParseDuration(s)
}

func formatAge(t *time.Time, now time.Time) string {
	if t == nil {
		return "unknown"
	}
	duration := now.Sub(*t)
	
	if duration < time.Minute {
		return "<1m"
	}
	if duration < time.Hour {
		return fmt.Sprintf("%dm", int(duration.Minutes()))
	}
	if duration < 24*time.Hour {
		return fmt.Sprintf("%dh", int(duration.Hours()))
	}
	return fmt.Sprintf("%dd", int(duration.Hours()/24))
}

func formatProgress(p runs.Progress) string {
	if p.Total == 0 {
		return "-"
	}
	return fmt.Sprintf("%d/%d", p.Finished, p.Total)
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

type volumesCleanupOptions struct {
	Namespace   string
	KubeContext string
	Unused      bool
	DryRun      bool
}

func newVolumesCleanupCommand() *cobra.Command {
	opts := volumesCleanupOptions{
		Namespace: "fabrik-runs",
	}

	cmd := &cobra.Command{
		Use:   "cleanup",
		Short: "Cleanup unused Fabrik volumes",
		Long: "Cleanup PersistentVolumeClaims (PVCs) that are no longer needed.\n\n" +
			"This command safely removes orphaned PVCs that are not bound to active Jobs.\n\n" +
			"Examples:\n" +
			"  # Cleanup orphaned PVCs\n" +
			"  fabrik volumes cleanup --unused\n\n" +
			"  # Preview what would be cleaned up\n" +
			"  fabrik volumes cleanup --unused --dry-run",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runVolumesCleanup(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")
	flags.BoolVar(&opts.Unused, "unused", false, "Delete PVCs not bound to active Jobs")
	flags.BoolVar(&opts.DryRun, "dry-run", false, "Preview what would be deleted without making changes")

	return cmd
}

func runVolumesCleanup(ctx context.Context, stdout, stderr io.Writer, opts volumesCleanupOptions) error {
	client := &runs.K8sClient{
		KubeContext: opts.KubeContext,
		Namespace:   opts.Namespace,
	}

	if !opts.Unused {
		return fmt.Errorf("specify --unused to cleanup orphaned PVCs")
	}

	result, err := client.CleanupOrphanedPVCs(ctx, opts.DryRun)
	if err != nil {
		return fmt.Errorf("cleanup volumes: %w", err)
	}

	if result.Total == 0 {
		_, err := fmt.Fprintln(stdout, "No orphaned volumes found.")
		return err
	}

	action := "Deleted"
	if opts.DryRun {
		action = "Would delete"
	}

	_, err = fmt.Fprintf(stdout, "%s %d orphaned volume(s)\n", action, len(result.Deleted))
	if err != nil {
		return err
	}

	for _, name := range result.Deleted {
		_, err := fmt.Fprintf(stdout, "  %s\n", name)
		if err != nil {
			return err
		}
	}

	if len(result.Skipped) > 0 {
		_, err = fmt.Fprintf(stdout, "\nSkipped %d volume(s)\n", len(result.Skipped))
		if err != nil {
			return err
		}
		for _, name := range result.Skipped {
			_, err := fmt.Fprintf(stdout, "  %s\n", name)
			if err != nil {
				return err
			}
		}
	}

	if len(result.Failed) > 0 {
		_, err = fmt.Fprintf(stderr, "\nFailed to delete %d volume(s)\n", len(result.Failed))
		if err != nil {
			return err
		}
		for _, msg := range result.Failed {
			_, err := fmt.Fprintf(stderr, "  %s\n", msg)
			if err != nil {
				return err
			}
		}
	}

	return nil
}

type runRetainOptions struct {
	RunID       string
	Namespace   string
	KubeContext string
	Days        int
}

func newRunRetainCommand() *cobra.Command {
	opts := runRetainOptions{
		Namespace: "fabrik-runs",
		Days:      30,
	}

	cmd := &cobra.Command{
		Use:   "retain",
		Short: "Extend the retention period of a Fabrik run",
		Long: "Extend the lifetime of a Fabrik run by updating its Job's TTL.\n\n" +
			"This command updates the ttlSecondsAfterFinished field and ensures the PVC\n" +
			"has an owner reference to the Job for proper lifecycle management.\n\n" +
			"Examples:\n" +
			"  # Retain a run for 30 days (default)\n" +
			"  fabrik run retain --id 01JK7V8X...\n\n" +
			"  # Retain a run for 90 days\n" +
			"  fabrik run retain --id 01JK7V8X... --days 90",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRunRetain(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "id", "", "Run identifier (required)")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")
	flags.IntVar(&opts.Days, "days", opts.Days, "Number of days to retain the run")

	_ = cmd.MarkFlagRequired("id")

	return cmd
}

func runRunRetain(ctx context.Context, stdout, stderr io.Writer, opts runRetainOptions) error {
	client := &runs.K8sClient{
		KubeContext: opts.KubeContext,
		Namespace:   opts.Namespace,
	}

	result, err := client.Retain(ctx, opts.RunID, opts.Days)
	if err != nil {
		return err
	}

	_, err = fmt.Fprintf(stdout, "Retained run %s for %d days\n", result.RunID, opts.Days)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "  Job: %s\n", result.JobName)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "  PVC: %s\n", result.PVCName)
	if err != nil {
		return err
	}
	if result.PreviousTTL > 0 {
		_, err = fmt.Fprintf(stdout, "  Previous TTL: %s\n", result.PreviousTTL)
		if err != nil {
			return err
		}
	}
	_, err = fmt.Fprintf(stdout, "  Retained until: %s\n", result.RetainedUntil.Format(time.RFC3339))
	return err
}

// AddRunCommands adds the run inspection commands to the root command.
// This is called from main.go to wire up the commands.
func AddRunCommands(root *cobra.Command) {
	root.AddCommand(newRunsCommand())
	root.AddCommand(newVolumesCommand())

	// Add the run subcommands under 'run' as specified in the spec:
	// fabrik run logs, fabrik run cancel, fabrik run resume, fabrik run retain
	// Find the run command and add subcommands to it
	for _, cmd := range root.Commands() {
		if cmd.Use == "run" {
			cmd.AddCommand(newRunLogsCommand())
			cmd.AddCommand(newRunCancelCommand())
			cmd.AddCommand(newRunResumeCommand())
			cmd.AddCommand(newRunRetainCommand())
			break
		}
	}
}

func newVolumesCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "volumes",
		Short: "Manage Fabrik volumes",
		Long:  "Inspect and cleanup PersistentVolumeClaims used by Fabrik runs.",
	}

	cmd.AddCommand(newVolumesCleanupCommand())

	return cmd
}
