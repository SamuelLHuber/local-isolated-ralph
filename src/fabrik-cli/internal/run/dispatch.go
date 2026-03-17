package run

import (
	"bytes"
	"context"
	"encoding/json"
	runenv "fabrik-cli/internal/env"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	syncPodReadyTimeout = 120 * time.Second
	syncCopyTimeout     = 10 * time.Minute
	syncCleanupTimeout  = 15 * time.Second
)

var syncWorkdirExcludes = []string{
	"node_modules",
	".next",
	"dist",
	"build",
	".git",
	".jj",
}

var copyWorkdirFromPodFn = copyWorkdirFromPod
var kubectlCopyFn = kubectlCopy

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
		if strings.TrimSpace(resolved.EnvFile) != "" {
			if _, err := runenv.LoadDotenvFile(resolved.EnvFile); err != nil {
				return err
			}
		} else {
			if err := ensureProjectEnvSecretExists(ctx, resolved); err != nil {
				return err
			}
		}
		// Dry-run does not require shared credentials to exist locally.
		// The actual credential secret is managed in-cluster via
		// fabrik credentials set.
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
		if strings.TrimSpace(resolved.WorkflowPath) != "" {
			resolved.AcceptFilteredSync = true
		}
	}

	if _, err := io.WriteString(stdout, manifests.Summary()); err != nil {
		return err
	}
	if strings.TrimSpace(resolved.WorkflowPath) != "" {
		if _, err := fmt.Fprintln(stderr, "note: workflow artifact sync excludes .git/.jj; preserve repo state via JJ/Git in the workflow prepare step, and use .fabrik-sync only for a few explicit local-only files such as .env.local"); err != nil {
			return err
		}
		if resolved.SyncBundle != nil {
			if _, err := fmt.Fprintf(stderr, "note: injecting %d .fabrik-sync file(s) from %s into /workspace/workdir before the workflow starts\n", len(resolved.SyncBundle.Files), resolved.SyncBundle.ManifestPath); err != nil {
				return err
			}
		}
	}
	if err := syncProjectEnvSecret(ctx, resolved); err != nil {
		return err
	}
	if err := prepareSharedCredentials(ctx, resolved); err != nil {
		return err
	}

	if _, err := runKubectl(ctx, resolved, manifests.AllYAML(), "apply", "-f", "-"); err != nil {
		return err
	}

	if resolved.IsCron() {
		cronJobName, schedule, err := verifyScheduledCronJob(ctx, resolved, manifests.CronJobName)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(stdout, "scheduled cronjob %s in namespace %s\nschedule: %s\n", cronJobName, resolved.Namespace, schedule)
		return err
	}

	if err := patchPVCOwnerReference(ctx, resolved, manifests.JobName, manifests.PVCName); err != nil {
		return err
	}

	if !resolved.Wait {
		podName, phase, err := verifyDispatchedJob(ctx, resolved, manifests.JobName)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(stdout, "dispatched job %s in namespace %s\npod: %s\nphase: %s\n", manifests.JobName, resolved.Namespace, podName, phase)
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
	writeRunMetadataWarning(stderr, patchRunMetadata(ctx, resolved, manifests.JobName, podName, "complete", "finished", "done", "succeeded", 1, 1))

	syncDir, err := syncArtifacts(ctx, resolved, manifests, podName)
	if err != nil {
		return err
	}

	_, err = fmt.Fprintf(stdout, "completed job %s\nartifacts: %s\n", manifests.JobName, syncDir)
	return err
}

func ResolveOptions(ctx context.Context, in io.Reader, out io.Writer, opts Options) (Options, error) {
	preflight, err := runPreflight(ctx, in, out, opts)
	if err != nil {
		return Options{}, err
	}
	resolved := preflight.Options
	if !resolved.RenderOnly && !isImmutableImageReference(resolved.Image) {
		resolved.Image, err = resolveImmutableImage(ctx, resolved.Image)
		if err != nil {
			return Options{}, fmt.Errorf("resolve immutable image for dispatch: %w", err)
		}
	}
	sharedBundle, err := resolveSharedCredentialBundle(resolved)
	if err != nil {
		return Options{}, err
	}
	if requiresSharedCredentialSync(resolved, sharedBundle) && !resolved.RenderOnly {
		helperImage := strings.TrimSpace(os.Getenv(sharedCredentialHelperImageEnv))
		if helperImage == "" {
			helperImage = defaultSharedCredentialHelperImage
		}
		resolved.SharedCredentialHelperImage = helperImage
	}
	if err := validateOptions(resolved); err != nil {
		return Options{}, err
	}
	return resolved, nil
}

func ensureProjectEnvSecretExists(ctx context.Context, opts Options) error {
	if strings.TrimSpace(opts.Environment) == "" {
		return nil
	}

	_, err := runenv.GetSecretData(ctx, runenv.Options{
		Project:   opts.Project,
		Env:       opts.Environment,
		Namespace: envSecretNamespace,
		Context:   opts.KubeContext,
	})
	if err != nil {
		if runenv.IsSecretNotFound(err) {
			return fmt.Errorf("missing project env secret %s in namespace %s", opts.EnvSecretName(), envSecretNamespace)
		}
		return fmt.Errorf("resolve project env secret %s: %w", opts.EnvSecretName(), err)
	}
	return nil
}

func syncProjectEnvSecret(ctx context.Context, opts Options) error {
	if strings.TrimSpace(opts.Environment) == "" {
		return nil
	}

	sourceOpts := runenv.Options{
		Project:   opts.Project,
		Env:       opts.Environment,
		Namespace: envSecretNamespace,
		Context:   opts.KubeContext,
	}
	if strings.TrimSpace(opts.EnvFile) != "" {
		if err := runenv.Set(ctx, io.Discard, runenv.SetOptions{
			Options:  sourceOpts,
			FromFile: opts.EnvFile,
			Replace:  true,
		}); err != nil {
			return fmt.Errorf("upsert project env secret %s from %s: %w", opts.EnvSecretName(), opts.EnvFile, err)
		}
	}
	if err := ensureProjectEnvSecretExists(ctx, opts); err != nil {
		return err
	}
	if opts.Namespace == envSecretNamespace {
		return nil
	}

	data, err := runenv.GetSecretData(ctx, sourceOpts)
	if err != nil {
		return fmt.Errorf("resolve project env secret %s for namespace sync: %w", opts.EnvSecretName(), err)
	}
	if err := runenv.ApplySecretData(ctx, runenv.Options{
		Project:   opts.Project,
		Env:       opts.Environment,
		Namespace: opts.Namespace,
		Context:   opts.KubeContext,
	}, data); err != nil {
		return fmt.Errorf("apply project env secret %s in namespace %s: %w", opts.EnvSecretName(), opts.Namespace, err)
	}
	return nil
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

func prepareSharedCredentials(ctx context.Context, opts Options) error {
	bundle, err := resolveSharedCredentialBundle(opts)
	if err != nil {
		return err
	}
	if bundle.SecretName == "" {
		return nil
	}
	switch bundle.SourceKind {
	case "file":
		return applyRunScopedSharedCredentialSecret(ctx, opts, bundle.SecretName, opts.SharedCredentialFile)
	case "dir":
		return applyRunScopedSharedCredentialSecret(ctx, opts, bundle.SecretName, opts.SharedCredentialDir)
	default:
		return mirrorSharedCredentialSecret(ctx, opts, bundle.SecretName, bundle.Optional)
	}
}

func mirrorSharedCredentialSecret(ctx context.Context, opts Options, secretName string, optional bool) error {
	if opts.Namespace == envSecretNamespace {
		if !optional {
			if _, err := runKubectl(ctx, opts, "", "-n", envSecretNamespace, "get", "secret", secretName); err != nil {
				return fmt.Errorf("resolve shared credential secret %s: %w", secretName, err)
			}
		}
		return nil
	}

	out, err := runKubectl(ctx, opts, "", "-n", envSecretNamespace, "get", "secret", secretName, "-o", "jsonpath={.data}", "--ignore-not-found")
	if err != nil {
		return fmt.Errorf("read shared credential secret %s: %w", secretName, err)
	}
	raw := strings.TrimSpace(out)
	if raw == "" {
		if !optional {
			return fmt.Errorf("shared credential secret %s not found in namespace %s", secretName, envSecretNamespace)
		}
		return applySharedCredentialSecretData(ctx, opts, secretName, nil)
	}
	if raw == "{}" {
		return applySharedCredentialSecretData(ctx, opts, secretName, map[string]string{})
	}
	var dataMap map[string]string
	if err := json.Unmarshal([]byte(raw), &dataMap); err != nil {
		return fmt.Errorf("parse shared credential secret %s: %w", secretName, err)
	}
	return applySharedCredentialSecretData(ctx, opts, secretName, dataMap)
}

func applySharedCredentialSecretData(ctx context.Context, opts Options, secretName string, dataMap map[string]string) error {
	manifest := renderOpaqueSecretManifest(opts.Namespace, secretName, dataMap)
	if _, err := runKubectl(ctx, opts, manifest, "apply", "-f", "-"); err != nil {
		return fmt.Errorf("mirror shared credential secret %s to %s: %w", secretName, opts.Namespace, err)
	}
	return nil
}

func renderOpaqueSecretManifest(namespace, secretName string, dataMap map[string]string) string {
	var b strings.Builder
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: Secret\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + secretName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	b.WriteString("type: Opaque\n")
	if len(dataMap) == 0 {
		b.WriteString("data: {}\n")
		return b.String()
	}
	b.WriteString("data:\n")
	keys := make([]string, 0, len(dataMap))
	for key := range dataMap {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		b.WriteString("  " + key + ": " + yamlQuote(dataMap[key]) + "\n")
	}
	return b.String()
}

func applyRunScopedSharedCredentialSecret(ctx context.Context, opts Options, secretName, fromPath string) error {
	args := []string{}
	if opts.KubeContext != "" {
		args = append(args, "--context", opts.KubeContext)
	}
	args = append(args, "-n", opts.Namespace, "create", "secret", "generic", secretName, "--dry-run=client", "-o", "yaml", "--from-file="+fromPath)
	cmd := exec.CommandContext(ctx, "kubectl", args...)
	rendered, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("render run-scoped shared credential secret %s: %w", secretName, err)
	}
	if _, err := runKubectl(ctx, opts, string(rendered), "apply", "-f", "-"); err != nil {
		return fmt.Errorf("apply run-scoped shared credential secret %s: %w", secretName, err)
	}
	return nil
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

func patchRunMetadata(ctx context.Context, opts Options, jobName, podName, phase, status, task, outcome string, finished, total int) error {
	finishedAt := buildStartedAt()
	statusJSON, err := json.Marshal(map[string]any{
		"phase":        phase,
		"current_task": task,
		"attempt":      1,
		"progress": map[string]int{
			"finished": finished,
			"total":    total,
		},
	})
	if err != nil {
		return err
	}

	progressJSON, err := json.Marshal(map[string]int{
		"finished": finished,
		"total":    total,
	})
	if err != nil {
		return err
	}
	patch, err := json.Marshal(map[string]any{
		"metadata": map[string]any{
			"labels": map[string]string{
				"fabrik.sh/phase":  phase,
				"fabrik.sh/status": status,
				"fabrik.sh/task":   task,
			},
			"annotations": map[string]string{
				"fabrik.sh/status":      string(statusJSON),
				"fabrik.sh/finished-at": finishedAt,
				"fabrik.sh/outcome":     outcome,
				"fabrik.sh/progress":    string(progressJSON),
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
		writeRunMetadataWarning(stderr, patchRunMetadata(ctx, opts, jobName, podName, "complete", "finished", "done", "failed", 1, 1))
		if logs, logErr := runKubectl(ctx, opts, "", "-n", opts.Namespace, "logs", podName, "--tail=200"); logErr == nil {
			_, _ = fmt.Fprintf(stderr, "recent logs for %s:\n%s\n", podName, logs)
		}
	}
	return waitErr
}

func writeRunMetadataWarning(stderr io.Writer, err error) {
	if err == nil || stderr == nil {
		return
	}
	_, _ = fmt.Fprintf(stderr, "warning: failed to update Fabrik run metadata; use native Kubernetes Job/Pod status as source of truth: %v\n", err)
}

func verifyDispatchedJob(ctx context.Context, opts Options, jobName string) (string, string, error) {
	verifyTimeout := dispatchVerificationTimeout(opts.WaitTimeout)
	verifyCtx, cancel := context.WithTimeout(ctx, verifyTimeout)
	defer cancel()

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	var lastErr error
	for {
		podName, err := getJobPodName(verifyCtx, opts, jobName)
		if err == nil {
			phase, phaseErr := getPodPhase(verifyCtx, opts, podName)
			if phaseErr != nil {
				lastErr = phaseErr
			} else {
				switch phase {
				case "Pending", "Running", "Succeeded":
					return podName, phase, nil
				case "Failed":
					return "", "", fmt.Errorf("job %s started but pod %s entered Failed phase", jobName, podName)
				default:
					lastErr = fmt.Errorf("job %s pod %s is in unexpected phase %q", jobName, podName, phase)
				}
			}
		} else {
			lastErr = err
		}

		select {
		case <-verifyCtx.Done():
			return "", "", fmt.Errorf("job %s did not reach a started state within %s: %w", jobName, verifyTimeout, lastErr)
		case <-ticker.C:
		}
	}
}

func verifyScheduledCronJob(ctx context.Context, opts Options, cronJobName string) (string, string, error) {
	verifyTimeout := dispatchVerificationTimeout(opts.WaitTimeout)
	verifyCtx, cancel := context.WithTimeout(ctx, verifyTimeout)
	defer cancel()

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	var lastErr error
	for {
		schedule, err := getCronJobSchedule(verifyCtx, opts, cronJobName)
		if err == nil {
			return cronJobName, schedule, nil
		}
		lastErr = err

		select {
		case <-verifyCtx.Done():
			return "", "", fmt.Errorf("cronjob %s did not become readable within %s: %w", cronJobName, verifyTimeout, lastErr)
		case <-ticker.C:
		}
	}
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

func getPodPhase(ctx context.Context, opts Options, podName string) (string, error) {
	out, err := runKubectl(ctx, opts, "", "-n", opts.Namespace, "get", "pod", podName, "-o", "jsonpath={.status.phase}")
	if err != nil {
		return "", err
	}
	phase := strings.TrimSpace(out)
	if phase == "" {
		return "", fmt.Errorf("failed to resolve phase for pod %s", podName)
	}
	return phase, nil
}

func getCronJobSchedule(ctx context.Context, opts Options, cronJobName string) (string, error) {
	out, err := runKubectl(ctx, opts, "", "-n", opts.Namespace, "get", "cronjob", cronJobName, "-o", "jsonpath={.spec.schedule}")
	if err != nil {
		return "", err
	}
	schedule := strings.TrimSpace(out)
	if schedule == "" {
		return "", fmt.Errorf("failed to resolve schedule for cronjob %s", cronJobName)
	}
	return schedule, nil
}

func dispatchVerificationTimeout(waitTimeout string) time.Duration {
	maximum := 30 * time.Second
	parsed, err := time.ParseDuration(waitTimeout)
	if err != nil || parsed <= 0 {
		return maximum
	}
	if parsed < maximum {
		return parsed
	}
	return maximum
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
	syncPodName := buildSyncPodName(opts.RunID)
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
	// Local post-run sync is intentionally artifact-focused. Repository history should be
	// preserved through JJ/Git inside the workflow, while `.fabrik-sync` only injects a few
	// explicit local-only files ahead of execution.
	workdir := filepath.Join(targetDir, "workdir")
	_ = os.RemoveAll(workdir)
	if err := copyWorkdirFromPodFn(ctx, opts, syncPodName, workdir); err != nil {
		return "", err
	}
	stateDB := filepath.Join(targetDir, "state.db")
	exists, err := podFileExists(ctx, opts, syncPodName, "/workspace/.smithers/state.db")
	if err != nil {
		return "", err
	}
	if exists {
		if err := kubectlCopyFn(ctx, opts, syncPodName+":/workspace/.smithers/state.db", stateDB); err != nil {
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
	// Artifact sync is intentionally filtered: .git/.jj are not a reliable thing to round-trip
	// through the Kubernetes API stream. Preserve repository state via JJ/Git inside the workflow,
	// and use `.fabrik-sync` only for a few explicit local-only files that must be injected.
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

func buildSyncPodName(runID string) string {
	return trimK8sName(fmt.Sprintf("fabrik-sync-%s-%d", sanitizeName(runID), time.Now().UTC().Unix()))
}
