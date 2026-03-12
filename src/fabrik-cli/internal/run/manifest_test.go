package run

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestBuildManifestsIncludesRequiredMetadataLabels(t *testing.T) {
	opts := Options{
		RunID:       "01JK7V8X1234567890ABCDEFGH",
		SpecPath:    "specs/feature-x.yaml",
		Project:     "myapp",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123def456",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo test",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	// Required labels per shared metadata schema (values are quoted in YAML)
	requiredLabels := map[string]string{
		"fabrik.sh/run-id":  `"01JK7V8X1234567890ABCDEFGH"`,
		"fabrik.sh/spec":    `"feature-x"`,
		"fabrik.sh/project": `"myapp"`,
		"fabrik.sh/phase":   `"run"`,
		"fabrik.sh/status":  `"running"`,
		"fabrik.sh/task":    `"dispatch"`,
		"fabrik.sh/managed-by": `"fabrik"`,
	}

	for key, value := range requiredLabels {
		expected := key + ": " + value
		if !strings.Contains(yaml, expected) {
			t.Errorf("JobYAML missing required label %q: expected %q", key, expected)
		}
	}
}

func TestBuildManifestsIncludesRequiredMetadataAnnotations(t *testing.T) {
	opts := Options{
		RunID:       "01JK7V8X1234567890ABCDEFGH",
		SpecPath:    "specs/feature-x.yaml",
		Project:     "myapp",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123def456",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo test",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	// Required annotations per shared metadata schema
	requiredAnnotations := []string{
		"fabrik.sh/status:",
		"fabrik.sh/started-at:",
		"fabrik.sh/finished-at:",
		"fabrik.sh/outcome:",
		"fabrik.sh/progress:",
	}

	for _, key := range requiredAnnotations {
		if !strings.Contains(yaml, key) {
			t.Errorf("JobYAML missing required annotation %q", key)
		}
	}
}

func TestBuildManifestsStatusAnnotationContainsPhaseAndTask(t *testing.T) {
	opts := Options{
		RunID:       "01JK7V8X1234567890ABCDEFGH",
		SpecPath:    "specs/feature-x.yaml",
		Project:     "myapp",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123def456",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo test",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	// Status annotation should be valid JSON with required fields (embedded in YAML string)
	// The JSON is escaped within the YAML string value
	if !strings.Contains(yaml, `"phase":"run"`) && !strings.Contains(yaml, `\"phase\":\"run\"`) {
		t.Error("status annotation missing phase field")
	}
	if !strings.Contains(yaml, `"current_task":"dispatch"`) && !strings.Contains(yaml, `\"current_task\":\"dispatch\"`) {
		t.Error("status annotation missing current_task field")
	}
	if !strings.Contains(yaml, `"attempt":1`) && !strings.Contains(yaml, `\"attempt\":1`) {
		t.Error("status annotation missing attempt field")
	}
	if !strings.Contains(yaml, `"progress":`) && !strings.Contains(yaml, `\"progress\"`) {
		t.Error("status annotation missing progress field")
	}
}

func TestBuildManifestsProgressAnnotationContainsFinishedAndTotal(t *testing.T) {
	opts := Options{
		RunID:       "01JK7V8X1234567890ABCDEFGH",
		SpecPath:    "specs/feature-x.yaml",
		Project:     "myapp",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123def456",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo test",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	// Progress annotation should be valid JSON (may be escaped in YAML string)
	if !strings.Contains(yaml, `"finished":0`) && !strings.Contains(yaml, `\"finished\":0`) {
		t.Error("progress annotation missing or incorrect finished value")
	}
	if !strings.Contains(yaml, `"total":1`) && !strings.Contains(yaml, `\"total\":1`) {
		t.Error("progress annotation missing or incorrect total value")
	}
}

func TestBuildManifestsLabelsAreLokiCompatible(t *testing.T) {
	opts := Options{
		RunID:       "01JK7V8X1234567890ABCDEFGH",
		SpecPath:    "specs/feature-x.yaml",
		Project:     "myapp",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123def456",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo test",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	// Labels must use lowercase alphanumeric and hyphens (DNS-1123 style)
	// This ensures they can be used as Loki labels
	lokiCompatibleLabels := []string{
		"fabrik.sh/run-id",
		"fabrik.sh/spec",
		"fabrik.sh/project",
		"fabrik.sh/phase",
		"fabrik.sh/status",
		"fabrik.sh/task",
		"fabrik.sh/managed-by",
	}

	for _, label := range lokiCompatibleLabels {
		if !strings.Contains(yaml, label) {
			t.Errorf("JobYAML missing Loki-compatible label %q", label)
		}
	}
}

func TestBuildManifestsPVCHasMetadataLabels(t *testing.T) {
	opts := Options{
		RunID:       "01JK7V8X1234567890ABCDEFGH",
		SpecPath:    "specs/feature-x.yaml",
		Project:     "myapp",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123def456",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo test",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.PVCYAML

	// PVC should have the same labels as the job for correlation
	requiredLabels := []string{
		"fabrik.sh/run-id:",
		"fabrik.sh/spec:",
		"fabrik.sh/project:",
		"fabrik.sh/phase:",
		"fabrik.sh/status:",
		"fabrik.sh/task:",
		"fabrik.sh/managed-by:",
	}

	for _, label := range requiredLabels {
		if !strings.Contains(yaml, label) {
			t.Errorf("PVCYAML missing required label prefix %q", label)
		}
	}
}

func TestBuildManifestsCronJobIncludesRequiredLabels(t *testing.T) {
	opts := Options{
		RunID:        "01JK7V8XCRON1234567890ABCD",
		SpecPath:     "specs/nightly.yaml",
		Project:      "myapp",
		Image:        "ghcr.io/fabrik/smithers@sha256:abc123def456",
		Namespace:    "fabrik-runs",
		PVCSize:      "10Gi",
		JobCommand:   "echo test",
		WaitTimeout:  "5m",
		CronSchedule: "0 2 * * *",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.CronJobYAML

	// CronJob should have required labels
	requiredLabels := []string{
		"fabrik.sh/run-id:",
		"fabrik.sh/spec:",
		"fabrik.sh/project:",
		"fabrik.sh/managed-by:",
	}

	for _, label := range requiredLabels {
		if !strings.Contains(yaml, label) {
			t.Errorf("CronJobYAML missing required label %q", label)
		}
	}
}

func TestBuildManifestsCronJobIncludesScheduleAnnotation(t *testing.T) {
	opts := Options{
		RunID:        "01JK7V8XCRON1234567890ABCD",
		SpecPath:     "specs/nightly.yaml",
		Project:      "myapp",
		Image:        "ghcr.io/fabrik/smithers@sha256:abc123def456",
		Namespace:    "fabrik-runs",
		PVCSize:      "10Gi",
		JobCommand:   "echo test",
		WaitTimeout:  "5m",
		CronSchedule: "0 2 * * *",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.CronJobYAML

	// CronJob should have schedule annotation
	if !strings.Contains(yaml, "fabrik.sh/cron-schedule:") {
		t.Error("CronJobYAML missing cron-schedule annotation")
	}
	if !strings.Contains(yaml, "0 2 * * *") {
		t.Error("CronJobYAML missing or incorrect schedule value")
	}
}

func TestBuildManifestsPodTemplateInheritsLabelsAndAnnotations(t *testing.T) {
	opts := Options{
		RunID:       "01JK7V8X1234567890ABCDEFGH",
		SpecPath:    "specs/feature-x.yaml",
		Project:     "myapp",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123def456",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo test",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	// Pod template should have labels section under template.metadata
	if !strings.Contains(yaml, "template:") {
		t.Error("JobYAML missing template section")
	}

	// Check that pod template inherits the labels
	// The YAML structure should be: template -> metadata -> labels
	lines := strings.Split(yaml, "\n")
	inTemplate := false
	inTemplateMetadata := false
	foundTemplateLabels := false

	for _, line := range lines {
		if strings.HasPrefix(line, "  template:") {
			inTemplate = true
			continue
		}
		if inTemplate && strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "    ") {
			// Exited template section
			inTemplate = false
			inTemplateMetadata = false
		}
		if inTemplate && strings.Contains(line, "metadata:") {
			inTemplateMetadata = true
			continue
		}
		if inTemplate && inTemplateMetadata && strings.Contains(line, "labels:") {
			foundTemplateLabels = true
			break
		}
	}

	if !foundTemplateLabels {
		t.Error("Pod template metadata missing labels section")
	}
}

func TestBuildManifestsSpecLabelUsesFileNameWithoutExtension(t *testing.T) {
	tests := []struct {
		specPath string
		expected string
	}{
		{"specs/feature-x.yaml", "feature-x"},
		{"specs/my-feature.json", "my-feature"},
		{"/absolute/path/to/specs/nightly.yaml", "nightly"},
		{"relative/path/to/specs/demo.yml", "demo"},
	}

	for _, tt := range tests {
		t.Run(tt.specPath, func(t *testing.T) {
			opts := Options{
				RunID:       "01JK7V8X1234567890ABCDEFGH",
				SpecPath:    tt.specPath,
				Project:     "myapp",
				Image:       "ghcr.io/fabrik/smithers@sha256:abc123",
				Namespace:   "fabrik-runs",
				PVCSize:     "10Gi",
				JobCommand:  "echo test",
				WaitTimeout: "5m",
			}

			manifests, err := BuildManifests(opts)
			if err != nil {
				t.Fatalf("BuildManifests failed: %v", err)
			}

			expected := "fabrik.sh/spec: " + strconv.Quote(tt.expected)
			if !strings.Contains(manifests.JobYAML, expected) {
				t.Errorf("expected spec label %q in JobYAML, got YAML:\n%s", expected, manifests.JobYAML)
			}
		})
	}
}

func TestBuildManifestsProjectLabelIsDNS1123Compliant(t *testing.T) {
	opts := Options{
		RunID:       "01JK7V8X1234567890ABCDEFGH",
		SpecPath:    "specs/feature-x.yaml",
		Project:     "my-awesome-project-123",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo test",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	expected := "fabrik.sh/project: " + strconv.Quote("my-awesome-project-123")
	if !strings.Contains(manifests.JobYAML, expected) {
		t.Errorf("expected project label %q in JobYAML", expected)
	}
}

func TestBuildManifestsWorkflowIncludesAdditionalAnnotations(t *testing.T) {
	dir := t.TempDir()
	workflowPath := dir + "/workflow.tsx"
	if err := os.WriteFile(workflowPath, []byte("export default {};"), 0644); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		RunID:              "01JK7V8XWF1234567890ABCDEFGH",
		SpecPath:           "specs/feature-x.yaml",
		Project:            "myapp",
		Image:              "ghcr.io/fabrik/smithers@sha256:abc123",
		Namespace:          "fabrik-runs",
		PVCSize:            "10Gi",
		WaitTimeout:        "5m",
		WorkflowPath:       workflowPath,
		WorkflowBundle:     &WorkflowBundle{WorkdirPath: "workflow.tsx", ArchiveBase64: "e30="},
		AcceptFilteredSync: true,
		InputJSON:          "{}",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	// Workflow runs should include workflow-path annotation
	if !strings.Contains(yaml, "fabrik.sh/workflow-path:") {
		t.Error("JobYAML missing workflow-path annotation for workflow runs")
	}
}

func TestBuildManifestsProjectEnvIncludesLAOSConfig(t *testing.T) {
	// Test that project env secret is mounted and can provide LAOS_LOKI_URL
	opts := Options{
		RunID:         "01JK7V8X1234567890ABCDEFGH",
		SpecPath:      "specs/feature-x.yaml",
		Project:       "myapp",
		Environment:   "dev",
		Image:         "ghcr.io/fabrik/smithers@sha256:abc123",
		Namespace:     "fabrik-runs",
		PVCSize:       "10Gi",
		JobCommand:    "echo test",
		WaitTimeout:   "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	// Verify project env secret reference exists
	expectedSecretRef := "secretName: fabrik-env-myapp-dev"
	if !strings.Contains(yaml, expectedSecretRef) {
		t.Errorf("JobYAML missing project env secret reference %q", expectedSecretRef)
	}

	// Verify envFrom section exists for project env injection
	if !strings.Contains(yaml, "envFrom:") {
		t.Error("JobYAML missing envFrom for project env secret")
	}

	// Verify project env mount exists at /etc/fabrik/env
	if !strings.Contains(yaml, "mountPath: /etc/fabrik/env") {
		t.Error("JobYAML missing project env mount at /etc/fabrik/env")
	}

	// Verify the secret volume is mounted read-only
	if !strings.Contains(yaml, "readOnly: true") {
		t.Error("JobYAML missing readOnly: true for project env secret mount")
	}
}


