package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestRootCommandHasEnv(t *testing.T) {
	var out bytes.Buffer
	root := NewRootCommand(Streams{In: strings.NewReader(""), Out: &out, Err: &out}, "test")
	root.SetArgs([]string{"--help"})
	if err := root.Execute(); err != nil {
		t.Fatalf("execute help failed: %v", err)
	}
	if !strings.Contains(out.String(), "env") {
		t.Fatalf("expected help to include env command")
	}
}

func TestEnvHelpMentionsPullAndPromote(t *testing.T) {
	var out bytes.Buffer
	root := NewRootCommand(Streams{In: strings.NewReader(""), Out: &out, Err: &out}, "test")
	root.SetArgs([]string{"env", "--help"})
	if err := root.Execute(); err != nil {
		t.Fatalf("execute help failed: %v", err)
	}
	help := out.String()
	for _, want := range []string{"pull", "promote", "validate", "run"} {
		if !strings.Contains(help, want) {
			t.Fatalf("expected env help to include %q, got:\n%s", want, help)
		}
	}
}
