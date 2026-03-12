package cmd

import (
	"context"
	"encoding/json"
	"fabrik-cli/internal/runs"
	"fmt"
	"io"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

func newRunsCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "runs",
		Short: "Inspect Fabrik runs",
		Long:  "List and inspect Fabrik runs directly from Kubernetes resources.",
	}

	cmd.AddCommand(newRunsListCommand())
	cmd.AddCommand(newRunsShowCommand())

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
			"recreate it. Progress is preserved in the PVC. The same image digest is used.",
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

	if err := client.Cancel(ctx, opts.RunID); err != nil {
		return err
	}

	_, err := fmt.Fprintf(stdout, "Canceled run %s\n", opts.RunID)
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

// AddRunCommands adds the run inspection commands to the root command.
// This is called from main.go to wire up the commands.
func AddRunCommands(root *cobra.Command) {
	root.AddCommand(newRunsCommand())
	
	// Add the run subcommands directly under 'run' for convenience
	// These use the run command's persistent flags
	root.AddCommand(newRunLogsCommand())
	root.AddCommand(newRunCancelCommand())
	root.AddCommand(newRunResumeCommand())
}
