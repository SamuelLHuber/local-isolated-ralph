package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestRootCommandHasRun(t *testing.T) {
	var out bytes.Buffer
	root := NewRootCommand(Streams{In: strings.NewReader(""), Out: &out, Err: &out}, "test")
	root.SetArgs([]string{"--help"})
	if err := root.Execute(); err != nil {
		t.Fatalf("execute help failed: %v", err)
	}
	if !strings.Contains(out.String(), "run") {
		t.Fatalf("expected help to include run command")
	}
}
