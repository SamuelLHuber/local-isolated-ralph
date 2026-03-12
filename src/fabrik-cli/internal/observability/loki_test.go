package observability

import (
	"os"
	"strings"
	"testing"
)

func TestConfigFromEnvReadsLAOSLOKIURL(t *testing.T) {
	// Save and restore original env
	origURL := os.Getenv("LAOS_LOKI_URL")
	origProject := os.Getenv("SMITHERS_PROJECT")
	defer func() {
		os.Setenv("LAOS_LOKI_URL", origURL)
		os.Setenv("SMITHERS_PROJECT", origProject)
	}()

	os.Setenv("LAOS_LOKI_URL", "http://loki.monitoring.svc:3100")
	os.Setenv("SMITHERS_PROJECT", "myapp")

	cfg := ConfigFromEnv()
	if cfg.URL != "http://loki.monitoring.svc:3100" {
		t.Errorf("expected URL http://loki.monitoring.svc:3100, got %q", cfg.URL)
	}
	if cfg.ServiceName != "myapp" {
		t.Errorf("expected ServiceName myapp, got %q", cfg.ServiceName)
	}
}

func TestConfigFromEnvHandlesEmpty(t *testing.T) {
	// Save and restore original env
	origURL := os.Getenv("LAOS_LOKI_URL")
	origProject := os.Getenv("SMITHERS_PROJECT")
	defer func() {
		os.Setenv("LAOS_LOKI_URL", origURL)
		os.Setenv("SMITHERS_PROJECT", origProject)
	}()

	os.Unsetenv("LAOS_LOKI_URL")
	os.Unsetenv("SMITHERS_PROJECT")

	cfg := ConfigFromEnv()
	if cfg.URL != "" {
		t.Errorf("expected empty URL, got %q", cfg.URL)
	}
	if cfg.IsConfigured() {
		t.Error("expected IsConfigured=false when URL is empty")
	}
}

func TestLokiConfigIsConfigured(t *testing.T) {
	tests := []struct {
		name      string
		url       string
		configured bool
	}{
		{"empty", "", false},
		{"whitespace", "   ", false},
		{"http URL", "http://loki:3100", true},
		{"https URL", "https://loki.example.com", true},
		{"with path", "http://loki:3100/loki/api/v1/push", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := LokiConfig{URL: tt.url}
			if cfg.IsConfigured() != tt.configured {
				t.Errorf("IsConfigured() = %v, want %v", cfg.IsConfigured(), tt.configured)
			}
		})
	}
}

func TestLokiConfigValidate(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantErr bool
		errMsg  string
	}{
		{"empty", "", false, ""},
		{"valid http", "http://loki:3100", false, ""},
		{"valid https", "https://loki.example.com", false, ""},
		{"invalid scheme", "tcp://loki:3100", true, "http:// or https://"},
		{"no scheme", "loki:3100", true, "http:// or https://"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := LokiConfig{URL: tt.url}
			err := cfg.Validate()
			if tt.wantErr {
				if err == nil {
					t.Errorf("expected error, got nil")
				} else if tt.errMsg != "" && !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("expected error containing %q, got %q", tt.errMsg, err.Error())
				}
			} else {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			}
		})
	}
}

func TestLabelsReturnsStableIndexFriendlyLabels(t *testing.T) {
	labels := Labels("01JK7V8X1234567890ABCDEFGH", "myapp", "feature-x", "implement")

	// Required labels must be present
	required := map[string]string{
		"fabrik_run_id": "01JK7V8X1234567890ABCDEFGH",
		"project":       "myapp",
		"spec":          "feature-x",
		"phase":         "implement",
	}

	for key, expected := range required {
		if labels[key] != expected {
			t.Errorf("labels[%q] = %q, want %q", key, labels[key], expected)
		}
	}

	// Must have exactly 4 labels
	if len(labels) != 4 {
		t.Errorf("expected 4 labels, got %d: %v", len(labels), labels)
	}
}

func TestLabelsOmitsPhaseWhenEmpty(t *testing.T) {
	labels := Labels("01JK7V8X1234567890ABCDEFGH", "myapp", "feature-x", "")

	if _, exists := labels["phase"]; exists {
		t.Error("expected phase label to be omitted when empty")
	}

	if len(labels) != 3 {
		t.Errorf("expected 3 labels (no phase), got %d: %v", len(labels), labels)
	}
}

func TestLabelsOmitsPhaseWhenWhitespace(t *testing.T) {
	labels := Labels("01JK7V8X1234567890ABCDEFGH", "myapp", "feature-x", "   ")

	if _, exists := labels["phase"]; exists {
		t.Error("expected phase label to be omitted when whitespace")
	}
}

func TestLabelKeysReturnsConsistentOrder(t *testing.T) {
	// With phase
	keys := LabelKeys("implement")
	expected := []string{"fabrik_run_id", "project", "spec", "phase"}
	if len(keys) != len(expected) {
		t.Fatalf("expected %d keys, got %d", len(expected), len(keys))
	}
	for i, want := range expected {
		if keys[i] != want {
			t.Errorf("keys[%d] = %q, want %q", i, keys[i], want)
		}
	}

	// Without phase
	keysNoPhase := LabelKeys("")
	expectedNoPhase := []string{"fabrik_run_id", "project", "spec"}
	if len(keysNoPhase) != len(expectedNoPhase) {
		t.Fatalf("expected %d keys, got %d", len(expectedNoPhase), len(keysNoPhase))
	}
	for i, want := range expectedNoPhase {
		if keysNoPhase[i] != want {
			t.Errorf("keysNoPhase[%d] = %q, want %q", i, keysNoPhase[i], want)
		}
	}
}

func TestReservedLabelPrefixes(t *testing.T) {
	prefixes := ReservedLabelPrefixes()
	expected := []string{"fabrik_", "smithers_"}

	if len(prefixes) != len(expected) {
		t.Fatalf("expected %d prefixes, got %d", len(expected), len(prefixes))
	}
	for i, want := range expected {
		if prefixes[i] != want {
			t.Errorf("prefixes[%d] = %q, want %q", i, prefixes[i], want)
		}
	}
}

func TestIsReservedLabel(t *testing.T) {
	tests := []struct {
		key      string
		reserved bool
	}{
		{"fabrik_run_id", true},
		{"FABRIK_RUN_ID", true},  // case insensitive
		{"smithers_project", true},
		{"SMITHERS_PROJECT", true},  // case insensitive
		{"project", false},
		{"custom_label", false},
		{"phase", false},
		{"outcome", false},
	}

	for _, tt := range tests {
		t.Run(tt.key, func(t *testing.T) {
			if IsReservedLabel(tt.key) != tt.reserved {
				t.Errorf("IsReservedLabel(%q) = %v, want %v", tt.key, !tt.reserved, tt.reserved)
			}
		})
	}
}

func TestSanitizeLabelValue(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"simple", "simple"},
		{"with spaces  ", "with spaces"},
		{"with\nnewlines", "with newlines"},
		{"with\r\rreturns", "with  returns"},
		{"with\ttabs", "with tabs"},
		{"  surrounded  ", "surrounded"},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := SanitizeLabelValue(tt.input)
			if got != tt.expected {
				t.Errorf("SanitizeLabelValue(%q) = %q, want %q", tt.input, got, tt.expected)
			}
		})
	}
}

func TestLabelsAreIndexFriendly(t *testing.T) {
	// Loki labels should be stable and have low cardinality for indexing
	// Run ID is unique but necessary for traceability
	// Project and spec have bounded cardinality
	// Phase has a fixed set of values
	labels := Labels("run-123", "myproject", "myspec", "implement")

	// All values should be non-empty
	for k, v := range labels {
		if strings.TrimSpace(v) == "" {
			t.Errorf("label %q has empty value", k)
		}
	}

	// Label keys should not contain spaces or special characters
	for k := range labels {
		if strings.ContainsAny(k, " \t\n!@#$%^&*()[]{}+=\\|/?<>,~`\"'") {
			t.Errorf("label key %q contains special characters", k)
		}
	}
}
