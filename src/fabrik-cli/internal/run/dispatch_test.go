package run

import (
	"bytes"
	"context"
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
