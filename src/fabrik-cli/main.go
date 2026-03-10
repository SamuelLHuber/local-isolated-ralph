package main

import (
	"fmt"
	"os"

	"fabrik-cli/cmd"
)

func main() {
	if err := cmd.Execute(cmd.Streams{In: os.Stdin, Out: os.Stdout, Err: os.Stderr}, os.Getenv("FABRIK_RUN_MODE")); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
