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

const (
	syncPodReadyTimeout = 120 * time.Second
	syncCopyTimeout     = 2 * time.Minute
	syncCleanupTimeout  = 15 * time.Second
)

var syncWorkdirExcludes = []string{
	"node_modules",
	".git",
	".jj",
	".next",
	"dist",
	"build",
}

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
	if err := patchCompletedRunMetadata(ctx, resolved, manifests.JobName, podName); err != nil {
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
		if strings.TrimSpace(opts.Image) == "" {
			opts.Image, err = resolveDefaultWorkflowImage(ctx)
			if err != nil {
				return Options{}, err
			}
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

func patchCompletedRunMetadata(ctx context.Context, opts Options, jobName, podName string) error {
	finishedAt := buildStartedAt()
	statusJSON, err := json.Marshal(map[string]any{
		"phase":        "complete",
		"current_task": "done",
		"attempt":      1,
		"progress": map[string]int{
			"finished": 1,
			"total":    1,
		},
	})
	if err != nil {
		return err
	}

	progressJSON := `{"finished":1,"total":1}`
	patch, err := json.Marshal(map[string]any{
		"metadata": map[string]any{
			"labels": map[string]string{
				"fabrik.sh/phase":  "complete",
				"fabrik.sh/status": "finished",
				"fabrik.sh/task":   "done",
			},
			"annotations": map[string]string{
				"fabrik.sh/status":      string(statusJSON),
				"fabrik.sh/finished-at": finishedAt,
				"fabrik.sh/outcome":     "succeeded",
				"fabrik.sh/progress":    progressJSON,
			},
		},
	})
	if err != nil {
		return err
	}

	if _, err := runKubectl(ctx, opts, "", "-n", opts.Namespace, "patch", "job", jobName, "--type=merge", "-p", string(patch)); err != nil {
		return err
	}
	_, err = runKubectl(ctx, opts, "", "-n", opts.Namespace, "patch", "pod", podName, "--type=merge", "-p", string(patch))
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
		cleanupCtx, cancel := context.WithTimeout(context.Background(), syncCleanupTimeout)
		defer cancel()
		_, _ = runKubectl(cleanupCtx, opts, "", "-n", opts.Namespace, "delete", "pod", syncPodName, "--ignore-not-found", "--wait=false")
	}()
	if _, err := runKubectl(ctx, opts, "", "-n", opts.Namespace, "wait", "--for=condition=Ready", "--timeout="+syncPodReadyTimeout.String(), "pod/"+syncPodName); err != nil {
		return "", err
	}
	workdir := filepath.Join(targetDir, "workdir")
	_ = os.RemoveAll(workdir)
	if err := copyWorkdirFromPod(ctx, opts, syncPodName, workdir); err != nil {
		return "", err
	}
	stateDB := filepath.Join(targetDir, "state.db")
	exists, err := podFileExists(ctx, opts, syncPodName, "/workspace/.smithers/state.db")
	if err != nil {
		return "", err
	}
	if exists {
		if err := kubectlCopy(ctx, opts, syncPodName+":/workspace/.smithers/state.db", stateDB); err != nil {
			return "", err
		}
	}
	return targetDir, nil
}

func kubectlCopy(ctx context.Context, opts Options, source, destination string) error {
	copyCtx, cancel := context.WithTimeout(ctx, syncCopyTimeout)
	defer cancel()

	cpArgs := []string{}
	if strings.TrimSpace(opts.KubeContext) != "" {
		cpArgs = append(cpArgs, "--context", opts.KubeContext)
	}
	cpArgs = append(cpArgs, "-n", opts.Namespace, "cp", source, destination)
	cpCmd := exec.CommandContext(copyCtx, "kubectl", cpArgs...)
	cpOut, err := cpCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(cpArgs, " "), err, strings.TrimSpace(string(cpOut)))
	}
	return nil
}

func copyWorkdirFromPod(ctx context.Context, opts Options, podName, destination string) error {
	copyCtx, cancel := context.WithTimeout(ctx, syncCopyTimeout)
	defer cancel()

	if err := os.MkdirAll(destination, 0o755); err != nil {
		return err
	}

	args := []string{}
	if strings.TrimSpace(opts.KubeContext) != "" {
		args = append(args, "--context", opts.KubeContext)
	}
	args = append(args, "-n", opts.Namespace, "exec", podName, "--", "tar", "-C", "/workspace/workdir")
	for _, pattern := range syncWorkdirExcludes {
		args = append(args, "--exclude="+pattern)
	}
	args = append(args, "-cf", "-", ".")

	sourceCmd := exec.CommandContext(copyCtx, "kubectl", args...)
	sourceStdout, err := sourceCmd.StdoutPipe()
	if err != nil {
		return err
	}
	var sourceStderr bytes.Buffer
	sourceCmd.Stderr = &sourceStderr

	extractCmd := exec.CommandContext(copyCtx, "tar", "-xf", "-", "-C", destination)
	extractCmd.Stdin = sourceStdout
	var extractStderr bytes.Buffer
	extractCmd.Stderr = &extractStderr

	if err := extractCmd.Start(); err != nil {
		return err
	}
	if err := sourceCmd.Start(); err != nil {
		_ = extractCmd.Process.Kill()
		_ = extractCmd.Wait()
		return err
	}

	sourceErr := sourceCmd.Wait()
	extractErr := extractCmd.Wait()
	if sourceErr != nil {
		return fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(args, " "), sourceErr, strings.TrimSpace(sourceStderr.String()))
	}
	if extractErr != nil {
		return fmt.Errorf("tar extract into %s failed: %w\n%s", destination, extractErr, strings.TrimSpace(extractStderr.String()))
	}
	return nil
}

func podFileExists(ctx context.Context, opts Options, podName, filePath string) (bool, error) {
	execCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	args := []string{}
	if strings.TrimSpace(opts.KubeContext) != "" {
		args = append(args, "--context", opts.KubeContext)
	}
	args = append(args, "-n", opts.Namespace, "exec", podName, "--", "test", "-f", filePath)

	cmd := exec.CommandContext(execCtx, "kubectl", args...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return true, nil
	}

	if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
		return false, nil
	}

	return false, fmt.Errorf("kubectl %s failed: %w\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
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
