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
