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

func TestEnvPromoteHelpMentionsYesFlag(t *testing.T) {
	var out bytes.Buffer
	root := NewRootCommand(Streams{In: strings.NewReader(""), Out: &out, Err: &out}, "test")
	root.SetArgs([]string{"env", "promote", "--help"})
	if err := root.Execute(); err != nil {
		t.Fatalf("execute help failed: %v", err)
	}
	help := out.String()
	if !strings.Contains(help, "--yes") {
		t.Fatalf("expected promote help to include --yes flag, got:\n%s", help)
	}
	if !strings.Contains(help, "confirmation") {
		t.Fatalf("expected promote help to mention confirmation, got:\n%s", help)
	}
}

func TestEnvPromoteHelpMentionsProtectedEnvironments(t *testing.T) {
	var out bytes.Buffer
	root := NewRootCommand(Streams{In: strings.NewReader(""), Out: &out, Err: &out}, "test")
	root.SetArgs([]string{"env", "promote", "--help"})
	if err := root.Execute(); err != nil {
		t.Fatalf("execute help failed: %v", err)
	}
	help := out.String()
	if !strings.Contains(help, "prod") && !strings.Contains(help, "Protected") {
		t.Fatalf("expected promote help to mention protected environments, got:\n%s", help)
	}
}

func TestEnvDiffHelpMentionsFromAndToFlags(t *testing.T) {
	var out bytes.Buffer
	root := NewRootCommand(Streams{In: strings.NewReader(""), Out: &out, Err: &out}, "test")
	root.SetArgs([]string{"env", "diff", "--help"})
	if err := root.Execute(); err != nil {
		t.Fatalf("execute help failed: %v", err)
	}
	help := out.String()
	if !strings.Contains(help, "--from") {
		t.Fatalf("expected diff help to include --from flag, got:\n%s", help)
	}
	if !strings.Contains(help, "--to") {
		t.Fatalf("expected diff help to include --to flag, got:\n%s", help)
	}
}
