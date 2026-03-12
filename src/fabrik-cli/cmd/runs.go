package cmd

import (
	"fabrik-cli/internal/run"

	"github.com/spf13/cobra"
)

func newRunsCommand() *cobra.Command {
	opts := run.InspectOptions{
		Namespace: "fabrik-runs",
	}

	cmd := &cobra.Command{
		Use:   "runs",
		Short: "Inspect Fabrik runs",
		Long:  "List and inspect Fabrik runs directly from Kubernetes metadata.",
	}

	// Global flags for all runs subcommands
	flags := cmd.PersistentFlags()
	flags.StringVar(&opts.Namespace, "namespace", opts.Namespace, "Kubernetes namespace")
	flags.StringVar(&opts.KubeContext, "context", "", "Kubernetes context")

	// Add subcommands
	cmd.AddCommand(newRunsListCommand(opts))
	cmd.AddCommand(newRunsShowCommand(opts))

	return cmd
}

func newRunsListCommand(baseOpts run.InspectOptions) *cobra.Command {
	opts := baseOpts

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List all Fabrik runs",
		Long: "List all Fabrik runs directly from Kubernetes Jobs and CronJobs.\n\n" +
			"The output is tabular and designed to be stable for scripting. " +
			"Each run shows its ID, project, current phase, status, age, and resource kind.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return run.ListRuns(cmd.Context(), cmd.OutOrStdout(), opts)
		},
	}

	flags := cmd.Flags()
	flags.BoolVar(&opts.All, "all", false, "List runs across all namespaces (overrides --namespace)")

	return cmd
}

func newRunsShowCommand(baseOpts run.InspectOptions) *cobra.Command {
	opts := baseOpts

	cmd := &cobra.Command{
		Use:   "show --id <run-id>",
		Short: "Show detailed information about a run",
		Long: "Show detailed information about a specific Fabrik run.\n\n" +
			"Returns current phase, task, progress, timestamps, image digest, outcome, " +
			"and any associated pod information directly from Kubernetes labels, annotations, and status.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return run.ShowRun(cmd.Context(), cmd.OutOrStdout(), opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.RunID, "id", "", "Run identifier (required)")

	return cmd
}
