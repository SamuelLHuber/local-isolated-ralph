package run

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResumeRunRequiresRunID(t *testing.T) {
	var out bytes.Buffer
	var errOut bytes.Buffer

	opts := ResumeOptions{
		Namespace:   "fabrik-runs",
		KubeContext: "",
		RunID:       "",
	}

	err := ResumeRun(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected error for missing run-id")
	}
	if !strings.Contains(err.Error(), "missing required flag: --id") {
		t.Fatalf("expected missing --id error, got: %v", err)
	}
}

func TestResumeRunFailsWhenJobNotFound(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'No resources found in fabrik-runs namespace.\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := ResumeOptions{
		Namespace: "fabrik-runs",
		RunID:     "run-not-found",
	}

	err := ResumeRun(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected error when job not found")
	}
	if !strings.Contains(err.Error(), "run-not-found not found") {
		t.Fatalf("expected run not found error, got: %v", err)
	}
}

func TestResumeRunFailsWithMutableImage(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf '{\"items\":[{\"metadata\":{\"name\":\"fabrik-mutable-run\"},\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"image\":\"repo/image:latest\"}]}}}}]}\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := ResumeOptions{
		Namespace: "fabrik-runs",
		RunID:     "mutable-run",
	}

	err := ResumeRun(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected error for mutable image")
	}
	if !strings.Contains(err.Error(), "mutable image reference") {
		t.Fatalf("expected mutable image error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "repo/image:latest") {
		t.Fatalf("expected image name in error, got: %v", err)
	}
}

func TestResumeRunFailsWhenPVCNotFound(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf '{\"items\":[{\"metadata\":{\"name\":\"fabrik-pvc-missing\"},\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"image\":\"repo/image@sha256:abc123\"}]}}}}]}\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pvc\" ]; then\n" +
		"      printf 'No resources found\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := ResumeOptions{
		Namespace: "fabrik-runs",
		RunID:     "pvc-missing",
	}

	err := ResumeRun(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected error when pvc not found")
	}
	if !strings.Contains(err.Error(), "PVC") {
		t.Fatalf("expected PVC error, got: %v", err)
	}
}

func TestResumeRunSucceedsWhenNoActivePod(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    # Check for job completion query: -n NS get job JOBNAME -o jsonpath=...\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ] && [ \"$6\" = \"-o\" ] && [ \"$7\" = \"jsonpath={.status.conditions[?(@.type=='Complete')].status}\" ]; then\n" +
		"      printf ''\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ] && [ \"$5\" = \"-l\" ]; then\n" +
		"      printf '{\"items\":[{\"metadata\":{\"name\":\"fabrik-no-pod\"},\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"image\":\"repo/image@sha256:immutable123\"}]}}}}]}\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pvc\" ] && [ \"$5\" = \"-l\" ]; then\n" +
		"      printf '{\"items\":[{\"metadata\":{\"name\":\"data-fabrik-no-pod\"}}]}\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pods\" ]; then\n" +
		"      printf ''\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := ResumeOptions{
		Namespace: "fabrik-runs",
		RunID:     "no-pod",
	}

	err := ResumeRun(context.Background(), &out, &errOut, opts)
	if err != nil {
		t.Fatalf("expected success for no active pod: %v", err)
	}
	if !strings.Contains(out.String(), "no active pod found") {
		t.Fatalf("expected no active pod message, got: %s", out.String())
	}
}

func TestResumeRunSucceedsAndDeletesPod(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ] && [ \"$5\" = \"-l\" ]; then\n" +
		"      printf '{\"items\":[{\"metadata\":{\"name\":\"fabrik-stuck-run\"},\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"image\":\"repo/image@sha256:immutable123\"}]}}}}]}\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pvc\" ] && [ \"$5\" = \"-l\" ]; then\n" +
		"      printf '{\"items\":[{\"metadata\":{\"name\":\"data-fabrik-stuck-run\"}}]}\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pods\" ]; then\n" +
		"      printf 'fabrik-stuck-run-abcd1\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"delete\" ] && [ \"$4\" = \"pod\" ]; then\n" +
		"      printf 'pod \"%s\" deleted\\n' \"$5\"\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := ResumeOptions{
		Namespace: "fabrik-runs",
		RunID:     "stuck-run",
	}

	err := ResumeRun(context.Background(), &out, &errOut, opts)
	if err != nil {
		t.Fatalf("expected success: %v", err)
	}
	if !strings.Contains(out.String(), "deleting stuck pod fabrik-stuck-run-abcd1") {
		t.Fatalf("expected pod deletion message, got: %s", out.String())
	}
	if !strings.Contains(out.String(), "resumed run stuck-run") {
		t.Fatalf("expected resumed message, got: %s", out.String())
	}
	if !strings.Contains(out.String(), "image: repo/image@sha256:immutable123") {
		t.Fatalf("expected image digest in output, got: %s", out.String())
	}
}

func TestResumeRunFailsWhenAlreadyCompleted(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    # Check for job completion query: -n NS get job JOBNAME -o jsonpath=...\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ] && [ \"$6\" = \"-o\" ] && [ \"$7\" = \"jsonpath={.status.conditions[?(@.type=='Complete')].status}\" ]; then\n" +
		"      printf 'True\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ] && [ \"$5\" = \"-l\" ]; then\n" +
		"      printf '{\"items\":[{\"metadata\":{\"name\":\"fabrik-completed\"},\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"image\":\"repo/image@sha256:immutable123\"}]}}}}]}\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pvc\" ] && [ \"$5\" = \"-l\" ]; then\n" +
		"      printf '{\"items\":[{\"metadata\":{\"name\":\"data-fabrik-completed\"}}]}\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pods\" ]; then\n" +
		"      printf ''\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := ResumeOptions{
		Namespace: "fabrik-runs",
		RunID:     "completed",
	}

	err := ResumeRun(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected error when job already completed")
	}
	if !strings.Contains(err.Error(), "already completed") {
		t.Fatalf("expected already completed error, got: %v", err)
	}
}

func TestResumeRunUsesDefaultNamespace(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$2\" = \"fabrik-runs\" ] && [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'No resources found\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	var out bytes.Buffer
	var errOut bytes.Buffer
	opts := ResumeOptions{
		// Namespace not set - should default to fabrik-runs
		RunID: "default-ns-test",
	}

	err := ResumeRun(context.Background(), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected error")
	}
	// Verify that -n fabrik-runs was passed (checked in the script)
	if !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected not found error using default namespace, got: %v", err)
	}
}
