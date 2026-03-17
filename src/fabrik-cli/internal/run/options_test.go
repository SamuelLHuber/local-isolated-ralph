package run

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateOptionsRejectsMutableImage(t *testing.T) {
	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		Image:       "repo/image:latest",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
	}
	if err := validateOptions(opts); err == nil {
		t.Fatalf("expected validation error for mutable image")
	}
}

func TestValidateOptionsAcceptsDigest(t *testing.T) {
	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		Image:       "repo/image@sha256:abcdef",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
	}
	if err := validateOptions(opts); err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
}

func TestValidateOptionsRejectsPinnedTag(t *testing.T) {
	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		Image:       "repo/image:v1.2.3",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
	}
	if err := validateOptions(opts); err == nil {
		t.Fatalf("expected validation error for mutable tag")
	}
}

func TestValidateOptionsAllowsPinnedTagForRenderOnly(t *testing.T) {
	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		Image:       "repo/image:v1.2.3",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
		RenderOnly:  true,
	}
	if err := validateOptions(opts); err != nil {
		t.Fatalf("expected render-only validation success, got error: %v", err)
	}
}

func TestValidateOptionsAllowsPinnedTagForDryRun(t *testing.T) {
	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		Image:       "repo/image:v1.2.3",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
		DryRun:      true,
	}
	if err := validateOptions(opts); err == nil {
		t.Fatalf("expected dry-run validation error for mutable image")
	}
}

func TestResolveOptionsConvertsTaggedImageForDispatch(t *testing.T) {
	originalResolver := resolveImmutableImage
	resolveImmutableImage = func(_ context.Context, image string) (string, error) {
		if image != "repo/image:v1.2.3" {
			t.Fatalf("expected original image to be resolved, got %q", image)
		}
		return "repo/image@sha256:abcdef", nil
	}
	defer func() {
		resolveImmutableImage = originalResolver
	}()

	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		Image:       "repo/image:v1.2.3",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
	}

	resolved, err := ResolveOptions(context.Background(), nil, nil, opts)
	if err != nil {
		t.Fatalf("expected resolution success, got error: %v", err)
	}
	if resolved.Image != "repo/image@sha256:abcdef" {
		t.Fatalf("expected immutable image, got %q", resolved.Image)
	}
}

func TestResolveOptionsDoesNotConvertTaggedImageForRenderOnly(t *testing.T) {
	originalResolver := resolveImmutableImage
	resolveImmutableImage = func(_ context.Context, image string) (string, error) {
		t.Fatalf("did not expect render-only flow to resolve image %q", image)
		return "", nil
	}
	defer func() {
		resolveImmutableImage = originalResolver
	}()

	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		Image:       "repo/image:v1.2.3",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
		RenderOnly:  true,
	}

	resolved, err := ResolveOptions(context.Background(), nil, nil, opts)
	if err != nil {
		t.Fatalf("expected resolution success, got error: %v", err)
	}
	if resolved.Image != "repo/image:v1.2.3" {
		t.Fatalf("expected original tagged image, got %q", resolved.Image)
	}
}

func TestResolveOptionsDoesNotConvertTaggedImageForDryRun(t *testing.T) {
	originalResolver := resolveImmutableImage
	resolveImmutableImage = func(_ context.Context, image string) (string, error) {
		if image != "repo/image:v1.2.3" {
			t.Fatalf("expected original image to be resolved, got %q", image)
		}
		return "repo/image@sha256:abcdef", nil
	}
	defer func() {
		resolveImmutableImage = originalResolver
	}()

	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		Image:       "repo/image:v1.2.3",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
		DryRun:      true,
	}

	resolved, err := ResolveOptions(context.Background(), nil, nil, opts)
	if err != nil {
		t.Fatalf("expected resolution success, got error: %v", err)
	}
	if resolved.Image != "repo/image@sha256:abcdef" {
		t.Fatalf("expected immutable image, got %q", resolved.Image)
	}
}

func TestValidateOptionsRequiresAcceptanceForWorkflowSyncBundle(t *testing.T) {
	opts := Options{
		RunID:              "r1",
		SpecPath:           "specs/a.yaml",
		Project:            "demo",
		Image:              "repo/image@sha256:abcdef",
		WorkflowPath:       "workflow.tsx",
		InputJSON:          "{}",
		Namespace:          "fabrik-runs",
		PVCSize:            "1Gi",
		WaitTimeout:        "5m",
		Interactive:        false,
		AcceptFilteredSync: false,
		SyncBundle:         &SyncBundle{ManifestPath: ".fabrik-sync"},
	}
	if err := validateOptions(opts); err == nil {
		t.Fatalf("expected validation error for missing filtered-sync acknowledgement")
	}
}

func TestValidateOptionsRejectsWaitWithCron(t *testing.T) {
	opts := Options{
		RunID:        "cron-1",
		SpecPath:     "specs/a.yaml",
		Project:      "demo",
		Image:        "repo/image@sha256:abcdef",
		CronSchedule: "*/5 * * * *",
		Namespace:    "fabrik-runs",
		PVCSize:      "1Gi",
		JobCommand:   "echo hi",
		WaitTimeout:  "5m",
		Wait:         true,
	}
	if err := validateOptions(opts); err == nil {
		t.Fatalf("expected validation error for --wait with --cron")
	}
}

func TestValidateOptionsRejectsMultipleSharedCredentialSources(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(filePath, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		RunID:                  "r1",
		SpecPath:               "specs/a.yaml",
		Project:                "demo",
		Image:                  "repo/image@sha256:abcdef",
		Namespace:              "fabrik-runs",
		PVCSize:                "1Gi",
		JobCommand:             "echo hi",
		WaitTimeout:            "5m",
		SharedCredentialSecret: "fabrik-credential-openai-default",
		SharedCredentialFile:   filePath,
	}
	if err := validateOptions(opts); err == nil {
		t.Fatalf("expected validation error for multiple shared credential sources")
	}
}

func TestValidateOptionsRejectsDisableSharedCredentialsWithOverride(t *testing.T) {
	opts := Options{
		RunID:                    "r1",
		SpecPath:                 "specs/a.yaml",
		Project:                  "demo",
		Image:                    "repo/image@sha256:abcdef",
		Namespace:                "fabrik-runs",
		PVCSize:                  "1Gi",
		JobCommand:               "echo hi",
		WaitTimeout:              "5m",
		DisableSharedCredentials: true,
		SharedCredentialSecret:   "fabrik-credential-openai-default",
	}
	if err := validateOptions(opts); err == nil {
		t.Fatalf("expected validation error when disable-shared-credentials is combined with an override")
	}
}

func TestValidateOptionsRejectsInvalidEnvironmentName(t *testing.T) {
	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		Environment: "Dev",
		Image:       "repo/image@sha256:abcdef",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
	}
	if err := validateOptions(opts); err == nil {
		t.Fatalf("expected validation error for invalid environment name")
	}
}

func TestValidateOptionsRequiresEnvWhenEnvFileIsSet(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.dispatch")
	if err := os.WriteFile(envFile, []byte("DATABASE_URL=postgres://demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		RunID:       "r1",
		SpecPath:    "specs/a.yaml",
		Project:     "demo",
		EnvFile:     envFile,
		Image:       "repo/image@sha256:abcdef",
		Namespace:   "fabrik-runs",
		PVCSize:     "1Gi",
		JobCommand:  "echo hi",
		WaitTimeout: "5m",
	}
	if err := validateOptions(opts); err == nil {
		t.Fatalf("expected validation error when --env-file is set without --env")
	}
}

func TestResolveOptionsPrintsGitHubAuthGuidanceWhenEnvFileLacksToken(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.dispatch")
	if err := os.WriteFile(envFile, []byte("DATABASE_URL=postgres://demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	workflowPath := filepath.Join(dir, "workflow.tsx")
	if err := os.WriteFile(workflowPath, []byte("export default {};"), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	opts := Options{
		RunID:              "r1",
		SpecPath:           "specs/a.yaml",
		Project:            "demo",
		Environment:        "dev",
		EnvFile:            envFile,
		Image:              "repo/image@sha256:abcdef",
		WorkflowPath:       workflowPath,
		InputJSON:          "{}",
		JJRepo:             "https://github.com/example/private-repo",
		Namespace:          "fabrik-runs",
		PVCSize:            "1Gi",
		WaitTimeout:        "5m",
		Interactive:        false,
		AcceptFilteredSync: true,
	}

	if _, err := ResolveOptions(context.Background(), strings.NewReader(""), &out, opts); err != nil {
		t.Fatalf("resolve options: %v", err)
	}
	if !strings.Contains(out.String(), "private GitHub repos need GITHUB_TOKEN or GH_TOKEN") {
		t.Fatalf("expected GitHub auth guidance, got %q", out.String())
	}
}

func TestResolveOptionsInteractiveGitHubAuthCanWriteEnvFile(t *testing.T) {
	// Skip if kubectl is not available or has no valid contexts
	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("kubectl not available")
	}
	// Verify we have at least one context available
	contextsOut, err := exec.Command("kubectl", "config", "get-contexts", "-o", "name").Output()
	if err != nil || len(contextsOut) == 0 {
		t.Skip("no kubectl contexts available")
	}
	contextName := strings.TrimSpace(strings.SplitN(string(contextsOut), "\n", 2)[0])
	if contextName == "" {
		t.Skip("no kubectl contexts available")
	}

	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.dispatch")
	if err := os.WriteFile(envFile, []byte("DATABASE_URL=postgres://demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	workflowPath := filepath.Join(dir, "workflow.tsx")
	if err := os.WriteFile(workflowPath, []byte("export default {};"), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	opts := Options{
		RunID:              "r1",
		SpecPath:           "specs/a.yaml",
		Project:            "demo",
		Environment:        "dev",
		EnvFile:            envFile,
		Image:              "repo/image@sha256:abcdef",
		WorkflowPath:       workflowPath,
		InputJSON:          "{}",
		JJRepo:             "https://github.com/example/private-repo",
		Namespace:          "fabrik-runs",
		KubeContext:        contextName,
		PVCSize:            "1Gi",
		WaitTimeout:        "5m",
		Interactive:        true,
		AcceptFilteredSync: true,
		RunMode:            "test",
	}

	if _, err := ResolveOptions(context.Background(), bufio.NewReader(strings.NewReader("y\nghp_test_token\n")), &out, opts); err != nil {
		t.Fatalf("resolve options: %v", err)
	}

	content, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatalf("read env file: %v", err)
	}
	if !strings.Contains(string(content), "GITHUB_TOKEN=\"ghp_test_token\"") {
		t.Fatalf("expected env file to contain GITHUB_TOKEN, got %q", string(content))
	}
}
