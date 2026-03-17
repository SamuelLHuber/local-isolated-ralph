package run

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecuteLiveDispatchMirrorsSharedCredentialBundle(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(logPath) + "\n" +
		"case \"$*\" in\n" +
		"  *\"-n fabrik-system get secret fabrik-credential-openai-default -o jsonpath={.data}\"*) printf '{\"OPENAI_API_KEY\":\"b2xkLWtleQ==\"}' ;;\n" +
		"  *\"apply -f -\"*) cat >/dev/null ;;\n" +
		"esac\n"
	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := Options{
		RunID:                  "mirror-cred-test",
		Namespace:              "fabrik-runs",
		SharedCredentialSecret: "fabrik-credential-openai-default",
	}
	if err := prepareSharedCredentials(context.Background(), opts); err != nil {
		t.Fatalf("prepareSharedCredentials failed: %v", err)
	}

	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	logText := string(logData)
	if !strings.Contains(logText, "get secret fabrik-credential-openai-default") {
		t.Fatalf("expected source secret lookup, got %s", logText)
	}
	if !strings.Contains(logText, "apply -f -") {
		t.Fatalf("expected mirrored secret apply, got %s", logText)
	}
}

func TestExecuteLiveDispatchCreatesEmptyMirrorForMissingOptionalSharedCredential(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "kubectl.log")
	stdinPath := filepath.Join(dir, "kubectl.stdin")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(logPath) + "\n" +
		"if echo \"$*\" | grep -q -- \"-n fabrik-system get secret fabrik-credentials -o jsonpath={.data} --ignore-not-found\"; then exit 0; fi\n" +
		"if echo \"$*\" | grep -q -- \"apply -f -\"; then cat > " + shellQuote(stdinPath) + "; exit 0; fi\n" +
		"exit 0\n"
	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := Options{
		RunID:     "mirror-optional-empty",
		Namespace: "fabrik-runs",
	}
	if err := prepareSharedCredentials(context.Background(), opts); err != nil {
		t.Fatalf("prepareSharedCredentials failed: %v", err)
	}

	manifest, err := os.ReadFile(stdinPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), "name: fabrik-credentials") {
		t.Fatalf("expected placeholder shared credential secret, got %s", manifest)
	}
	if !strings.Contains(string(manifest), "data: {}") {
		t.Fatalf("expected empty data map for missing optional secret, got %s", manifest)
	}
}

func TestExecuteLiveDispatchUsesRunScopedCredentialOverride(t *testing.T) {
	dir := t.TempDir()
	authDir := filepath.Join(dir, "auth-pool")
	if err := os.MkdirAll(authDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(authDir, "auth.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	logPath := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(logPath) + "\n" +
		"case \"$*\" in\n" +
		"  *\"create secret generic fabrik-credential-run-override --dry-run=client -o yaml --from-file=" + authDir + "\"*) cat <<'EOF'\napiVersion: v1\nkind: Secret\nmetadata:\n  name: fabrik-credential-run-override\n  namespace: fabrik-runs\nEOF\n ;;\n" +
		"  *\"apply -f -\"*) cat >/dev/null ;;\n" +
		"esac\n"
	if err := os.WriteFile(kubectlPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := Options{
		RunID:               "run-override",
		Namespace:           "fabrik-runs",
		SharedCredentialDir: authDir,
	}
	if err := prepareSharedCredentials(context.Background(), opts); err != nil {
		t.Fatalf("prepareSharedCredentials failed: %v", err)
	}

	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	logText := string(logData)
	if strings.Contains(logText, "get secret fabrik-credentials") {
		t.Fatalf("run-scoped override should not look up the cluster default, got %s", logText)
	}
	if !strings.Contains(logText, "create secret generic fabrik-credential-run-override") {
		t.Fatalf("expected run-scoped secret creation, got %s", logText)
	}
}
