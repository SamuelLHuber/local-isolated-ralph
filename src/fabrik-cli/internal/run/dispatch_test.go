package run

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecuteRenderOnlyNoClusterMutation(t *testing.T) {
	in := strings.NewReader("")
	var out bytes.Buffer
	var errOut bytes.Buffer

	opts := Options{
		RunID:       "run-1",
		SpecPath:    "specs/demo.yaml",
		Project:     "demo",
		Image:       "repo/image@sha256:abcdef",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
		RenderOnly:  true,
		Interactive: false,
	}

	if err := Execute(context.Background(), in, &out, &errOut, opts); err != nil {
		t.Fatalf("execute failed: %v", err)
	}

	rendered := out.String()
	if !strings.Contains(rendered, "kind: Job") {
		t.Fatalf("expected rendered manifest to include Job")
	}
	if errOut.Len() != 0 {
		t.Fatalf("expected no stderr output, got: %s", errOut.String())
	}
}

func TestExecuteRenderOnlyCronRendersCronJobWithoutPVC(t *testing.T) {
	in := strings.NewReader("")
	var out bytes.Buffer
	var errOut bytes.Buffer

	opts := Options{
		RunID:        "cron-render",
		SpecPath:     "specs/demo.yaml",
		Project:      "demo",
		Image:        "repo/image@sha256:abcdef",
		CronSchedule: "*/10 * * * *",
		Namespace:    "fabrik-runs",
		PVCSize:      "1Gi",
		JobCommand:   "echo hi",
		WaitTimeout:  "5m",
		RenderOnly:   true,
		Interactive:  false,
	}

	if err := Execute(context.Background(), in, &out, &errOut, opts); err != nil {
		t.Fatalf("execute failed: %v", err)
	}

	rendered := out.String()
	if !strings.Contains(rendered, "kind: CronJob") {
		t.Fatalf("expected rendered manifest to include CronJob")
	}
	if strings.Contains(rendered, "kind: PersistentVolumeClaim") {
		t.Fatalf("expected cron render to skip stand-alone PVC manifests")
	}
	if !strings.Contains(rendered, "schedule: \"*/10 * * * *\"") {
		t.Fatalf("expected rendered manifest to include cron schedule")
	}
	if !strings.Contains(rendered, "volumeClaimTemplate:") {
		t.Fatalf("expected cron render to include ephemeral pvc template")
	}
}

func TestExecuteRenderOnlyWithFabrikSyncRendersSecretAndBootstrap(t *testing.T) {
	dir := t.TempDir()
	workflowPath := filepath.Join(dir, "workflow.tsx")
	if err := os.WriteFile(workflowPath, []byte("export default {};"), 0o644); err != nil {
		t.Fatal(err)
	}
	syncManifest := filepath.Join(dir, ".fabrik-sync")
	if err := os.WriteFile(syncManifest, []byte(".env.local\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte("A=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		RunID:              "run-2",
		SpecPath:           "specs/demo.yaml",
		Project:            "demo",
		Image:              "repo/image@sha256:abcdef",
		WorkflowPath:       workflowPath,
		InputJSON:          "{}",
		FabrikSyncFile:     syncManifest,
		Namespace:          "fabrik-runs",
		PVCSize:            "1Gi",
		WaitTimeout:        "5m",
		RenderOnly:         true,
		Interactive:        false,
		AcceptFilteredSync: true,
	}

	resolved, err := ResolveOptions(context.Background(), strings.NewReader(""), &bytes.Buffer{}, opts)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, resolved); err != nil {
		t.Fatalf("execute failed: %v", err)
	}

	rendered := out.String()
	if !strings.Contains(rendered, "kind: Secret") {
		t.Fatalf("expected rendered manifest to include sync secret")
	}
	if !strings.Contains(rendered, "/opt/fabrik-sync/bundle.tgz") {
		t.Fatalf("expected rendered manifest to mount fabrik sync bundle")
	}
	if !strings.Contains(rendered, "tar -xzf /opt/fabrik-sync/bundle.tgz -C /workspace/workdir") {
		t.Fatalf("expected bootstrap extraction command in rendered manifest")
	}
}

func TestExecuteRenderOnlyWithProjectEnvRendersSecretMountAndEnvFrom(t *testing.T) {
	in := strings.NewReader("")
	var out bytes.Buffer
	var errOut bytes.Buffer

	opts := Options{
		RunID:       "run-env-render",
		SpecPath:    "specs/demo.yaml",
		Project:     "demo",
		Environment: "dev",
		Image:       "repo/image@sha256:abcdef",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
		RenderOnly:  true,
		Interactive: false,
	}

	if err := Execute(context.Background(), in, &out, &errOut, opts); err != nil {
		t.Fatalf("execute failed: %v", err)
	}

	rendered := out.String()
	if !strings.Contains(rendered, "secretName: fabrik-env-demo-dev") {
		t.Fatalf("expected rendered manifest to reference project env secret, got %s", rendered)
	}
	if !strings.Contains(rendered, "mountPath: /etc/fabrik/env") {
		t.Fatalf("expected rendered manifest to mount project env secret")
	}
	if !strings.Contains(rendered, "envFrom:") {
		t.Fatalf("expected rendered manifest to include envFrom for project env secret")
	}
}

func TestExecuteDryRunWorkflowDoesNotApplyCodexSecret(t *testing.T) {
	dir := t.TempDir()
	workflowPath := filepath.Join(dir, "workflow.tsx")
	if err := os.WriteFile(workflowPath, []byte("export default {};"), 0o644); err != nil {
		t.Fatal(err)
	}

	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  apply)\n" +
		"    cat >/dev/null\n" +
		"    printf 'kind: Job\\n'\n" +
		"    ;;\n" +
		"  *)\n" +
		"    exit 97\n" +
		"    ;;\n" +
		"esac\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	homeDir := filepath.Join(dir, "home-with-codex-auth")
	codexDir := filepath.Join(homeDir, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte("model = \"test\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", homeDir)

	opts := Options{
		RunID:        "run-dry-workflow",
		SpecPath:     "specs/demo.yaml",
		Project:      "demo",
		Image:        "repo/image@sha256:abcdef",
		WorkflowPath: workflowPath,
		InputJSON:    "{}",
		Namespace:    "fabrik-runs",
		PVCSize:      "1Gi",
		WaitTimeout:  "5m",
		DryRun:       true,
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, opts); err != nil {
		t.Fatalf("dry-run execute failed: %v", err)
	}
	if !strings.Contains(out.String(), "kind: Job") {
		t.Fatalf("expected dry-run output to include Job")
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	logText := string(logData)
	if strings.Contains(logText, "create secret generic codex-auth") {
		t.Fatalf("dry-run should not create codex-auth secret, got kubectl calls: %s", logText)
	}
	if !strings.Contains(logText, "apply --dry-run=client -o yaml -f -") {
		t.Fatalf("expected dry-run kubectl apply call, got %s", logText)
	}
}

func TestExecuteDryRunWithMissingProjectEnvFailsBeforeKubectlApply(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"secret\" ]; then\n" +
		"      printf 'Error from server (NotFound): secrets \"fabrik-env-demo-dev\" not found\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    ;;\n" +
		"  apply)\n" +
		"    printf 'unexpected apply\\n' >&2\n" +
		"    exit 99\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := Options{
		RunID:       "run-dry-env-missing",
		SpecPath:    "specs/demo.yaml",
		Project:     "demo",
		Environment: "dev",
		Image:       "repo/image@sha256:abcdef",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
		DryRun:      true,
		Interactive: false,
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected dry-run to fail when project env secret is missing")
	}
	if !strings.Contains(err.Error(), "missing project env secret fabrik-env-demo-dev in namespace fabrik-system") {
		t.Fatalf("expected missing env secret error, got %v", err)
	}

	logData, readErr := os.ReadFile(kubectlLog)
	if readErr != nil {
		t.Fatalf("read kubectl log: %v", readErr)
	}
	logText := string(logData)
	if strings.Contains(logText, "apply --dry-run=client") {
		t.Fatalf("expected dry-run to fail before kubectl apply, got kubectl calls: %s", logText)
	}
}

func TestExecuteLiveDispatchWithoutWaitVerifiesPodStartAndDoesNotSync(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  apply)\n" +
		"    cat >/dev/null\n" +
		"    printf 'applied\\n'\n" +
		"    exit 0\n" +
		"    ;;\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"patch\" ] && [ \"$4\" = \"pvc\" ]; then\n" +
		"      printf 'patched\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pods\" ]; then\n" +
		"      printf 'demo-pod\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pod\" ]; then\n" +
		"      printf 'Running\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'uid-123\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := Options{
		RunID:       "run-live-no-wait",
		SpecPath:    "specs/demo.yaml",
		Project:     "demo",
		Image:       "repo/image@sha256:abcdef",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
		Wait:        false,
		Interactive: false,
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, opts); err != nil {
		t.Fatalf("execute failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "dispatched job fabrik-run-live-no-wait in namespace fabrik-runs") {
		t.Fatalf("expected dispatch message, got %q", output)
	}
	if !strings.Contains(output, "pod: demo-pod") {
		t.Fatalf("expected pod name in output, got %q", output)
	}
	if !strings.Contains(output, "phase: Running") {
		t.Fatalf("expected pod phase in output, got %q", output)
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	logText := string(logData)
	if strings.Contains(logText, " wait ") || strings.Contains(logText, " logs ") || strings.Contains(logText, " exec ") {
		t.Fatalf("expected non-wait dispatch to skip wait/log/sync calls, got kubectl calls: %s", logText)
	}
}

func TestExecuteLiveCronCreateVerifiesCronJobAndSkipsJobFlow(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  apply)\n" +
		"    cat >/dev/null\n" +
		"    printf 'applied\\n'\n" +
		"    exit 0\n" +
		"    ;;\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"cronjob\" ]; then\n" +
		"      printf '*/15 * * * *\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := Options{
		RunID:        "cron-live-no-wait",
		SpecPath:     "specs/demo.yaml",
		Project:      "demo",
		Image:        "repo/image@sha256:abcdef",
		CronSchedule: "*/15 * * * *",
		Namespace:    "fabrik-runs",
		PVCSize:      "1Gi",
		JobCommand:   "echo hi",
		WaitTimeout:  "5m",
		Interactive:  false,
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, opts); err != nil {
		t.Fatalf("execute failed: %v", err)
	}

	output := out.String()
	if !strings.Contains(output, "scheduled cronjob fabrik-cron-cron-live-no-wait in namespace fabrik-runs") {
		t.Fatalf("expected cron creation message, got %q", output)
	}
	if !strings.Contains(output, "schedule: */15 * * * *") {
		t.Fatalf("expected cron schedule in output, got %q", output)
	}

	logData, err := os.ReadFile(kubectlLog)
	if err != nil {
		t.Fatalf("read kubectl log: %v", err)
	}
	logText := string(logData)
	if strings.Contains(logText, " patch pvc ") || strings.Contains(logText, " get pods ") || strings.Contains(logText, " wait ") {
		t.Fatalf("expected cron creation to skip job wait/pvc calls, got kubectl calls: %s", logText)
	}
}

func TestExecuteLiveCronWithMissingProjectEnvFailsBeforeApply(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"secret\" ]; then\n" +
		"      printf 'Error from server (NotFound): secrets \"fabrik-env-demo-dev\" not found\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    ;;\n" +
		"  apply)\n" +
		"    printf 'unexpected apply\\n' >&2\n" +
		"    exit 99\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := Options{
		RunID:        "cron-live-env-missing",
		SpecPath:     "specs/demo.yaml",
		Project:      "demo",
		Environment:  "dev",
		Image:        "repo/image@sha256:abcdef",
		CronSchedule: "*/15 * * * *",
		Namespace:    "fabrik-runs",
		PVCSize:      "1Gi",
		JobCommand:   "echo hi",
		WaitTimeout:  "5m",
		Interactive:  false,
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected live cron create to fail when project env secret is missing")
	}
	if !strings.Contains(err.Error(), "missing project env secret fabrik-env-demo-dev in namespace fabrik-system") {
		t.Fatalf("expected missing env secret error, got %v", err)
	}

	logData, readErr := os.ReadFile(kubectlLog)
	if readErr != nil {
		t.Fatalf("read kubectl log: %v", readErr)
	}
	logText := string(logData)
	if strings.Contains(logText, "apply -f -") {
		t.Fatalf("expected live cron create to fail before kubectl apply, got kubectl calls: %s", logText)
	}
}

func TestExecuteWaitSuccessIgnoresMetadataPatchFailure(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  apply)\n" +
		"    cat >/dev/null\n" +
		"    printf 'applied\\n'\n" +
		"    exit 0\n" +
		"    ;;\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"wait\" ]; then\n" +
		"      printf 'condition met\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'uid-123\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pods\" ]; then\n" +
		"      printf 'demo-pod\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"patch\" ] && [ \"$4\" = \"pvc\" ]; then\n" +
		"      printf 'patched\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"patch\" ] && { [ \"$4\" = \"job\" ] || [ \"$4\" = \"pod\" ]; }; then\n" +
		"      printf 'metadata patch failed\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"logs\" ]; then\n" +
		"      printf 'job logs\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"delete\" ]; then\n" +
		"      printf 'deleted\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"exec\" ] && [ \"$6\" = \"test\" ]; then\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	originalCopyWorkdir := copyWorkdirFromPodFn
	copyWorkdirFromPodFn = func(_ context.Context, _ Options, _ string, destination string) error {
		return os.MkdirAll(destination, 0o755)
	}
	defer func() { copyWorkdirFromPodFn = originalCopyWorkdir }()

	originalKubectlCopy := kubectlCopyFn
	kubectlCopyFn = func(_ context.Context, _ Options, _ string, _ string) error { return nil }
	defer func() { kubectlCopyFn = originalKubectlCopy }()

	opts := Options{
		RunID:        "run-wait-success-patch-warn",
		SpecPath:     "specs/demo.yaml",
		Project:      "demo",
		Image:        "repo/image@sha256:abcdef",
		Namespace:    "fabrik-runs",
		PVCSize:      "1Gi",
		JobCommand:   "echo hi",
		WaitTimeout:  "5m",
		Wait:         true,
		Interactive:  false,
		OutputSubdir: "k8s/job-sync",
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, opts); err != nil {
		t.Fatalf("execute failed: %v", err)
	}

	if !strings.Contains(out.String(), "completed job fabrik-run-wait-success-patch-warn") {
		t.Fatalf("expected completion output, got %q", out.String())
	}
	if !strings.Contains(errOut.String(), "warning: failed to update Fabrik run metadata") {
		t.Fatalf("expected metadata warning, got %q", errOut.String())
	}
}

func TestExecuteWaitFailureReturnsWaitErrorEvenIfMetadataPatchFails(t *testing.T) {
	dir := t.TempDir()
	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"case \"$1\" in\n" +
		"  apply)\n" +
		"    cat >/dev/null\n" +
		"    printf 'applied\\n'\n" +
		"    exit 0\n" +
		"    ;;\n" +
		"  -n)\n" +
		"    if [ \"$3\" = \"wait\" ]; then\n" +
		"      printf 'deadline exceeded\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"job\" ]; then\n" +
		"      printf 'uid-123\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"get\" ] && [ \"$4\" = \"pods\" ]; then\n" +
		"      printf 'demo-pod\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"patch\" ] && [ \"$4\" = \"pvc\" ]; then\n" +
		"      printf 'patched\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"patch\" ] && { [ \"$4\" = \"job\" ] || [ \"$4\" = \"pod\" ]; }; then\n" +
		"      printf 'metadata patch failed\\n' >&2\n" +
		"      exit 1\n" +
		"    fi\n" +
		"    if [ \"$3\" = \"logs\" ]; then\n" +
		"      printf 'recent failure log\\n'\n" +
		"      exit 0\n" +
		"    fi\n" +
		"    ;;\n" +
		"esac\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	opts := Options{
		RunID:        "run-wait-failure-patch-warn",
		SpecPath:     "specs/demo.yaml",
		Project:      "demo",
		Image:        "repo/image@sha256:abcdef",
		Namespace:    "fabrik-runs",
		PVCSize:      "1Gi",
		JobCommand:   "echo hi",
		WaitTimeout:  "5m",
		Wait:         true,
		Interactive:  false,
		OutputSubdir: "k8s/job-sync",
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected wait failure")
	}
	if !strings.Contains(err.Error(), "wait --for=condition=complete") {
		t.Fatalf("expected native wait error, got %v", err)
	}
	if !strings.Contains(errOut.String(), "warning: failed to update Fabrik run metadata") {
		t.Fatalf("expected metadata warning, got %q", errOut.String())
	}
	if !strings.Contains(errOut.String(), "recent logs for demo-pod:") {
		t.Fatalf("expected pod logs in stderr, got %q", errOut.String())
	}
}

func TestExecuteDryRunWorkflowRequiresCodexAuthFiles(t *testing.T) {
	dir := t.TempDir()
	workflowPath := filepath.Join(dir, "workflow.tsx")
	if err := os.WriteFile(workflowPath, []byte("export default {};"), 0o644); err != nil {
		t.Fatal(err)
	}

	kubectlLog := filepath.Join(dir, "kubectl.log")
	kubectlPath := filepath.Join(dir, "kubectl")
	kubectlScript := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + shellQuote(kubectlLog) + "\n" +
		"exit 97\n"
	if err := os.WriteFile(kubectlPath, []byte(kubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("HOME", filepath.Join(dir, "home-without-codex-auth"))

	opts := Options{
		RunID:        "run-dry-workflow-missing-auth",
		SpecPath:     "specs/demo.yaml",
		Project:      "demo",
		Image:        "repo/image@sha256:abcdef",
		WorkflowPath: workflowPath,
		InputJSON:    "{}",
		Namespace:    "fabrik-runs",
		PVCSize:      "1Gi",
		WaitTimeout:  "5m",
		DryRun:       true,
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, opts)
	if err == nil {
		t.Fatalf("expected dry-run to fail when codex auth files are missing")
	}
	if !strings.Contains(err.Error(), "missing codex auth file") {
		t.Fatalf("expected missing auth error, got %v", err)
	}

	if _, statErr := os.Stat(kubectlLog); !os.IsNotExist(statErr) {
		t.Fatalf("expected kubectl not to be invoked before auth preflight, stat err=%v", statErr)
	}
}

func TestSyncWorkdirExcludesMatchDocumentedBuildArtifacts(t *testing.T) {
	want := []string{"node_modules", ".next", "dist", "build", ".git", ".jj"}
	for _, pattern := range want {
		if !contains(syncWorkdirExcludes, pattern) {
			t.Fatalf("expected syncWorkdirExcludes to contain %q, got %v", pattern, syncWorkdirExcludes)
		}
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
