package env

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDotenvRejectsDuplicateKeys(t *testing.T) {
	_, err := parseDotenv("A=1\nA=2\n")
	if err == nil {
		t.Fatalf("expected duplicate key error")
	}
}

func TestParseDotenvRejectsReservedSmithersKey(t *testing.T) {
	data, err := parseDotenv("SMITHERS_RUN_ID=abc\n")
	if err != nil {
		t.Fatalf("parse dotenv: %v", err)
	}
	if err := validateSecretData(data); err == nil {
		t.Fatalf("expected reserved-key validation failure")
	}
}

func TestRenderDotenvSorted(t *testing.T) {
	out := renderDotenv(map[string]string{
		"B": "2",
		"A": "1",
	})
	if !strings.HasPrefix(out, "A=") {
		t.Fatalf("expected sorted output, got %q", out)
	}
}

func TestParseDotenvPreservesUnbalancedQuotes(t *testing.T) {
	data, err := parseDotenv("TOKEN='\"abc\nOTHER=abc\"'\n")
	if err != nil {
		t.Fatalf("parse dotenv: %v", err)
	}
	if got := data["TOKEN"]; got != "'\"abc" {
		t.Fatalf("expected TOKEN to preserve leading quote pattern, got %q", got)
	}
	if got := data["OTHER"]; got != "abc\"'" {
		t.Fatalf("expected OTHER to preserve trailing quote pattern, got %q", got)
	}
}

func TestParseDotenvStripsMatchingWrapperQuotesOnly(t *testing.T) {
	data, err := parseDotenv("A='value'\nB=\"value\"\n")
	if err != nil {
		t.Fatalf("parse dotenv: %v", err)
	}
	if got := data["A"]; got != "value" {
		t.Fatalf("expected A to strip single quotes, got %q", got)
	}
	if got := data["B"]; got != "value" {
		t.Fatalf("expected B to strip double quotes, got %q", got)
	}
}

func TestWritePrivateFileTightensExistingPermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secret.env")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := writePrivateFile(path, []byte("new")); err != nil {
		t.Fatalf("write private file: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat output: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("expected mode 0600, got %o", mode)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	if string(content) != "new" {
		t.Fatalf("expected updated content, got %q", string(content))
	}
}

func TestUpsertDotenvValueUpdatesAndAppends(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("A=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := UpsertDotenvValue(path, "B", "2"); err != nil {
		t.Fatalf("append dotenv value: %v", err)
	}
	if err := UpsertDotenvValue(path, "A", "3"); err != nil {
		t.Fatalf("update dotenv value: %v", err)
	}

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read dotenv: %v", err)
	}
	if got := string(content); got != "A=\"3\"\nB=\"2\"\n" {
		t.Fatalf("unexpected dotenv content: %q", got)
	}
}
