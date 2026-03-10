package run

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func Execute(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer, opts Options) error {
	resolved, err := ResolveOptions(ctx, stdin, stdout, opts)
	if err != nil {
		return err
	}

	manifests, err := BuildManifests(resolved)
	if err != nil {
		return err
	}

	if resolved.RenderOnly {
		_, err := io.WriteString(stdout, manifests.AllYAML())
		return err
	}

	if resolved.DryRun {
		if strings.TrimSpace(resolved.WorkflowPath) != "" {
			if err := applyCodexSecret(ctx, resolved); err != nil {
				return err
			}
		}
		out, err := runKubectl(ctx, resolved, manifests.AllYAML(), "apply", "--dry-run=client", "-o", "yaml", "-f", "-")
		if err != nil {
			return err
		}
		_, err = io.WriteString(stdout, out)
		return err
	}

	if resolved.Interactive {
		ok, err := confirmDispatch(ctx, stdin, stdout, resolved)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("dispatch cancelled")
		}
	}

	if _, err := io.WriteString(stdout, manifests.Summary()); err != nil {
		return err
	}
	if strings.TrimSpace(resolved.WorkflowPath) != "" {
		if err := applyCodexSecret(ctx, resolved); err != nil {
			return err
		}
	}

	if _, err := runKubectl(ctx, resolved, manifests.AllYAML(), "apply", "-f", "-"); err != nil {
		return err
	}

	if err := patchPVCOwnerReference(ctx, resolved, manifests.JobName, manifests.PVCName); err != nil {
		return err
	}

	if !resolved.Wait {
		_, err := fmt.Fprintf(stdout, "dispatched job %s in namespace %s\n", manifests.JobName, resolved.Namespace)
		return err
	}

	if _, err := fmt.Fprintf(stdout, "waiting for job/%s\n", manifests.JobName); err != nil {
		return err
	}

	if _, err := runKubectl(ctx, resolved, "", "-n", resolved.Namespace, "wait", "--for=condition=complete", "--timeout="+resolved.WaitTimeout, "job/"+manifests.JobName); err != nil {
		return handleWaitFailure(ctx, stderr, resolved, manifests.JobName, err)
	}

	podName, err := getJobPodName(ctx, resolved, manifests.JobName)
	if err != nil {
		return err
	}

	syncDir, err := syncArtifacts(ctx, resolved, manifests, podName)
	if err != nil {
		return err
	}

	_, err = fmt.Fprintf(stdout, "completed job %s\nartifacts: %s\n", manifests.JobName, syncDir)
	return err
}

func ResolveOptions(ctx context.Context, in io.Reader, out io.Writer, opts Options) (Options, error) {
	var err error
	if opts.Interactive {
		opts, err = promptForMissing(ctx, in, out, opts)
		if err != nil {
			return Options{}, err
		}
	}
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		opts.WorkflowPath, err = resolveLocalPath(opts.WorkflowPath)
		if err != nil {
			return Options{}, err
		}
	}
	if err := validateOptions(opts); err != nil {
		return Options{}, err
	}
	return opts, nil
}

func runKubectl(ctx context.Context, opts Options, stdin string, args ...string) (string, error) { /* unchanged */
	cmdArgs := make([]string, 0, len(args)+2)
	if strings.TrimSpace(opts.KubeContext) != "" {
		cmdArgs = append(cmdArgs, "--context", opts.KubeContext)
	}
	cmdArgs = append(cmdArgs, args...)

	cmd := exec.CommandContext(ctx, "kubectl", cmdArgs...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(cmdArgs, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func applyCodexSecret(ctx context.Context, opts Options) error {
	authFile := filepath.Join(os.Getenv("HOME"), ".codex", "auth.json")
	configFile := filepath.Join(os.Getenv("HOME"), ".codex", "config.toml")

	if _, err := os.Stat(authFile); err != nil {
		return fmt.Errorf("missing codex auth file %s: %w", authFile, err)
	}
	if _, err := os.Stat(configFile); err != nil {
		return fmt.Errorf("missing codex config file %s: %w", configFile, err)
	}

	cmdArgs := []string{}
	if strings.TrimSpace(opts.KubeContext) != "" {
		cmdArgs = append(cmdArgs, "--context", opts.KubeContext)
	}
	cmdArgs = append(cmdArgs,
		"-n", opts.Namespace,
		"create", "secret", "generic", "codex-auth",
		"--from-file=auth.json="+authFile,
		"--from-file=config.toml="+configFile,
		"--dry-run=client",
		"-o", "yaml",
	)

	cmd := exec.CommandContext(ctx, "kubectl", cmdArgs...)
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("kubectl %s failed: %w", strings.Join(cmdArgs, " "), err)
	}

	_, err = runKubectl(ctx, opts, string(out), "apply", "-f", "-")
	return err
}

func patchPVCOwnerReference(ctx context.Context, opts Options, jobName, pvcName string) error { /* unchanged */
	jobUID, err := runKubectl(ctx, opts, "", "-n", opts.Namespace, "get", "job", jobName, "-o", "jsonpath={.metadata.uid}")
	if err != nil {
		return err
	}

	payload, err := json.Marshal(map[string]any{"metadata": map[string]any{"ownerReferences": []map[string]string{{"apiVersion": "batch/v1", "kind": "Job", "name": jobName, "uid": strings.TrimSpace(jobUID)}}}})
	if err != nil {
		return err
	}

	_, err = runKubectl(ctx, opts, "", "-n", opts.Namespace, "patch", "pvc", pvcName, "--type=merge", "-p", string(payload))
	return err
}

func handleWaitFailure(ctx context.Context, stderr io.Writer, opts Options, jobName string, waitErr error) error {
	podName, podErr := getJobPodName(ctx, opts, jobName)
	if podErr == nil {
		if logs, logErr := runKubectl(ctx, opts, "", "-n", opts.Namespace, "logs", podName, "--tail=200"); logErr == nil {
			fmt.Fprintf(stderr, "recent logs for %s:\n%s\n", podName, logs)
		}
	}
	return waitErr
}

func getJobPodName(ctx context.Context, opts Options, jobName string) (string, error) { /* unchanged */
	out, err := runKubectl(ctx, opts, "", "-n", opts.Namespace, "get", "pods", "-l", "job-name="+jobName, "-o", "jsonpath={.items[0].metadata.name}")
	if err != nil {
		return "", err
	}
	podName := strings.TrimSpace(out)
	if podName == "" {
		return "", fmt.Errorf("failed to resolve pod for job %s", jobName)
	}
	return podName, nil
}

func syncArtifacts(ctx context.Context, opts Options, manifests Manifests, podName string) (string, error) { /* unchanged */
	repoRoot, err := findRepoRoot()
	if err != nil {
		return "", err
	}
	safeRunID := sanitizeName(opts.RunID)
	targetDir := filepath.Join(repoRoot, opts.OutputSubdir, safeRunID)
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(targetDir, "run-id.txt"), []byte(opts.RunID+"\n"), 0o644); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(targetDir, "manifests.yaml"), []byte(manifests.AllYAML()), 0o644); err != nil {
		return "", err
	}
	logs, err := runKubectl(ctx, opts, "", "-n", opts.Namespace, "logs", podName)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(targetDir, "job.log"), []byte(logs), 0o644); err != nil {
		return "", err
	}
	syncPodName := trimK8sName("fabrik-sync-" + sanitizeName(opts.RunID))
	if _, err := runKubectl(ctx, opts, "", "-n", opts.Namespace, "delete", "pod", syncPodName, "--ignore-not-found"); err != nil {
		return "", err
	}
	if _, err := runKubectl(ctx, opts, buildSyncPodYAML(opts.Namespace, syncPodName, manifests.PVCName), "apply", "-f", "-"); err != nil {
		return "", err
	}
	defer func() {
		_, _ = runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "pod", syncPodName, "--ignore-not-found")
	}()
	if _, err := runKubectl(ctx, opts, "", "-n", opts.Namespace, "wait", "--for=condition=Ready", "--timeout=120s", "pod/"+syncPodName); err != nil {
		return "", err
	}
	workdir := filepath.Join(targetDir, "workdir")
	_ = os.RemoveAll(workdir)
	cpArgs := []string{}
	if strings.TrimSpace(opts.KubeContext) != "" {
		cpArgs = append(cpArgs, "--context", opts.KubeContext)
	}
	cpArgs = append(cpArgs, "-n", opts.Namespace, "cp", syncPodName+":/workspace/workdir", workdir)
	cpCmd := exec.CommandContext(ctx, "kubectl", cpArgs...)
	cpOut, err := cpCmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(cpArgs, " "), err, strings.TrimSpace(string(cpOut)))
	}
	stateDB := filepath.Join(targetDir, "state.db")
	cpArgs = cpArgs[:0]
	if strings.TrimSpace(opts.KubeContext) != "" {
		cpArgs = append(cpArgs, "--context", opts.KubeContext)
	}
	cpArgs = append(cpArgs, "-n", opts.Namespace, "cp", syncPodName+":/workspace/.smithers/state.db", stateDB)
	cpCmd = exec.CommandContext(ctx, "kubectl", cpArgs...)
	cpOut, err = cpCmd.CombinedOutput()
	if err != nil && !bytes.Contains(cpOut, []byte("No such file")) {
		return "", fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(cpArgs, " "), err, strings.TrimSpace(string(cpOut)))
	}
	return targetDir, nil
}

func findRepoRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	current := wd
	for {
		if stat, err := os.Stat(filepath.Join(current, ".git")); err == nil && stat != nil {
			return current, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("failed to locate repo root from %s", wd)
		}
		current = parent
	}
}

func buildStartedAt() string { return time.Now().UTC().Format(time.RFC3339) }
