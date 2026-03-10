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
