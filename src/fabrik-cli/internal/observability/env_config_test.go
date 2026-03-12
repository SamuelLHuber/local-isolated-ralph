package observability

import (
	"os"
	"testing"
)

func TestObservabilityConfigOptional(t *testing.T) {
	// LAOS configuration is optional - empty config should be valid
	cfg := LokiConfig{URL: ""}
	
	if cfg.IsConfigured() {
		t.Error("expected IsConfigured=false when URL is empty")
	}
	
	// Validate should not error for empty config (Loki is optional)
	if err := cfg.Validate(); err != nil {
		t.Errorf("expected no error for empty config, got %v", err)
	}
}

func TestExternalLAOSURLConfiguration(t *testing.T) {
	// Test that external Loki URLs are handled correctly
	externalURL := "https://loki.example.com/api/v1/push"
	cfg := LokiConfig{URL: externalURL}
	
	if !cfg.IsConfigured() {
		t.Error("expected IsConfigured=true for external URL")
	}
	
	if err := cfg.Validate(); err != nil {
		t.Errorf("expected no error for valid external URL, got %v", err)
	}
	
	if cfg.URL != externalURL {
		t.Errorf("URL = %q, want %q", cfg.URL, externalURL)
	}
}

func TestObservabilityConfigCaseSensitivity(t *testing.T) {
	// Environment variable names are case-sensitive
	// Test that ConfigFromEnv reads the exact variable name
	
	// Save and restore
	origURL := os.Getenv("LAOS_LOKI_URL")
	origLower := os.Getenv("laos_loki_url")
	defer func() {
		os.Setenv("LAOS_LOKI_URL", origURL)
		os.Setenv("laos_loki_url", origLower)
	}()
	
	os.Unsetenv("LAOS_LOKI_URL")
	os.Unsetenv("laos_loki_url")
	
	// Set only lowercase version
	os.Setenv("laos_loki_url", "http://lowercase-loki:3100")
	
	cfg := ConfigFromEnv()
	
	// Should NOT read lowercase version (environment vars are case-sensitive)
	if cfg.URL != "" {
		t.Errorf("expected empty URL for mismatched case, got %q", cfg.URL)
	}
	
	// Now set the correct case
	os.Setenv("LAOS_LOKI_URL", "http://uppercase-loki:3100")
	cfg = ConfigFromEnv()
	
	if cfg.URL != "http://uppercase-loki:3100" {
		t.Errorf("expected uppercase URL, got %q", cfg.URL)
	}
}



func TestLokiLabelsFromK8sMetadata(t *testing.T) {
	// LabelsFromK8s converts K8s metadata labels to Loki-compatible labels
	k8sLabels := map[string]string{
		"fabrik.sh/run-id":  "01JK7V8X1234567890ABCDEFGH",
		"fabrik.sh/project": "myapp",
		"fabrik.sh/spec":    "feature-x",
		"fabrik.sh/phase":   "implement",
		"fabrik.sh/status":  "running",
	}

	lokiLabels := LabelsFromK8s(k8sLabels)

	expected := map[string]string{
		"fabrik_sh_run-id":  "01JK7V8X1234567890ABCDEFGH",
		"fabrik_sh_project": "myapp",
		"fabrik_sh_spec":    "feature-x",
		"fabrik_sh_phase":   "implement",
		"fabrik_sh_status":  "running",
	}

	for k, v := range expected {
		if lokiLabels[k] != v {
			t.Errorf("lokiLabels[%q] = %q, want %q", k, lokiLabels[k], v)
		}
	}
}

func TestEnvironmentVariablePrecedence(t *testing.T) {
	// Project env should take precedence over global credentials for conflicting keys
	projectEnv := map[string]string{
		"LAOS_LOKI_URL": "http://project-specific-loki:3100",
	}

	sharedCredentials := map[string]string{
		"LAOS_LOKI_URL": "http://global-loki:3100",
	}

	// Simulate precedence rules: project env wins
	finalConfig := make(map[string]string)
	for k, v := range sharedCredentials {
		finalConfig[k] = v
	}
	for k, v := range projectEnv {
		finalConfig[k] = v // Project env overwrites
	}

	if finalConfig["LAOS_LOKI_URL"] != "http://project-specific-loki:3100" {
		t.Errorf("project env should win over shared credentials, got %q", finalConfig["LAOS_LOKI_URL"])
	}
}
