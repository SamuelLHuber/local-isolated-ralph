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
	if !strings.Contains(out.String(), "version") {
		t.Fatalf("expected help to include version command")
	}
}

func TestVersionCommandOutput(t *testing.T) {
	prevVersion, prevCommit, prevBuildDate := Version, Commit, BuildDate
	Version = "0.1.0"
	Commit = "abc1234"
	BuildDate = "2026-03-12T12:34:56Z"
	t.Cleanup(func() {
		Version = prevVersion
		Commit = prevCommit
		BuildDate = prevBuildDate
	})

	var out bytes.Buffer
	root := NewRootCommand(Streams{In: strings.NewReader(""), Out: &out, Err: &out}, "test")
	root.SetArgs([]string{"version"})
	if err := root.Execute(); err != nil {
		t.Fatalf("execute version failed: %v", err)
	}

	got := out.String()
	if !strings.Contains(got, "fabrik version 0.1.0") {
		t.Fatalf("expected version line, got %q", got)
	}
	if !strings.Contains(got, "commit: abc1234") {
		t.Fatalf("expected commit line, got %q", got)
	}
	if !strings.Contains(got, "built: 2026-03-12T12:34:56Z") {
		t.Fatalf("expected build date line, got %q", got)
	}
	if !strings.Contains(got, "platform: ") {
		t.Fatalf("expected platform line, got %q", got)
	}
}
