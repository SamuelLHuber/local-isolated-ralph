package run

import (
	"strings"
	"testing"
)

func TestResolveSharedCredentialBundleSelectsClusterDefault(t *testing.T) {
	bundle, err := resolveSharedCredentialBundle(Options{RunID: "demo-run"})
	if err != nil {
		t.Fatalf("resolveSharedCredentialBundle failed: %v", err)
	}
	if bundle.SecretName != sharedCredentialDefaultSecretName {
		t.Fatalf("expected default shared credential secret %q, got %q", sharedCredentialDefaultSecretName, bundle.SecretName)
	}
	if !bundle.Optional {
		t.Fatalf("expected default shared credential bundle to be optional")
	}
	if bundle.MountPath != sharedCredentialMountPath {
		t.Fatalf("expected mount path %q, got %q", sharedCredentialMountPath, bundle.MountPath)
	}
}

func TestResolveSharedCredentialBundleOverrideSuppressesDefault(t *testing.T) {
	bundle, err := resolveSharedCredentialBundle(Options{
		RunID:                  "demo-run",
		SharedCredentialSecret: "fabrik-credential-codex-default",
	})
	if err != nil {
		t.Fatalf("resolveSharedCredentialBundle failed: %v", err)
	}
	if bundle.SecretName != "fabrik-credential-codex-default" {
		t.Fatalf("expected explicit shared credential secret, got %q", bundle.SecretName)
	}
	if bundle.Optional {
		t.Fatalf("explicit shared credential secret should not be optional")
	}
	if bundle.SourceKind != "secret" {
		t.Fatalf("expected source kind secret, got %q", bundle.SourceKind)
	}
}

func TestResolveSharedCredentialBundleUsesRunScopedSecretForLocalOverride(t *testing.T) {
	bundle, err := resolveSharedCredentialBundle(Options{
		RunID:                "demo-run",
		SharedCredentialFile: "/tmp/auth.json",
	})
	if err != nil {
		t.Fatalf("resolveSharedCredentialBundle failed: %v", err)
	}
	if bundle.SecretName == sharedCredentialDefaultSecretName {
		t.Fatalf("local override must not reuse the default secret name")
	}
	if !strings.HasPrefix(bundle.SecretName, "fabrik-credential-") {
		t.Fatalf("expected run-scoped credential secret name, got %q", bundle.SecretName)
	}
	if bundle.SourceKind != "file" {
		t.Fatalf("expected source kind file, got %q", bundle.SourceKind)
	}
}

func TestResolveSharedCredentialBundleSupportsDisable(t *testing.T) {
	bundle, err := resolveSharedCredentialBundle(Options{
		RunID:                    "demo-run",
		DisableSharedCredentials: true,
	})
	if err != nil {
		t.Fatalf("resolveSharedCredentialBundle failed: %v", err)
	}
	if bundle.SecretName != "" {
		t.Fatalf("expected disabled shared credentials to resolve to empty bundle, got %q", bundle.SecretName)
	}
}

func TestBuildSharedCredentialSyncCommandFailsAfterRepeatedErrors(t *testing.T) {
	cmd := buildSharedCredentialSyncCommand(sharedCredentialBundle{
		SecretName: "fabrik-credentials",
		Optional:   true,
		SourceKind: "default",
	})
	if !strings.Contains(cmd, "MAX_FAILURES="+sharedCredentialSyncMaxFailures) {
		t.Fatalf("expected sync command to include max failure threshold, got %s", cmd)
	}
	if !strings.Contains(cmd, "shared credential sync failed during initial reconcile") {
		t.Fatalf("expected sync command to fail loudly on initial reconcile error, got %s", cmd)
	}
	if !strings.Contains(cmd, "shared credential sync failed (${failure_count}/${MAX_FAILURES})") {
		t.Fatalf("expected sync command to emit repeated failure logs, got %s", cmd)
	}
	if !strings.Contains(cmd, "replace -f \"$MANIFEST_FILE\"") {
		t.Fatalf("expected sync command to replace rendered secret manifests, got %s", cmd)
	}
}
