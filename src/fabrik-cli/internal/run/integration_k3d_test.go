package run

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestK3dRenderAndDryRun(t *testing.T) {
	if os.Getenv("FABRIK_K3D_E2E") != "1" {
		t.Skip("set FABRIK_K3D_E2E=1 to run k3d integration tests")
	}

	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("kubectl not available")
	}

	repoRoot, err := findRepoRoot()
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}

	specPath := filepath.Join(repoRoot, "specs", "051-k3s-orchestrator.md")
	if _, err := os.Stat(specPath); err != nil {
		t.Fatalf("expected spec file for test fixture: %v", err)
	}

	renderOpts := Options{
		RunID:       "it-k3d-render",
		SpecPath:    specPath,
		Project:     "demo",
		Image:       "alpine:3.20",
		Namespace:   "default",
		PVCSize:     "1Gi",
		JobCommand:  "echo hello",
		WaitTimeout: "60s",
		RenderOnly:  true,
		Interactive: false,
	}

	var renderOut bytes.Buffer
	var renderErr bytes.Buffer
	if err := Execute(context.Background(), strings.NewReader(""), &renderOut, &renderErr, renderOpts); err != nil {
		t.Fatalf("render execute failed: %v", err)
	}
	if !strings.Contains(renderOut.String(), "kind: Job") {
		t.Fatalf("render output missing job manifest")
	}

	dryRunOpts := renderOpts
	dryRunOpts.RenderOnly = false
	dryRunOpts.DryRun = true
	var dryRunOut bytes.Buffer
	var dryRunErr bytes.Buffer
	if err := Execute(context.Background(), strings.NewReader(""), &dryRunOut, &dryRunErr, dryRunOpts); err != nil {
		t.Fatalf("dry-run execute failed: %v", err)
	}
	if !strings.Contains(dryRunOut.String(), "kind: Job") {
		t.Fatalf("dry-run output missing job manifest")
	}
}
