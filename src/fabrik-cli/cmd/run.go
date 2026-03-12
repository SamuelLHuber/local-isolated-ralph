package cmd

import (
	"fabrik-cli/internal/run"

	"github.com/spf13/cobra"
)

func newRunCommand(runMode string) *cobra.Command {
	opts := run.Options{
		Namespace:    "fabrik-runs",
		PVCSize:      "10Gi",
		PreClean:     true,
		Interactive:  true,
		Wait:         false,
		WaitTimeout:  "5m",
		JobCommand:   run.DefaultJobCommand(),
		OutputSubdir: "k8s/job-sync",
		RunMode:      runMode,
	}

	cmd := &cobra.Command{
		Use:   "run",
		Short: "Dispatch and inspect Fabrik runs",
		Long: "Dispatch a Fabrik run to Kubernetes or inspect run logs.\n\n" +
			"The default dispatch behavior applies the PVC and Job, verifies that the Job " +
			"has started on the cluster, and then returns. When --cron is set, the " +
			"command creates a CronJob and verifies the scheduled object exists. Use " +
			"--wait when you need completion tracking and local artifact sync for a " +
			"one-shot Job.\n\n" +
			"Workflow runs sync logs and filtered artifacts back locally only when " +
			"--wait is enabled. VCS metadata such as .git and .jj is intentionally " +
			"excluded from artifact sync; preserve repo state via JJ/Git inside the " +
			"workflow prepare step, and use .fabrik-sync only for a few explicit " +
			"local-only files such as .env.local.",
		RunE: func(cmd *cobra.Command, args []string) error {
			opts.NonInteractive = !opts.Interactive
			return run.Execute(cmd.Context(), cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "run-id", "", "Run identifier")
	flags.StringVar(&opts.SpecPath, "spec", "", "Path to the run spec")
	flags.StringVar(&opts.Project, "project", "", "Project ID (DNS-1123)")
	flags.StringVar(&opts.Environment, "env", "", "Project environment name to inject from fabrik-system")
	flags.StringVar(&opts.EnvFile, "env-file", "", "Optional dotenv file to upsert into fabrik-system for --project/--env before dispatch")
	flags.StringVar(&opts.Image, "image", "", "Immutable image reference for the job; optional in workflow mode when GHCR auto-resolution is configured")
	flags.StringVar(&opts.CronSchedule, "cron", "", "Cron schedule for a recurring CronJob instead of a one-shot Job")
	flags.StringVar(&opts.WorkflowPath, "workflow-path", "", "Path to a local workflow file to mount into the job")
	flags.StringVar(&opts.InputJSON, "input-json", "", "JSON input passed to Smithers when using --workflow-path")
	flags.StringVar(&opts.FabrikSyncFile, "fabrik-sync-file", "", "Optional path to a .fabrik-sync manifest listing explicit small non-VCS file paths to inject before the workflow starts")
	flags.StringVar(&opts.JJRepo, "jj-repo", "", "Optional JJ/Git repository URL for workflow-driven clone/push behavior")
	flags.StringVar(&opts.JJBookmark, "jj-bookmark", "", "Optional JJ bookmark to move and push from inside the workflow")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")
	flags.StringVar(&opts.PVCSize, "pvc-size", opts.PVCSize, "PVC size request")
	flags.StringVar(&opts.StorageClass, "storage-class", "", "PVC storage class")
	flags.StringVar(&opts.JobCommand, "job-command", opts.JobCommand, "Shell command to run inside the job container")
	flags.StringVar(&opts.WaitTimeout, "wait-timeout", opts.WaitTimeout, "Maximum time to wait for job completion")
	flags.StringVar(&opts.OutputSubdir, "output-subdir", opts.OutputSubdir, "Artifact output directory relative to the repo root")
	flags.BoolVar(&opts.PreClean, "pre-clean", opts.PreClean, "Clean the mounted workdir before starting")
	flags.BoolVar(&opts.Wait, "wait", opts.Wait, "Wait for job completion and sync artifacts back locally")
	flags.BoolVar(&opts.AcceptFilteredSync, "accept-filtered-sync", false, "Acknowledge that workflow artifact sync excludes .git and .jj, and that repo state should come from JJ/Git in the workflow while .fabrik-sync is only for a few local-only files")
	flags.BoolVar(&opts.Interactive, "interactive", opts.Interactive, "Prompt for missing values")
	flags.BoolVar(&opts.RenderOnly, "render", false, "Render resources without applying them")
	flags.BoolVar(&opts.DryRun, "dry-run", false, "Validate resources without mutating the cluster")

	// Add subcommands
	cmd.AddCommand(newRunLogsCommand())
	cmd.AddCommand(newRunResumeCommand())
	cmd.AddCommand(newRunCancelCommand())

	return cmd
}

func newRunLogsCommand() *cobra.Command {
	opts := run.InspectOptions{
		Namespace: "fabrik-runs",
	}

	cmd := &cobra.Command{
		Use:   "logs --id <run-id>",
		Short: "Retrieve logs for a run",
		Long: "Retrieve the pod logs for a specific Fabrik run.\n\n" +
			"Returns the underlying pod logs directly from Kubernetes for the selected run. " +
			"The command finds the pod associated with the run ID and streams its logs.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return run.RunLogs(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "id", "", "Run identifier (required)")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")

	return cmd
}

func newRunResumeCommand() *cobra.Command {
	opts := run.ResumeOptions{
		Namespace: "fabrik-runs",
	}

	cmd := &cobra.Command{
		Use:   "resume --id <run-id>",
		Short: "Resume a stuck Fabrik run",
		Long: "Resume a stuck Fabrik run by deleting its pod, allowing the Job to recreate it.\n\n" +
			"Resume uses the same image digest and preserves the existing PVC with the Smithers " +
			"state database. This ensures progress continuity - Smithers will resume from the " +
			"last completed task when the new pod starts.\n\n" +
			"IMPORTANT: Resume does NOT change the execution model or image. It only deletes " +
			"the stuck pod and lets Kubernetes recreate it with the same specification. " +
			"To change the image or spec, create a new run instead.\n\n" +
			"The Kubernetes-native way: delete the pod, Job recreates it with same PVC.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return run.ResumeRun(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "id", "", "Run identifier (required)")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")

	return cmd
}

func newRunCancelCommand() *cobra.Command {
	opts := run.CancelOptions{
		Namespace: "fabrik-runs",
	}

	cmd := &cobra.Command{
		Use:   "cancel --id <run-id>",
		Short: "Cancel a Fabrik run",
		Long: "Cancel a Fabrik run by deleting its Kubernetes Job or CronJob.\n\n" +
			"This command deletes the Job (for one-shot runs) or CronJob (for scheduled runs) " +
			"associated with the given run ID. For CronJobs, any active child Jobs are also deleted.\n\n" +
			"The cancellation is immediate and cascades to pods via Kubernetes garbage collection. " +
			"The output clearly indicates what was cancelled and whether the run was active or " +
			"already finished.",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, err := run.CancelRun(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
			return err
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "id", "", "Run identifier (required)")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")

	return cmd
}
