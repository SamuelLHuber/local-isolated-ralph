package run

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

var projectIDPattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

type Options struct {
	RunID          string
	SpecPath       string
	Project        string
	Image          string
	StorageClass   string
	JobCommand     string
	Namespace      string
	KubeContext    string
	PVCSize        string
	OutputSubdir   string
	WaitTimeout    string
	PreClean       bool
	Wait           bool
	RenderOnly     bool
	DryRun         bool
	Interactive    bool
	NonInteractive bool
}

func ResolveOptions(ctx context.Context, opts Options) (Options, error) {
	var err error
	if opts.Interactive {
		opts, err = promptForMissing(ctx, opts)
		if err != nil {
			return Options{}, err
		}
	}

	if err := validateOptions(opts); err != nil {
		return Options{}, err
	}

	return opts, nil
}

func validateOptions(opts Options) error {
	if strings.TrimSpace(opts.RunID) == "" {
		return errors.New("missing required flag: --run-id")
	}
	if strings.TrimSpace(opts.SpecPath) == "" {
		return errors.New("missing required flag: --spec")
	}
	if strings.TrimSpace(opts.Project) == "" {
		return errors.New("missing required flag: --project")
	}
	if !projectIDPattern.MatchString(opts.Project) || len(opts.Project) > 63 {
		return errors.New("project ID must be DNS-1123 compliant: lowercase alphanumeric + hyphens, max 63 chars")
	}
	if strings.TrimSpace(opts.Image) == "" {
		return errors.New("missing required flag: --image")
	}
	if !isImmutableImageReference(opts.Image) {
		return errors.New("image must be immutable: use a digest or a pinned non-latest tag")
	}
	if strings.TrimSpace(opts.Namespace) == "" {
		return errors.New("missing required flag: --namespace")
	}
	if strings.TrimSpace(opts.PVCSize) == "" {
		return errors.New("missing required flag: --pvc-size")
	}
	if strings.TrimSpace(opts.JobCommand) == "" && !opts.RenderOnly && !opts.DryRun {
		return errors.New("missing required flag: --job-command")
	}
	if strings.TrimSpace(opts.WaitTimeout) == "" {
		return errors.New("missing required flag: --wait-timeout")
	}
	if err := validateKubeContext(opts.KubeContext); err != nil {
		return err
	}

	return nil
}

func isImmutableImageReference(image string) bool {
	if strings.Contains(image, "@sha256:") {
		return true
	}

	lastColon := strings.LastIndex(image, ":")
	lastSlash := strings.LastIndex(image, "/")
	if lastColon <= lastSlash {
		return false
	}

	tag := image[lastColon+1:]
	if tag == "" || tag == "latest" {
		return false
	}

	return true
}

func (opts Options) Summary() string {
	return fmt.Sprintf(
		"run draft\n  run-id: %s\n  spec: %s\n  project: %s\n  image: %s\n  namespace: %s\n  context: %s\n  pvc-size: %s\n  pre-clean: %t",
		opts.RunID,
		opts.SpecPath,
		opts.Project,
		opts.Image,
		opts.Namespace,
		emptyDefault(opts.KubeContext, "<current>"),
		opts.PVCSize,
		opts.PreClean,
	)
}

func emptyDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}

	return value
}

func validateKubeContext(contextName string) error {
	if strings.TrimSpace(contextName) == "" {
		return nil
	}

	cmd := exec.Command("kubectl", "config", "get-contexts", contextName, "-o", "name")
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to resolve kubernetes context %q: %w", contextName, err)
	}

	resolved := strings.TrimSpace(string(out))
	if resolved == "" {
		return fmt.Errorf("kubernetes context %q was not found", contextName)
	}

	return nil
}
