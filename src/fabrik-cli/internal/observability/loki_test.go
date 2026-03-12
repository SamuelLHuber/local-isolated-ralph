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

func TestLabelsFromK8sConvertsFabrikLabels(t *testing.T) {
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

	if len(lokiLabels) != len(expected) {
		t.Errorf("expected %d labels, got %d", len(expected), len(lokiLabels))
	}

	for k, v := range expected {
		if lokiLabels[k] != v {
			t.Errorf("lokiLabels[%q] = %q, want %q", k, lokiLabels[k], v)
		}
	}
}

func TestLabelsFromK8sIgnoresNonFabrikLabels(t *testing.T) {
	k8sLabels := map[string]string{
		"fabrik.sh/run-id": "01JK7V8X1234567890ABCDEFGH",
		"app.kubernetes.io/name": "smithers",
		"helm.sh/chart": "fabrik-1.0.0",
		"custom-label": "custom-value",
	}

	lokiLabels := LabelsFromK8s(k8sLabels)

	// Should only include fabrik.sh labels
	if len(lokiLabels) != 1 {
		t.Errorf("expected 1 label, got %d: %v", len(lokiLabels), lokiLabels)
	}

	if _, exists := lokiLabels["fabrik_sh_run-id"]; !exists {
		t.Error("expected fabrik_sh_run-id to be present")
	}

	// These should not be present
	if _, exists := lokiLabels["app_kubernetes_io_name"]; exists {
		t.Error("expected app.kubernetes.io/name to be ignored")
	}
}

func TestLabelsFromK8sHandlesEmpty(t *testing.T) {
	lokiLabels := LabelsFromK8s(map[string]string{})

	if len(lokiLabels) != 0 {
		t.Errorf("expected 0 labels for empty input, got %d", len(lokiLabels))
	}
}

func TestLabelsFromK8sHandlesSmithersLabels(t *testing.T) {
	k8sLabels := map[string]string{
		"smithers.sh/version": "1.2.3",
		"smithers.sh/task":    "16:impl",
	}

	lokiLabels := LabelsFromK8s(k8sLabels)

	if len(lokiLabels) != 2 {
		t.Errorf("expected 2 labels, got %d", len(lokiLabels))
	}

	if lokiLabels["smithers_sh_version"] != "1.2.3" {
		t.Errorf("expected smithers_sh_version = '1.2.3', got %q", lokiLabels["smithers_sh_version"])
	}
}

func TestLabelsWithOutcomeIncludesOutcome(t *testing.T) {
	labels := LabelsWithOutcome("01JK7V8X1234567890ABCDEFGH", "myapp", "feature-x", "implement", "succeeded")

	expected := map[string]string{
		"fabrik_run_id": "01JK7V8X1234567890ABCDEFGH",
		"project":       "myapp",
		"spec":          "feature-x",
		"phase":         "implement",
		"outcome":       "succeeded",
	}

	for k, v := range expected {
		if labels[k] != v {
			t.Errorf("labels[%q] = %q, want %q", k, labels[k], v)
		}
	}

	if len(labels) != 5 {
		t.Errorf("expected 5 labels, got %d: %v", len(labels), labels)
	}
}

func TestLabelsWithOutcomeOmitsEmptyOutcome(t *testing.T) {
	// Empty outcome should not be included
	labels := LabelsWithOutcome("01JK7V8X1234567890ABCDEFGH", "myapp", "feature-x", "implement", "")

	if _, exists := labels["outcome"]; exists {
		t.Error("expected outcome label to be omitted when empty")
	}

	if len(labels) != 4 {
		t.Errorf("expected 4 labels (no outcome), got %d: %v", len(labels), labels)
	}
}

func TestLabelsWithOutcomeOmitsWhitespaceOutcome(t *testing.T) {
	// Whitespace-only outcome should not be included
	labels := LabelsWithOutcome("01JK7V8X1234567890ABCDEFGH", "myapp", "feature-x", "implement", "   ")

	if _, exists := labels["outcome"]; exists {
		t.Error("expected outcome label to be omitted when whitespace")
	}
}

func TestLabelKeysWithOutcomeIncludesOutcome(t *testing.T) {
	keys := LabelKeysWithOutcome("implement", "succeeded")
	expected := []string{"fabrik_run_id", "project", "spec", "phase", "outcome"}

	if len(keys) != len(expected) {
		t.Fatalf("expected %d keys, got %d: %v", len(expected), len(keys), keys)
	}

	for i, want := range expected {
		if keys[i] != want {
			t.Errorf("keys[%d] = %q, want %q", i, keys[i], want)
		}
	}
}

func TestLabelKeysWithOutcomeOmitsEmptyOutcome(t *testing.T) {
	keys := LabelKeysWithOutcome("implement", "")
	expected := []string{"fabrik_run_id", "project", "spec", "phase"}

	if len(keys) != len(expected) {
		t.Fatalf("expected %d keys, got %d: %v", len(expected), len(keys), keys)
	}
}

func TestLokiQueryForRun(t *testing.T) {
	query := LokiQueryForRun("01JK7V8X1234567890ABCDEFGH")
	expected := `{fabrik_run_id="01JK7V8X1234567890ABCDEFGH"}`

	if query != expected {
		t.Errorf("LokiQueryForRun() = %q, want %q", query, expected)
	}
}

func TestLokiQueryForProject(t *testing.T) {
	query := LokiQueryForProject("myapp")
	expected := `{project="myapp"}`

	if query != expected {
		t.Errorf("LokiQueryForProject() = %q, want %q", query, expected)
	}
}

func TestLokiQueryForProjectPhase(t *testing.T) {
	query := LokiQueryForProjectPhase("myapp", "implement")
	expected := `{project="myapp",phase="implement"}`

	if query != expected {
		t.Errorf("LokiQueryForProjectPhase() = %q, want %q", query, expected)
	}
}

func TestLokiQueryForOutcome(t *testing.T) {
	query := LokiQueryForOutcome("succeeded")
	expected := `{outcome="succeeded"}`

	if query != expected {
		t.Errorf("LokiQueryForOutcome() = %q, want %q", query, expected)
	}
}
