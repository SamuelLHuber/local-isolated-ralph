package cmd

import (
	"fabrik-cli/internal/env"
	"fmt"

	"github.com/spf13/cobra"
)

func newEnvCommand() *cobra.Command {
	var common env.Options
	common.Namespace = "fabrik-system"

	cmd := &cobra.Command{
		Use:   "env",
		Short: "Manage Fabrik project environments in Kubernetes",
	}

	cmd.PersistentFlags().StringVar(&common.Project, "project", "", "Project ID")
	cmd.PersistentFlags().StringVar(&common.Env, "env", "", "Environment name")
	cmd.PersistentFlags().StringVar(&common.Namespace, "namespace", common.Namespace, "Kubernetes namespace for env secrets")
	cmd.PersistentFlags().StringVar(&common.Context, "context", "", "Kubernetes context")

	cmd.AddCommand(newEnvSetCommand(&common))
	cmd.AddCommand(newEnvListCommand(&common))
	cmd.AddCommand(newEnvPullCommand(&common))
	cmd.AddCommand(newEnvValidateCommand(&common))
	cmd.AddCommand(newEnvRunCommand(&common))
	cmd.AddCommand(newEnvDiffCommand(&common))
	cmd.AddCommand(newEnvPromoteCommand(&common))
	return cmd
}

func newEnvSetCommand(common *env.Options) *cobra.Command {
	opts := env.SetOptions{}
	cmd := &cobra.Command{
		Use:   "set [KEY=value ...]",
		Short: "Create or update a project environment secret",
		RunE: func(cmd *cobra.Command, args []string) error {
			opts.Options = *common
			opts.Pairs = args
			return env.Set(cmd.Context(), cmd.OutOrStdout(), opts)
		},
	}
	cmd.Flags().StringVar(&opts.FromFile, "from-file", "", "Import dotenv-style values from a file")
	cmd.Flags().BoolVar(&opts.Replace, "replace", false, "Replace the full secret payload instead of merging")
	cmd.Flags().StringSliceVar(&opts.Unset, "unset", nil, "Remove one or more keys")
	return cmd
}

func newEnvListCommand(common *env.Options) *cobra.Command {
	return &cobra.Command{
		Use:   "ls",
		Short: "List keys in a project environment secret",
		RunE: func(cmd *cobra.Command, args []string) error {
			return env.List(cmd.Context(), cmd.OutOrStdout(), *common)
		},
	}
}

func newEnvPullCommand(common *env.Options) *cobra.Command {
	return &cobra.Command{
		Use:   "pull [output-path]",
		Short: "Write a project environment to a dotenv file or stdout",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			opts := env.PullOptions{Options: *common}
			if len(args) == 1 {
				opts.OutputPath = args[0]
			}
			return env.Pull(cmd.Context(), cmd.OutOrStdout(), opts)
		},
	}
}

func newEnvValidateCommand(common *env.Options) *cobra.Command {
	return &cobra.Command{
		Use:   "validate",
		Short: "Validate a project environment secret",
		RunE: func(cmd *cobra.Command, args []string) error {
			return env.Validate(cmd.Context(), cmd.OutOrStdout(), *common)
		},
	}
}

func newEnvRunCommand(common *env.Options) *cobra.Command {
	return &cobra.Command{
		Use:   "run -- <command> [args...]",
		Short: "Run a local command with a project environment injected",
		RunE: func(cmd *cobra.Command, args []string) error {
			return env.Run(cmd.Context(), cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr(), *common, args)
		},
	}
}

func newEnvDiffCommand(common *env.Options) *cobra.Command {
	var fromEnv string
	var toEnv string
	cmd := &cobra.Command{
		Use:   "diff",
		Short: "Show key-level differences between two environments",
		RunE: func(cmd *cobra.Command, args []string) error {
			if fromEnv == "" || toEnv == "" {
				return fmt.Errorf("missing required flags: --from and --to")
			}
			return env.Diff(cmd.Context(), cmd.OutOrStdout(), env.DiffOptions{
				Project: common.Project,
				FromEnv: fromEnv,
				ToEnv:   toEnv,
				Options: env.Options{
					Namespace: common.Namespace,
					Context:   common.Context,
				},
			})
		},
	}
	cmd.Flags().StringVar(&fromEnv, "from", "", "Source environment name")
	cmd.Flags().StringVar(&toEnv, "to", "", "Target environment name")
	return cmd
}

func newEnvPromoteCommand(common *env.Options) *cobra.Command {
	var opts env.PromoteOptions
	cmd := &cobra.Command{
		Use:   "promote",
		Short: "Copy keys from one environment secret to another",
		RunE: func(cmd *cobra.Command, args []string) error {
			if opts.FromEnv == "" || opts.ToEnv == "" {
				return fmt.Errorf("missing required flags: --from and --to")
			}
			opts.Project = common.Project
			opts.Options = env.Options{
				Namespace: common.Namespace,
				Context:   common.Context,
			}
			return env.Promote(cmd.Context(), cmd.OutOrStdout(), opts)
		},
	}
	cmd.Flags().StringVar(&opts.FromEnv, "from", "", "Source environment name")
	cmd.Flags().StringVar(&opts.ToEnv, "to", "", "Target environment name")
	cmd.Flags().BoolVar(&opts.Replace, "replace", false, "Replace the target secret instead of merging")
	return cmd
}
