package run

import (
	"os"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// L1: Manifest rendering tests for shared credential model
// Spec: 051-k3s-orchestrator.md § Secret classes, § Runtime injection rules
// Todo: #1 — Shared Credential Rotation And Verification
// ---------------------------------------------------------------------------

func TestBuildManifestsWorkflowUsesSharedCredentialsDirectoryMount(t *testing.T) {
	// Per spec 051 and todo #1: shared credentials are mounted as a directory
	// (not subPath) at the shared credential mount path so running jobs can observe
	// replacement files during rotation.

	dir := t.TempDir()
	workflowPath := dir + "/workflow.tsx"
	if err := os.WriteFile(workflowPath, []byte("export default {};"), 0644); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		RunID:              "cred-test-dir-mount",
		SpecPath:           "specs/051-k3s-orchestrator.md",
		Project:            "demo",
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

	// Must have fabrik-credentials volume referencing the right secret.
	if !strings.Contains(yaml, "name: "+sharedCredentialVolume) {
		t.Error("JobYAML missing fabrik-credentials volume name")
	}
	if !strings.Contains(yaml, "secretName: "+sharedCredentialSecretName) {
		t.Error("JobYAML missing fabrik-credentials secretName reference")
	}

	// Must mount as a directory (not subPath).
	if !strings.Contains(yaml, "mountPath: "+sharedCredentialMountPath) {
		t.Errorf("JobYAML missing directory mount at %s", sharedCredentialMountPath)
	}

	// Must NOT use subPath for the credentials mount (required for rotation).
	lines := strings.Split(yaml, "\n")
	for i, line := range lines {
		if strings.Contains(line, sharedCredentialMountPath) {
			// Check the next few lines for subPath — it must not be there.
			for j := i + 1; j < len(lines) && j < i+3; j++ {
				if strings.Contains(lines[j], "subPath:") {
					t.Error("fabrik-credentials mount must NOT use subPath (prevents rotation observation)")
				}
			}
		}
	}

	// Must be read-only.
	// Find the mount section and verify readOnly follows.
	credMountIdx := -1
	for i, line := range lines {
		if strings.Contains(line, "mountPath: "+sharedCredentialMountPath) {
			credMountIdx = i
			break
		}
	}
	if credMountIdx >= 0 {
		foundReadOnly := false
		for j := credMountIdx + 1; j < len(lines) && j < credMountIdx+5; j++ {
			if strings.Contains(lines[j], "readOnly: true") {
				foundReadOnly = true
			}
		}
		if !foundReadOnly {
			t.Error("fabrik-credentials mount missing readOnly: true")
		}
	}
}

func TestBuildManifestsWorkflowDoesNotUseCodexAuthSubPathMounts(t *testing.T) {
	// The old codex-auth subPath mount pattern is replaced by the generic
	// fabrik-credentials directory mount. Verify no codex-auth references remain.

	dir := t.TempDir()
	workflowPath := dir + "/workflow.tsx"
	if err := os.WriteFile(workflowPath, []byte("export default {};"), 0644); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		RunID:              "cred-test-no-codex",
		SpecPath:           "specs/051-k3s-orchestrator.md",
		Project:            "demo",
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

	if strings.Contains(yaml, "codex-auth") {
		t.Error("JobYAML still contains codex-auth references; must use fabrik-credentials")
	}
	if strings.Contains(yaml, ".codex/auth.json") {
		t.Error("JobYAML still mounts .codex/auth.json; must use the shared credential directory")
	}
	if strings.Contains(yaml, ".codex/config.toml") {
		t.Error("JobYAML still mounts .codex/config.toml; must use the shared credential directory")
	}
}

func TestBuildManifestsCommandJobAlsoMountsCredentials(t *testing.T) {
	// Per spec 051 § Secret classes: shared credentials are available to
	// ALL job types, not just workflow-backed runs.

	opts := Options{
		RunID:       "cred-test-cmd-only",
		SpecPath:    "specs/051-k3s-orchestrator.md",
		Project:     "demo",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo hello",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	if !strings.Contains(yaml, sharedCredentialVolume) {
		t.Error("command JobYAML must mount fabrik-credentials")
	}
	if !strings.Contains(yaml, sharedCredentialMountPath) {
		t.Error("command JobYAML must have the shared credential mountPath")
	}
	// Command jobs get optional: true so pods start even without the secret
	if !strings.Contains(yaml, "optional: true") {
		t.Error("command JobYAML should mark fabrik-credentials volume as optional")
	}
}

func TestBuildManifestsCronJobAlsoMountsCredentials(t *testing.T) {
	opts := Options{
		RunID:        "cred-test-cron",
		SpecPath:     "specs/051-k3s-orchestrator.md",
		Project:      "demo",
		Image:        "ghcr.io/fabrik/smithers@sha256:abc123",
		Namespace:    "fabrik-runs",
		PVCSize:      "10Gi",
		JobCommand:   "echo hello",
		WaitTimeout:  "5m",
		CronSchedule: "0 2 * * *",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.CronJobYAML

	if !strings.Contains(yaml, sharedCredentialVolume) {
		t.Error("CronJobYAML must mount fabrik-credentials")
	}
	if !strings.Contains(yaml, sharedCredentialMountPath) {
		t.Error("CronJobYAML must have the shared credential mountPath")
	}
}

func TestBuildManifestsCredentialVolumeIsOptional(t *testing.T) {
	// The credential volume must be optional so pods start even when
	// fabrik-credentials has not been created yet.
	opts := Options{
		RunID:       "cred-test-optional",
		SpecPath:    "specs/051-k3s-orchestrator.md",
		Project:     "demo",
		Image:       "ghcr.io/fabrik/smithers@sha256:abc123",
		Namespace:   "fabrik-runs",
		PVCSize:     "10Gi",
		JobCommand:  "echo hello",
		WaitTimeout: "5m",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	yaml := manifests.JobYAML

	if !strings.Contains(yaml, "optional: true") {
		t.Error("JobYAML credential volume must be optional: true")
	}
}

func TestBuildManifestsCredentialPrecedenceProjectEnvAndCredentials(t *testing.T) {
	// Per spec 051 § Runtime injection rules:
	// 1. Fabrik runtime metadata (SMITHERS_*, FABRIK_*, KUBERNETES_*)
	// 2. Project env secret (fabrik-env-<project>-<env>)
	// 3. Shared credentials (fabrik-credentials) — fallback only
	//
	// Both secrets must be present in the manifest. Project env via envFrom
	// and shared credentials via directory mount only.
	// Project env overrides shared credentials for conflicting keys because
	// envFrom takes precedence over file-mounted values.

	dir := t.TempDir()
	workflowPath := dir + "/workflow.tsx"
	if err := os.WriteFile(workflowPath, []byte("export default {};"), 0644); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		RunID:              "cred-test-precedence",
		SpecPath:           "specs/051-k3s-orchestrator.md",
		Project:            "demo",
		Environment:        "dev",
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

	// Both must be present.
	if !strings.Contains(yaml, "fabrik-env-demo-dev") {
		t.Error("JobYAML missing project env secret reference")
	}
	if !strings.Contains(yaml, sharedCredentialSecretName) {
		t.Error("JobYAML missing shared credentials secret reference")
	}

	// Project env must be injected via envFrom (env var injection).
	if !strings.Contains(yaml, "envFrom:") {
		t.Error("JobYAML missing envFrom for project env")
	}

	// Shared credentials must be a directory mount (file-based injection).
	if !strings.Contains(yaml, "mountPath: "+sharedCredentialMountPath) {
		t.Error("JobYAML missing directory mount for shared credentials")
	}
}

func TestBuildManifestsSharedCredentialSyncScopesRunNamespaceSecretAccess(t *testing.T) {
	opts := Options{
		RunID:                       "cred-sync-rbac",
		SpecPath:                    "specs/051-k3s-orchestrator.md",
		Project:                     "demo",
		Image:                       "ghcr.io/fabrik/smithers@sha256:abc123",
		Namespace:                   "fabrik-runs",
		PVCSize:                     "10Gi",
		JobCommand:                  "echo hello",
		WaitTimeout:                 "5m",
		SharedCredentialSecret:      "fabrik-credential-codex-default",
		SharedCredentialHelperImage: "repo/helper:dev",
	}

	manifests, err := BuildManifests(opts)
	if err != nil {
		t.Fatalf("BuildManifests failed: %v", err)
	}

	if !strings.Contains(manifests.RoleYAML, "resourceNames: [\"fabrik-credential-codex-default\"]") {
		t.Fatalf("expected run namespace secret RBAC to be scoped to the selected secret, got %s", manifests.RoleYAML)
	}
	if strings.Contains(manifests.RoleYAML, "verbs: [\"create\", \"get\", \"patch\", \"update\"]") {
		t.Fatalf("expected shared credential sync RBAC to avoid broad secret create, got %s", manifests.RoleYAML)
	}
}
