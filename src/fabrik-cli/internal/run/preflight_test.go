package run

import (
	"bufio"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCollectPreflightRequirementsAddsGitHubNoteWithoutEnvFile(t *testing.T) {
	result, err := collectPreflightRequirements(Options{
		WorkflowPath: "workflow.tsx",
		JJRepo:       "https://github.com/example/private-repo",
	})
	if err != nil {
		t.Fatalf("collect requirements: %v", err)
	}
	if len(result.Notes) != 1 {
		t.Fatalf("expected one note, got %d", len(result.Notes))
	}
	if len(result.Requirements) != 0 {
		t.Fatalf("expected no fixable requirements, got %d", len(result.Requirements))
	}
}

func TestCollectPreflightRequirementsAddsGitHubTokenRequirement(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env")
	if err := os.WriteFile(envFile, []byte("DATABASE_URL=postgres://demo\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := collectPreflightRequirements(Options{
		WorkflowPath: "workflow.tsx",
		JJRepo:       "https://github.com/example/private-repo",
		EnvFile:      envFile,
	})
	if err != nil {
		t.Fatalf("collect requirements: %v", err)
	}
	if len(result.Requirements) != 1 {
		t.Fatalf("expected one requirement, got %d", len(result.Requirements))
	}
	if result.Requirements[0].Kind != requirementGitHubToken {
		t.Fatalf("expected github token requirement, got %q", result.Requirements[0].Kind)
	}
}

func TestSatisfyPreflightRequirementsInteractiveWritesGitHubToken(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env")
	if err := os.WriteFile(envFile, []byte("DATABASE_URL=postgres://demo\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := satisfyPreflightRequirements(
		context.Background(),
		bufio.NewReader(strings.NewReader("y\nghp_test_token\n")),
		io.Discard,
		Options{Interactive: true, RunMode: "test"},
		[]Requirement{{
			Kind:    requirementGitHubToken,
			EnvFile: envFile,
			Message: "missing github token",
		}},
	)
	if err != nil {
		t.Fatalf("satisfy requirements: %v", err)
	}

	content, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatalf("read env file: %v", err)
	}
	if !strings.Contains(string(content), "GITHUB_TOKEN=\"ghp_test_token\"") {
		t.Fatalf("expected env file to contain GITHUB_TOKEN, got %q", string(content))
	}
}
