package run

import (
	"errors"
	runenv "fabrik-cli/internal/env"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var projectIDPattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

type Options struct {
	RunID              string
	SpecPath           string
	Project            string
	Environment        string
	EnvFile            string
	Image              string
	WorkflowPath       string
	WorkflowBundle     *WorkflowBundle
	CronSchedule       string
	InputJSON          string
	FabrikSyncFile     string
	SyncBundle         *SyncBundle
	JJRepo             string
	JJBookmark         string
	StorageClass       string
	JobCommand         string
	Namespace          string
	KubeContext        string
	PVCSize            string
	OutputSubdir       string
	WaitTimeout        string
	RunMode            string
	PreClean           bool
	Wait               bool
	RenderOnly         bool
	DryRun             bool
	AcceptFilteredSync bool
	Interactive        bool
	NonInteractive     bool
}

const envSecretNamespace = "fabrik-system"

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
	if strings.TrimSpace(opts.Environment) != "" {
		if !projectIDPattern.MatchString(opts.Environment) || len(opts.Environment) > 63 {
			return errors.New("environment name must be DNS-1123 compliant: lowercase alphanumeric + hyphens, max 63 chars")
		}
	}
	if strings.TrimSpace(opts.EnvFile) != "" {
		if strings.TrimSpace(opts.Environment) == "" {
			return errors.New("missing required flag: --env when --env-file is set")
		}
		if _, err := os.Stat(opts.EnvFile); err != nil {
			return fmt.Errorf("failed to read env file %q: %w", opts.EnvFile, err)
		}
	}
	if strings.TrimSpace(opts.Image) == "" {
		return errors.New("missing required flag: --image")
	}
	if !opts.RenderOnly && !isImmutableImageReference(opts.Image) {
		return errors.New("image must be immutable: use a digest reference like repo/image@sha256:<digest>")
	}
	if strings.TrimSpace(opts.Namespace) == "" {
		return errors.New("missing required flag: --namespace")
	}
	if strings.TrimSpace(opts.PVCSize) == "" {
		return errors.New("missing required flag: --pvc-size")
	}
	if strings.TrimSpace(opts.JobCommand) == "" && strings.TrimSpace(opts.WorkflowPath) == "" && !opts.RenderOnly && !opts.DryRun {
		return errors.New("missing required flag: --job-command")
	}
	if opts.IsCron() {
		if strings.TrimSpace(opts.CronSchedule) == "" {
			return errors.New("missing required flag: --cron")
		}
		if opts.Wait {
			return errors.New("--wait is not supported with --cron; cron creation applies the CronJob and returns after verifying it exists")
		}
	}
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		if _, err := os.Stat(opts.WorkflowPath); err != nil {
			return fmt.Errorf("failed to read workflow path %q: %w", opts.WorkflowPath, err)
		}
		if strings.TrimSpace(opts.InputJSON) == "" {
			return errors.New("missing required flag: --input-json when --workflow-path is set")
		}
		if !opts.RenderOnly && !opts.DryRun && !opts.AcceptFilteredSync && !opts.Interactive {
			return errors.New("workflow dispatch requires explicit acknowledgement of filtered artifact sync: pass --accept-filtered-sync or run interactively")
		}
	}
	if strings.TrimSpace(opts.WaitTimeout) == "" {
		return errors.New("missing required flag: --wait-timeout")
	}
	if err := validateKubeContext(opts.KubeContext); err != nil {
		return err
	}

	return nil
}

func (opts Options) IsCron() bool {
	return strings.TrimSpace(opts.CronSchedule) != ""
}

func isImmutableImageReference(image string) bool {
	return strings.Contains(image, "@sha256:")
}

func (opts Options) Summary() string {
	mode := "job"
	target := trimK8sName("fabrik-" + opts.RunID)
	if opts.IsCron() {
		mode = "cronjob"
		target = trimK8sName("fabrik-cron-" + opts.RunID)
	}
	return fmt.Sprintf(
		"run draft\n  mode: %s\n  target: %s\n  run-id: %s\n  spec: %s\n  project: %s\n  image: %s\n  namespace: %s\n  context: %s\n  pvc-size: %s\n  cron: %s\n  pre-clean: %t\n  env-file: %s\n  jj-repo: %s\n  jj-bookmark: %s",
		mode,
		target,
		opts.RunID,
		opts.SpecPath,
		opts.Project,
		opts.Image,
		opts.Namespace,
		emptyDefault(opts.KubeContext, "<current>"),
		emptyDefault(opts.PVCSize, "<none>"),
		emptyDefault(opts.CronSchedule, "<none>"),
		opts.PreClean,
		emptyDefault(opts.EnvFile, "<none>"),
		emptyDefault(opts.JJRepo, "<none>"),
		emptyDefault(opts.JJBookmark, "<none>"),
	)
}

func (opts Options) EnvSecretName() string {
	if strings.TrimSpace(opts.Environment) == "" {
		return ""
	}
	return runenv.SecretName(opts.Project, opts.Environment)
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

func resolveLocalPath(path string) (string, error) {
	if filepath.IsAbs(path) {
		return path, nil
	}
	if _, err := os.Stat(path); err == nil {
		return filepath.Abs(path)
	}
	repoRoot, err := findRepoRoot()
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(repoRoot, path)
	if _, err := os.Stat(candidate); err == nil {
		return candidate, nil
	}
	return filepath.Abs(path)
}
