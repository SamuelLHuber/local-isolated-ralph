package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunHelpMentionsFilteredSyncAndFabrikSync(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer

	root := NewRootCommand(Streams{
		In:  strings.NewReader(""),
		Out: &out,
		Err: &errOut,
	}, "test")
	root.SetArgs([]string{"run", "--help"})

	if err := root.Execute(); err != nil {
		t.Fatalf("expected help to succeed, got %v", err)
	}

	help := out.String() + errOut.String()
	for _, want := range []string{
		"workflow artifact sync excludes .git and .jj",
		".fabrik-sync",
		"--accept-filtered-sync",
		"--fabrik-sync-file",
	} {
		if !strings.Contains(strings.ToLower(help), strings.ToLower(want)) {
			t.Fatalf("expected help output to mention %q, got:\n%s", want, help)
		}
	}
}
