package run

import (
	"bytes"
	"context"
	runenv "fabrik-cli/internal/env"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestK3dCronSchedulesCommandAndWorkflowJobs(t *testing.T) {
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

	workflowPath := filepath.Join(repoRoot, "examples", "counter-local", "workflow.tsx")
	if _, err := os.Stat(workflowPath); err != nil {
		t.Fatalf("expected workflow fixture for test fixture: %v", err)
	}

	if _, _, err := ensureCodexAuthFilesExist(); err != nil {
		t.Skipf("workflow cron integration needs local Codex auth files: %v", err)
	}

	opts := Options{
		Namespace:   "fabrik-runs",
		KubeContext: currentK3dContext(t),
		PVCSize:     "1Gi",
		WaitTimeout: "90s",
		Interactive: false,
	}

	suffix := time.Now().Unix()
	commandRunID := fmt.Sprintf("it-k3d-cron-cmd-%d", suffix)
	workflowRunID := fmt.Sprintf("it-k3d-cron-wf-%d", suffix)
	project := "demo"
	environment := "dev"

	cleanupCronRun(t, opts, commandRunID)
	cleanupCronRun(t, opts, workflowRunID)
	ensureProjectEnvSecret(t, opts.KubeContext, project, environment)
	t.Cleanup(func() {
		cleanupCronRun(t, opts, commandRunID)
		cleanupCronRun(t, opts, workflowRunID)
	})

	commandOpts := opts
	commandOpts.RunID = commandRunID
	commandOpts.SpecPath = specPath
	commandOpts.Project = project
	commandOpts.Environment = environment
	commandOpts.Image = "alpine:3.20"
	commandOpts.CronSchedule = "* * * * *"
	commandOpts.JobCommand = "echo cron command path"
	if err := Execute(context.Background(), strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}, commandOpts); err != nil {
		t.Fatalf("command cron execute failed: %v", err)
	}

	workflowOpts := opts
	workflowOpts.RunID = workflowRunID
	workflowOpts.SpecPath = specPath
	workflowOpts.Project = project
	workflowOpts.Environment = environment
	workflowOpts.WorkflowPath = workflowPath
	workflowOpts.InputJSON = `{"appName":"cron-k3d-it"}`
	workflowOpts.CronSchedule = "* * * * *"
	workflowOpts.AcceptFilteredSync = true
	if err := Execute(context.Background(), strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}, workflowOpts); err != nil {
		t.Fatalf("workflow cron execute failed: %v", err)
	}

	waitForNextCronTick(t)

	commandJobName := waitForCronChildJob(t, opts, commandRunID, 30*time.Second)
	if commandJobName == "" {
		t.Fatalf("expected a child job for command cron run %s", commandRunID)
	}

	workflowJobName := waitForCronChildJob(t, opts, workflowRunID, 30*time.Second)
	if workflowJobName == "" {
		t.Fatalf("expected a child job for workflow cron run %s", workflowRunID)
	}

	commandPodName := waitForJobPod(t, opts, commandJobName, 30*time.Second)
	if commandPodName == "" {
		t.Fatalf("expected pod for command cron child job %s", commandJobName)
	}
	assertEphemeralWorkspacePVC(t, opts, commandPodName)
	assertProjectEnvInjectionOnJob(t, opts, commandJobName, project, environment)

	workflowPodName := waitForJobPod(t, opts, workflowJobName, 30*time.Second)
	if workflowPodName == "" {
		t.Fatalf("expected pod for workflow cron child job %s", workflowJobName)
	}
	assertEphemeralWorkspacePVC(t, opts, workflowPodName)
	assertProjectEnvInjectionOnJob(t, opts, workflowJobName, project, environment)

	workflowConfigMap := trimK8sName("fabrik-workflow-" + sanitizeName(workflowRunID))
	configName, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "job", workflowJobName, "-o", "jsonpath={.spec.template.spec.volumes[2].configMap.name}")
	if err != nil {
		t.Fatalf("resolve workflow config map from child job: %v", err)
	}
	if strings.TrimSpace(configName) != workflowConfigMap {
		t.Fatalf("expected workflow child job to reference configmap %s, got %q", workflowConfigMap, strings.TrimSpace(configName))
	}
}

func TestK3dRunInjectsProjectEnvForCommandAndWorkflow(t *testing.T) {
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
	workflowPath := filepath.Join(repoRoot, "examples", "counter-local", "workflow.tsx")
	if _, err := os.Stat(workflowPath); err != nil {
		t.Fatalf("expected workflow fixture for test fixture: %v", err)
	}

	if _, _, err := ensureCodexAuthFilesExist(); err != nil {
		t.Skipf("workflow integration needs local Codex auth files: %v", err)
	}

	opts := Options{
		Namespace:   "fabrik-runs",
		KubeContext: currentK3dContext(t),
		PVCSize:     "1Gi",
		WaitTimeout: "90s",
		Interactive: false,
	}

	project := "demo"
	environment := "dev"
	ensureProjectEnvSecret(t, opts.KubeContext, project, environment)

	suffix := time.Now().Unix()
	commandRunID := fmt.Sprintf("it-k3d-run-cmd-env-%d", suffix)
	workflowRunID := fmt.Sprintf("it-k3d-run-wf-env-%d", suffix)
	cleanupJobRun(t, opts, commandRunID)
	cleanupJobRun(t, opts, workflowRunID)
	t.Cleanup(func() {
		cleanupJobRun(t, opts, commandRunID)
		cleanupJobRun(t, opts, workflowRunID)
	})

	commandOpts := opts
	commandOpts.RunID = commandRunID
	commandOpts.SpecPath = specPath
	commandOpts.Project = project
	commandOpts.Environment = environment
	commandOpts.Image = "alpine:3.20"
	commandOpts.JobCommand = "echo env command path && sleep 3"
	if err := Execute(context.Background(), strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}, commandOpts); err != nil {
		t.Fatalf("command execute failed: %v", err)
	}

	commandJobName := trimK8sName("fabrik-" + sanitizeName(commandRunID))
	waitForJobPresence(t, opts, commandJobName, 30*time.Second)
	assertProjectEnvInjectionOnJob(t, opts, commandJobName, project, environment)

	workflowOpts := opts
	workflowOpts.RunID = workflowRunID
	workflowOpts.SpecPath = specPath
	workflowOpts.Project = project
	workflowOpts.Environment = environment
	workflowOpts.WorkflowPath = workflowPath
	workflowOpts.InputJSON = `{"appName":"run-k3d-it"}`
	workflowOpts.AcceptFilteredSync = true
	if err := Execute(context.Background(), strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}, workflowOpts); err != nil {
		t.Fatalf("workflow execute failed: %v", err)
	}

	workflowJobName := trimK8sName("fabrik-" + sanitizeName(workflowRunID))
	waitForJobPresence(t, opts, workflowJobName, 30*time.Second)
	assertProjectEnvInjectionOnJob(t, opts, workflowJobName, project, environment)
}

func currentK3dContext(t *testing.T) string {
	t.Helper()

	out, err := exec.Command("kubectl", "config", "current-context").Output()
	if err != nil {
		t.Fatalf("resolve current kubectl context: %v", err)
	}

	contextName := strings.TrimSpace(string(out))
	if contextName == "" {
		t.Fatalf("kubectl current-context was empty")
	}

	return contextName
}

func cleanupCronRun(t *testing.T, opts Options, runID string) {
	t.Helper()

	cronJobName := trimK8sName("fabrik-cron-" + sanitizeName(runID))
	workflowConfigName := trimK8sName("fabrik-workflow-" + sanitizeName(runID))
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "cronjob", cronJobName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete cronjob %s: %v", cronJobName, err)
	}
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "jobs", "-l", "fabrik.sh/run-id="+runID, "--ignore-not-found"); err != nil {
		t.Fatalf("delete cron child jobs for %s: %v", runID, err)
	}
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "configmap", workflowConfigName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete workflow configmap %s: %v", workflowConfigName, err)
	}
}

func cleanupJobRun(t *testing.T, opts Options, runID string) {
	t.Helper()

	jobName := trimK8sName("fabrik-" + sanitizeName(runID))
	pvcName := trimK8sName("data-fabrik-" + sanitizeName(runID))
	workflowConfigName := trimK8sName("fabrik-workflow-" + sanitizeName(runID))
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "job", jobName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete job %s: %v", jobName, err)
	}
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "pvc", pvcName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete pvc %s: %v", pvcName, err)
	}
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "configmap", workflowConfigName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete workflow configmap %s: %v", workflowConfigName, err)
	}
}

func waitForNextCronTick(t *testing.T) {
	t.Helper()

	nextTick := time.Now().UTC().Truncate(time.Minute).Add(time.Minute).Add(5 * time.Second)
	time.Sleep(time.Until(nextTick))
}

func waitForCronChildJob(t *testing.T, opts Options, runID string, timeout time.Duration) string {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "jobs", "-l", "fabrik.sh/run-id="+runID, "-o", "jsonpath={.items[0].metadata.name}")
		if err == nil {
			name := strings.TrimSpace(out)
			if name != "" {
				return name
			}
		}
		time.Sleep(2 * time.Second)
	}

	return ""
}

func waitForJobPod(t *testing.T, opts Options, jobName string, timeout time.Duration) string {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "pods", "-l", "job-name="+jobName, "-o", "jsonpath={.items[0].metadata.name}")
		if err == nil {
			name := strings.TrimSpace(out)
			if name != "" {
				return name
			}
		}
		time.Sleep(2 * time.Second)
	}

	return ""
}

func waitForJobPresence(t *testing.T, opts Options, jobName string, timeout time.Duration) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "job", jobName, "-o", "jsonpath={.metadata.name}")
		if err == nil && strings.TrimSpace(out) == jobName {
			return
		}
		time.Sleep(2 * time.Second)
	}

	t.Fatalf("expected job %s to exist within %s", jobName, timeout)
}

func assertEphemeralWorkspacePVC(t *testing.T, opts Options, podName string) {
	t.Helper()

	pvcName := trimK8sName(podName + "-workspace")
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "pvc", pvcName, "-o", "jsonpath={.status.phase}{\"\\n\"}{.metadata.ownerReferences[0].kind}{\"\\n\"}{.metadata.ownerReferences[0].name}")
		if err == nil {
			lines := strings.Split(strings.TrimSpace(out), "\n")
			if len(lines) == 3 && lines[0] == "Bound" && lines[1] == "Pod" && lines[2] == podName {
				return
			}
		}
		time.Sleep(2 * time.Second)
	}

	out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "pvc", pvcName, "-o", "jsonpath={.status.phase}{\"\\n\"}{.metadata.ownerReferences[0].kind}{\"\\n\"}{.metadata.ownerReferences[0].name}")
	if err != nil {
		t.Fatalf("resolve ephemeral pvc %s: %v", pvcName, err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	t.Fatalf("expected pvc %s to become Bound and owned by pod %s, got %q", pvcName, podName, lines)
}

func ensureProjectEnvSecret(t *testing.T, contextName, project, environment string) {
	t.Helper()

	var out bytes.Buffer
	if err := runenv.Set(context.Background(), &out, runenv.SetOptions{
		Options: runenv.Options{
			Project:   project,
			Env:       environment,
			Namespace: envSecretNamespace,
			Context:   contextName,
		},
		Replace: true,
		Pairs: []string{
			"DATABASE_URL=postgres://k3d",
			"API_BASE_URL=https://env.test",
		},
	}); err != nil {
		t.Fatalf("create env secret for integration test: %v", err)
	}
}

func assertProjectEnvInjectionOnJob(t *testing.T, opts Options, jobName, project, environment string) {
	t.Helper()

	secretName := runenv.SecretName(project, environment)
	out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "job", jobName, "-o", "jsonpath={.spec.template.spec.containers[0].envFrom[0].secretRef.name}{\"\\n\"}{.spec.template.spec.containers[0].volumeMounts[1].mountPath}{\"\\n\"}{.spec.template.spec.volumes[1].secret.secretName}")
	if err != nil {
		t.Fatalf("resolve project env injection on job %s: %v", jobName, err)
	}

	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected project env injection output for job %s, got %q", jobName, out)
	}
	if lines[0] != secretName {
		t.Fatalf("expected envFrom secret %s on job %s, got %q", secretName, jobName, lines[0])
	}
	if lines[1] != "/etc/fabrik/env" {
		t.Fatalf("expected project env mount path on job %s, got %q", jobName, lines[1])
	}
	if lines[2] != secretName {
		t.Fatalf("expected mounted secret %s on job %s, got %q", secretName, jobName, lines[2])
	}
}
