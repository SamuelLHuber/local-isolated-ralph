package cmd

import (
	"io"

	"github.com/spf13/cobra"
)

type Streams struct {
	In  io.Reader
	Out io.Writer
	Err io.Writer
}

func NewRootCommand(streams Streams, runMode string) *cobra.Command {
	rootCmd := &cobra.Command{
		Use:           "fabrik",
		Short:         "Fabrik CLI for k3s and k3d workflows",
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	if streams.In != nil {
		rootCmd.SetIn(streams.In)
	}
	if streams.Out != nil {
		rootCmd.SetOut(streams.Out)
	}
	if streams.Err != nil {
		rootCmd.SetErr(streams.Err)
	}

	rootCmd.AddCommand(newRunCommand(runMode))
	rootCmd.AddCommand(newEnvCommand())
	rootCmd.AddCommand(newVersionCommand())
	AddRunCommands(rootCmd)

	return rootCmd
}

func Execute(streams Streams, runMode string) error {
	return NewRootCommand(streams, runMode).Execute()
}
