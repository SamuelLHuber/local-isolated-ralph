package observability

import (
	"fmt"
	"os"
	"strings"
)

// LokiConfig holds Loki observability configuration for a Fabrik run.
// Configuration is sourced from environment variables injected via the
// project env secret (fabrik-env-<project>-<env>).
type LokiConfig struct {
	// URL is the Loki endpoint for log ingestion (LAOS_LOKI_URL)
	URL string
	// ServiceName identifies the service in Loki labels
	ServiceName string
}

// ConfigFromEnv creates a LokiConfig from environment variables.
// It reads LAOS_LOKI_URL from the environment.
func ConfigFromEnv() LokiConfig {
	return LokiConfig{
		URL:         os.Getenv("LAOS_LOKI_URL"),
		ServiceName: os.Getenv("SMITHERS_PROJECT"),
	}
}

// IsConfigured returns true if Loki URL is configured.
func (c LokiConfig) IsConfigured() bool {
	return strings.TrimSpace(c.URL) != ""
}

// Validate returns an error if the configuration is invalid.
func (c LokiConfig) Validate() error {
	if !c.IsConfigured() {
		return nil // Loki is optional
	}
	if !strings.HasPrefix(c.URL, "http://") && !strings.HasPrefix(c.URL, "https://") {
		return fmt.Errorf("invalid LAOS_LOKI_URL: must start with http:// or https://, got %q", c.URL)
	}
	return nil
}

// Labels returns the static labels that should be attached to all log streams.
// These labels are derived from the shared metadata schema and are stable,
// index-friendly, and suitable for Loki indexing.
func Labels(runID, project, spec, phase string) map[string]string {
	labels := map[string]string{
		"fabrik_run_id": runID,
		"project":       project,
		"spec":          spec,
	}
	if strings.TrimSpace(phase) != "" {
		labels["phase"] = phase
	}
	return labels
}

// LabelKeys returns the ordered list of label keys for consistent output.
// The order is: fabrik_run_id, project, spec, phase (when present)
func LabelKeys(phase string) []string {
	keys := []string{"fabrik_run_id", "project", "spec"}
	if strings.TrimSpace(phase) != "" {
		keys = append(keys, "phase")
	}
	return keys
}

// ReservedLabelPrefixes returns prefixes that cannot be used for custom labels
// to avoid collision with Fabrik's metadata schema.
func ReservedLabelPrefixes() []string {
	return []string{"fabrik_", "smithers_"}
}

// IsReservedLabel returns true if the label key is reserved for Fabrik internal use.
func IsReservedLabel(key string) bool {
	lower := strings.ToLower(key)
	for _, prefix := range ReservedLabelPrefixes() {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

// SanitizeLabelValue sanitizes a value for use as a Loki label.
// Loki label values must be valid UTF-8 strings without unescaped quotes.
func SanitizeLabelValue(value string) string {
	// Replace newlines and control characters
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\t", " ")
	// Trim spaces
	return strings.TrimSpace(value)
}

// LabelsFromK8s converts Kubernetes metadata labels to Loki-compatible labels.
// K8s labels use the format "fabrik.sh/X" which is converted to "fabrik_sh_X"
// for Loki indexing. Only labels matching the reserved prefixes are converted.
func LabelsFromK8s(k8sLabels map[string]string) map[string]string {
	lokiLabels := make(map[string]string)
	for k, v := range k8sLabels {
		// Only convert labels with reserved Fabrik prefixes
		if strings.HasPrefix(k, "fabrik.sh/") || strings.HasPrefix(k, "smithers.sh/") {
			// Convert K8s label format (fabrik.sh/X) to Loki format (fabrik_sh_X)
			lokiKey := strings.ReplaceAll(strings.ReplaceAll(k, ".", "_"), "/", "_")
			lokiLabels[lokiKey] = v
		}
	}
	return lokiLabels
}

// LabelsWithOutcome returns labels including the outcome for completed runs.
// Outcome is only added if non-empty (succeeded, failed, cancelled).
// This is useful for querying logs of finished jobs.
func LabelsWithOutcome(runID, project, spec, phase, outcome string) map[string]string {
	labels := Labels(runID, project, spec, phase)
	if strings.TrimSpace(outcome) != "" {
		labels["outcome"] = outcome
	}
	return labels
}

// LabelKeysWithOutcome returns the ordered list of label keys including outcome.
// The order is: fabrik_run_id, project, spec, phase (when present), outcome (when present)
func LabelKeysWithOutcome(phase, outcome string) []string {
	keys := LabelKeys(phase)
	if strings.TrimSpace(outcome) != "" {
		keys = append(keys, "outcome")
	}
	return keys
}

// LokiQueryForRun returns a LogQL query string to filter logs by run ID.
// This produces a query like: {fabrik_run_id="01JK7V8X..."}
func LokiQueryForRun(runID string) string {
	return fmt.Sprintf(`{fabrik_run_id=%q}`, runID)
}

// LokiQueryForProject returns a LogQL query string to filter logs by project.
// This produces a query like: {project="myapp"}
func LokiQueryForProject(project string) string {
	return fmt.Sprintf(`{project=%q}`, project)
}

// LokiQueryForProjectPhase returns a LogQL query string to filter logs by project and phase.
// This produces a query like: {project="myapp",phase="implement"}
func LokiQueryForProjectPhase(project, phase string) string {
	return fmt.Sprintf(`{project=%q,phase=%q}`, project, phase)
}

// LokiQueryForOutcome returns a LogQL query string to filter logs by outcome.
// This produces a query like: {outcome="succeeded"}
func LokiQueryForOutcome(outcome string) string {
	return fmt.Sprintf(`{outcome=%q}`, outcome)
}
