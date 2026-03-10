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
		Wait:         true,
		WaitTimeout:  "5m",
		JobCommand:   run.DefaultJobCommand(),
		OutputSubdir: "k8s/job-sync",
		RunMode:      runMode,
	}

	cmd := &cobra.Command{
		Use:   "run",
		Short: "Dispatch a Fabrik run to Kubernetes",
		Long: "Dispatch a Fabrik run to Kubernetes.\n\n" +
			"The first implementation targets local k3d development and mirrors " +
			"the current run-and-sync workflow while we migrate it into Go.\n\n" +
			"Workflow runs sync logs and filtered artifacts back locally. VCS metadata " +
			"such as .git and .jj is intentionally excluded from artifact sync; preserve " +
			"repo state via JJ/Git inside the workflow prepare step, and treat " +
			".fabrik-sync manifest as the place for small non-VCS files such as .env.local.",
		RunE: func(cmd *cobra.Command, args []string) error {
			opts.NonInteractive = !opts.Interactive
			return run.Execute(cmd.Context(), cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "run-id", "", "Run identifier")
	flags.StringVar(&opts.SpecPath, "spec", "", "Path to the run spec")
	flags.StringVar(&opts.Project, "project", "", "Project ID (DNS-1123)")
	flags.StringVar(&opts.Image, "image", "", "Immutable image reference for the job; optional in workflow mode when GHCR auto-resolution is configured")
	flags.StringVar(&opts.WorkflowPath, "workflow-path", "", "Path to a local workflow file to mount into the job")
	flags.StringVar(&opts.InputJSON, "input-json", "", "JSON input passed to Smithers when using --workflow-path")
	flags.StringVar(&opts.FabrikSyncFile, "fabrik-sync-file", "", "Optional path to a .fabrik-sync manifest listing small non-VCS files to inject before the workflow starts")
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
	flags.BoolVar(&opts.Wait, "wait", opts.Wait, "Wait for job completion and sync artifacts")
	flags.BoolVar(&opts.AcceptFilteredSync, "accept-filtered-sync", false, "Acknowledge that workflow artifact sync excludes .git and .jj and should not be used as the primary VCS preservation mechanism")
	flags.BoolVar(&opts.Interactive, "interactive", opts.Interactive, "Prompt for missing values")
	flags.BoolVar(&opts.RenderOnly, "render", false, "Render resources without applying them")
	flags.BoolVar(&opts.DryRun, "dry-run", false, "Validate resources without mutating the cluster")

	return cmd
}
