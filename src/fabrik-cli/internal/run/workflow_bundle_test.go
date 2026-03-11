package run

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
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
