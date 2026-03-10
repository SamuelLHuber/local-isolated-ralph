package cmd

import (
	"fabrik-cli/internal/run"

	"github.com/spf13/cobra"
)

func newRunCommand() *cobra.Command {
	opts := run.Options{
		Namespace:    "fabrik-runs",
		PVCSize:      "10Gi",
		PreClean:     true,
		Interactive:  true,
		Wait:         true,
		WaitTimeout:  "5m",
		JobCommand:   run.DefaultJobCommand(),
		OutputSubdir: "k8s/job-sync",
	}

	cmd := &cobra.Command{
		Use:   "run",
		Short: "Dispatch a Fabrik run to Kubernetes",
		Long: "Dispatch a Fabrik run to Kubernetes.\n\n" +
			"The first implementation targets local k3d development and mirrors " +
			"the current run-and-sync workflow while we migrate it into Go.",
		RunE: func(cmd *cobra.Command, args []string) error {
			opts.NonInteractive = !opts.Interactive
			return run.Execute(cmd.Context(), cmd.OutOrStdout(), cmd.ErrOrStderr(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "run-id", "", "Run identifier")
	flags.StringVar(&opts.SpecPath, "spec", "", "Path to the run spec")
	flags.StringVar(&opts.Project, "project", "", "Project ID (DNS-1123)")
	flags.StringVar(&opts.Image, "image", "", "Immutable image reference for the job")
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")
	flags.StringVar(&opts.PVCSize, "pvc-size", opts.PVCSize, "PVC size request")
	flags.StringVar(&opts.StorageClass, "storage-class", "", "PVC storage class")
	flags.StringVar(&opts.JobCommand, "job-command", opts.JobCommand, "Shell command to run inside the job container")
	flags.StringVar(&opts.WaitTimeout, "wait-timeout", opts.WaitTimeout, "Maximum time to wait for job completion")
	flags.StringVar(&opts.OutputSubdir, "output-subdir", opts.OutputSubdir, "Artifact output directory relative to the repo root")
	flags.BoolVar(&opts.PreClean, "pre-clean", opts.PreClean, "Clean the mounted workdir before starting")
	flags.BoolVar(&opts.Wait, "wait", opts.Wait, "Wait for job completion and sync artifacts")
	flags.BoolVar(&opts.Interactive, "interactive", opts.Interactive, "Prompt for missing values")
	flags.BoolVar(&opts.RenderOnly, "render", false, "Render resources without applying them")
	flags.BoolVar(&opts.DryRun, "dry-run", false, "Validate resources without mutating the cluster")

	return cmd
}
