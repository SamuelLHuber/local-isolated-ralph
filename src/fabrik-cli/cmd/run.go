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
		Short: "Dispatch a Fabrik run to Kubernetes",
		Long: "Dispatch a Fabrik run to Kubernetes.\n\n" +
			"The default live behavior applies the PVC and Job, verifies that the Job " +
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
	flags.StringVar(&opts.SharedCredentialSecret, "shared-credential-secret", "", "Existing shared credential Secret in fabrik-system to mirror and mount for this run")
	flags.StringVar(&opts.SharedCredentialFile, "shared-credential-file", "", "Local file to import into a run-scoped shared credential Secret override")
	flags.StringVar(&opts.SharedCredentialDir, "shared-credential-dir", "", "Local directory to import into a run-scoped shared credential Secret override")
	flags.StringVar(&opts.Image, "image", "", "Immutable image reference for the job; optional in workflow mode when GHCR auto-resolution is configured via FABRIK_SMITHERS_IMAGE or FABRIK_SMITHERS_REPO")
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
	flags.BoolVar(&opts.DisableSharedCredentials, "disable-shared-credentials", false, "Do not mount any shared credential bundle for this run")
	flags.BoolVar(&opts.AcceptFilteredSync, "accept-filtered-sync", false, "Acknowledge that workflow artifact sync excludes .git and .jj, and that repo state should come from JJ/Git in the workflow while .fabrik-sync is only for a few local-only files")
	flags.BoolVar(&opts.Interactive, "interactive", opts.Interactive, "Prompt for missing values")
	flags.BoolVar(&opts.RenderOnly, "render", false, "Render resources without applying them")
	flags.BoolVar(&opts.DryRun, "dry-run", false, "Validate resources without mutating the cluster")

	return cmd
}
