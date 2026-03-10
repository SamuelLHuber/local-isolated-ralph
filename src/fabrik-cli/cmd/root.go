package cmd

import "github.com/spf13/cobra"

func newRootCommand() *cobra.Command {
	rootCmd := &cobra.Command{
		Use:           "fabrik",
		Short:         "Fabrik CLI for k3s and k3d workflows",
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	rootCmd.AddCommand(newRunCommand())

	return rootCmd
}

func Execute() error {
	return newRootCommand().Execute()
}
