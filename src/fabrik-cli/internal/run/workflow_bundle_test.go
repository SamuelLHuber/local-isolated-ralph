package run

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestResolveWorkflowBundleStagesWorkflowUnderWorkflowsDir(t *testing.T) {
	dir := t.TempDir()
	utilsDir := filepath.Join(dir, "utils")
	if err := os.MkdirAll(utilsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	workflowPath := filepath.Join(dir, "workflow.tsx")
	if err := os.WriteFile(workflowPath, []byte("import { x } from \"./utils/helper\";\nconsole.log(x);\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(utilsDir, "helper.ts"), []byte("export const x = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	bundle, err := resolveWorkflowBundle(workflowPath)
	if err != nil {
		t.Fatalf("resolveWorkflowBundle returned error: %v", err)
	}
	if bundle.WorkdirPath != "workflows/workflow.tsx" {
		t.Fatalf("unexpected workdir path %q", bundle.WorkdirPath)
	}

	gotEntries := untarNames(t, bundle.ArchiveBase64)
	wantEntries := []string{
		"workflows/utils/helper.ts",
		"workflows/workflow.tsx",
	}
	sort.Strings(gotEntries)
	if !reflect.DeepEqual(gotEntries, wantEntries) {
		t.Fatalf("archive entries mismatch\nwant: %#v\ngot: %#v", wantEntries, gotEntries)
	}
}

func TestResolveWorkflowBundleRejectsImportsOutsideWorkflowDir(t *testing.T) {
	dir := t.TempDir()
	workflowDir := filepath.Join(dir, "workflow")
	if err := os.MkdirAll(workflowDir, 0o755); err != nil {
		t.Fatal(err)
	}
	workflowPath := filepath.Join(workflowDir, "workflow.tsx")
	if err := os.WriteFile(workflowPath, []byte("import { x } from \"../shared/helper\";\nconsole.log(x);\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sharedDir := filepath.Join(dir, "shared")
	if err := os.MkdirAll(sharedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sharedDir, "helper.ts"), []byte("export const x = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := resolveWorkflowBundle(workflowPath)
	if err == nil {
		t.Fatal("expected resolveWorkflowBundle to reject parent import")
	}
	if !strings.Contains(err.Error(), "outside its directory tree") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func untarNames(t *testing.T, archiveBase64 string) []string {
	t.Helper()

	data, err := base64.StdEncoding.DecodeString(archiveBase64)
	if err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	var names []string
	for {
		hdr, err := tr.Next()
		if err != nil {
			if err == io.EOF {
				break
			}
			t.Fatal(err)
		}
		names = append(names, hdr.Name)
	}
	return names
}

// TestComplexSampleBundleContents verifies that the complex sample workflow
// bundle contains only the workflow code and direct helper imports.
// This ensures the sample is self-contained and repeatable per the spec:
// - workflow bundle only contains workflow code and direct helper imports
// - repo contents come from --jj-repo, not copied local specs
func TestComplexSampleBundleContents(t *testing.T) {
	// Resolve from the actual complex sample in the repo
	repoRoot, err := findRepoRoot()
	if err != nil {
		t.Skipf("cannot find repo root: %v", err)
	}

	workflowPath := filepath.Join(repoRoot, "examples", "complex", "pi-spec-implementation.tsx")
	if _, err := os.Stat(workflowPath); err != nil {
		t.Skipf("complex sample workflow not found at %s: %v", workflowPath, err)
	}

	bundle, err := resolveWorkflowBundle(workflowPath)
	if err != nil {
		t.Fatalf("resolveWorkflowBundle failed for complex sample: %v", err)
	}

	// Verify the workflow is staged under workflows/ directory
	if bundle.WorkdirPath != "workflows/pi-spec-implementation.tsx" {
		t.Fatalf("unexpected workdir path %q, want workflows/pi-spec-implementation.tsx", bundle.WorkdirPath)
	}

	// Get the actual entries in the bundle
	gotEntries := untarNames(t, bundle.ArchiveBase64)

	// The complex sample imports from "@dtechvision/fabrik-runtime/jj-shell", so the bundle
	// should contain only the workflow file itself. Runtime package imports are
	// resolved from the Smithers runtime image, not copied into the workflow
	// archive.
	//
	// It should NOT contain:
	// - utils/* (package helpers are not bundled)
	// - specs/* (repo contents come from --jj-repo, not copied)
	// - Any other files outside the workflow directory
	requiredEntries := map[string]bool{
		"workflows/pi-spec-implementation.tsx": false,
	}
	forbiddenEntries := []string{
		"workflows/utils/",
		"workflows/utils/codex-auth-rotation.ts", // Not imported by workflow
		"workflows/specs/",                     // Specs come from --jj-repo
		"specs/",                               // Should never be in bundle
	}

	for _, entry := range gotEntries {
		for required := range requiredEntries {
			if entry == required {
				requiredEntries[required] = true
			}
		}
		for _, forbidden := range forbiddenEntries {
			if strings.HasPrefix(entry, forbidden) {
				t.Fatalf("bundle contains forbidden entry %q (should only include workflow code and direct imports, not specs or unused utils)", entry)
			}
		}
	}

	for required, found := range requiredEntries {
		if !found {
			t.Fatalf("bundle missing required entry %q", required)
		}
	}

	// Verify bundle is reasonably sized (should be small since no specs included)
	data, err := base64.StdEncoding.DecodeString(bundle.ArchiveBase64)
	if err != nil {
		t.Fatal(err)
	}
	// The bundle should be small (< 50KB) since it only contains workflow code
	// and the workflow file itself, not the entire repo specs
	if len(data) > 50*1024 {
		t.Fatalf("bundle too large (%d bytes) - may include unwanted files; expected < 50KB for workflow-only bundle", len(data))
	}
}

func TestCodexRotationSampleBundleContents(t *testing.T) {
	repoRoot, err := findRepoRoot()
	if err != nil {
		t.Skipf("cannot find repo root: %v", err)
	}

	workflowPath := filepath.Join(repoRoot, "examples", "complex", "codex-auth-rotation-sample.tsx")
	if _, err := os.Stat(workflowPath); err != nil {
		t.Skipf("codex rotation sample workflow not found at %s: %v", workflowPath, err)
	}

	bundle, err := resolveWorkflowBundle(workflowPath)
	if err != nil {
		t.Fatalf("resolveWorkflowBundle failed for codex rotation sample: %v", err)
	}

	if bundle.WorkdirPath != "workflows/codex-auth-rotation-sample.tsx" {
		t.Fatalf("unexpected workdir path %q, want workflows/codex-auth-rotation-sample.tsx", bundle.WorkdirPath)
	}

	gotEntries := untarNames(t, bundle.ArchiveBase64)
	wantEntries := []string{
		"workflows/codex-auth-rotation-sample.tsx",
	}
	sort.Strings(gotEntries)
	if !reflect.DeepEqual(gotEntries, wantEntries) {
		t.Fatalf("archive entries mismatch\nwant: %#v\ngot: %#v", wantEntries, gotEntries)
	}
}

// TestComplexSampleBundleExcludesParentDirectoryImports verifies that
// the bundle resolution rejects attempts to import files outside the
// workflow directory, ensuring specs and other repo content must come
// from --jj-repo rather than being bundled.
func TestComplexSampleBundleExcludesParentDirectoryImports(t *testing.T) {
	// Create a temp directory structure:
	// /tmp/xxx/workflow_dir/workflow.tsx
	// /tmp/xxx/specs_dir/helper.ts (outside workflow_dir)
	baseDir := t.TempDir()
	workflowDir := filepath.Join(baseDir, "workflow_dir")
	if err := os.MkdirAll(workflowDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Create workflow that tries to import from sibling directory (outside its tree)
	workflowPath := filepath.Join(workflowDir, "workflow.tsx")
	if err := os.WriteFile(workflowPath, []byte(`
import { helper } from "../specs_dir/helper";
export default {};
`), 0o644); err != nil {
		t.Fatal(err)
	}

	// Create the specs directory outside the workflow directory
	specsDir := filepath.Join(baseDir, "specs_dir")
	if err := os.MkdirAll(specsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Create the helper file so the import resolves successfully
	if err := os.WriteFile(filepath.Join(specsDir, "helper.ts"), []byte("export const helper = 1;"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := resolveWorkflowBundle(workflowPath)
	if err == nil {
		t.Fatal("expected resolveWorkflowBundle to reject parent directory import (specs should come from --jj-repo, not be bundled)")
	}
	if !strings.Contains(err.Error(), "outside its directory tree") {
		t.Fatalf("expected error about outside directory tree, got: %v", err)
	}
}

// TestComplexSampleEnvContract verifies the environment variables expected
// by the complex sample workflow are documented in the rendered manifest.
func TestComplexSampleEnvContract(t *testing.T) {
	repoRoot, err := findRepoRoot()
	if err != nil {
		t.Skipf("cannot find repo root: %v", err)
	}

	workflowPath := filepath.Join(repoRoot, "examples", "complex", "pi-spec-implementation.tsx")
	if _, err := os.Stat(workflowPath); err != nil {
		t.Skipf("complex sample workflow not found: %v", err)
	}

	// Test that JJ_REPO and JJ_BOOKMARK are passed through when provided
	opts := Options{
		RunID:              "complex-sample-test",
		SpecPath:           "specs/complex-sample.yaml",
		Project:            "complex-sample",
		Image:              "repo/image@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		WorkflowPath:       workflowPath,
		InputJSON:          `{}`,
		JJRepo:             "https://github.com/example/repo.git",
		JJBookmark:         "feat/complex-sample",
		Namespace:          "fabrik-runs",
		PVCSize:            "10Gi",
		WaitTimeout:        "5m",
		RenderOnly:         true,
		Interactive:        false,
		AcceptFilteredSync: true,
	}

	resolved, err := ResolveOptions(context.Background(), strings.NewReader(""), &bytes.Buffer{}, opts)
	if err != nil {
		t.Fatalf("ResolveOptions failed: %v", err)
	}

	var out bytes.Buffer
	var errOut bytes.Buffer
	if err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, resolved); err != nil {
		t.Fatalf("Execute failed: %v", err)
	}

	rendered := out.String()

	// Verify JJ_REPO env var is set
	if !strings.Contains(rendered, "name: SMITHERS_JJ_REPO") {
		t.Fatalf("expected rendered manifest to include SMITHERS_JJ_REPO env var")
	}
	if !strings.Contains(rendered, "value: \"https://github.com/example/repo.git\"") {
		t.Fatalf("expected rendered manifest to include JJ_REPO value")
	}

	// Verify JJ_BOOKMARK env var is set
	if !strings.Contains(rendered, "name: SMITHERS_JJ_BOOKMARK") {
		t.Fatalf("expected rendered manifest to include SMITHERS_JJ_BOOKMARK env var")
	}
	if !strings.Contains(rendered, "value: \"feat/complex-sample\"") {
		t.Fatalf("expected rendered manifest to include JJ_BOOKMARK value")
	}
}
