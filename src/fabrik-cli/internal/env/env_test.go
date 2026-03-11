package env

import (
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
