package run

import (
	"context"
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
	if err := validateOptions(opts); err != nil {
		t.Fatalf("expected dry-run validation success, got error: %v", err)
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
		t.Fatalf("did not expect dry-run flow to resolve image %q", image)
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
		DryRun:      true,
	}

	resolved, err := ResolveOptions(context.Background(), nil, nil, opts)
	if err != nil {
		t.Fatalf("expected resolution success, got error: %v", err)
	}
	if resolved.Image != "repo/image:v1.2.3" {
		t.Fatalf("expected original tagged image, got %q", resolved.Image)
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
