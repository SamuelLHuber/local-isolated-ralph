package cmd

import (
	"fmt"
	"runtime"

	"github.com/spf13/cobra"
)

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func newVersionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print Fabrik build information",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, err := fmt.Fprintf(cmd.OutOrStdout(),
				"fabrik version %s\ncommit: %s\nbuilt: %s\nplatform: %s/%s\n",
				Version,
				Commit,
				BuildDate,
				runtime.GOOS,
				runtime.GOARCH,
			)
			return err
		},
	}
}
