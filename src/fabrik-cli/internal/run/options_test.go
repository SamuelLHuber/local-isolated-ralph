package run

import "testing"

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
