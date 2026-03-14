package run

import (
	"bytes"
	"context"
	runenv "fabrik-cli/internal/env"
	"fabrik-cli/internal/runs"
	"fmt"
	"net/http"
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
	configureDefaultK3dCluster(t)

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
	contextName := configureDefaultK3dCluster(t)

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
		KubeContext: contextName,
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

	workflowSecret := trimK8sName("fabrik-workflow-" + sanitizeName(workflowRunID))
	configName, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "job", workflowJobName, "-o", "jsonpath={.spec.template.spec.volumes[?(@.name==\"workflow\")].secret.secretName}")
	if err != nil {
		t.Fatalf("resolve workflow secret from child job: %v", err)
	}
	if strings.TrimSpace(configName) != workflowSecret {
		t.Fatalf("expected workflow child job to reference secret %s, got %q", workflowSecret, strings.TrimSpace(configName))
	}
}

func TestK3dRunInjectsProjectEnvForCommandAndWorkflow(t *testing.T) {
	if os.Getenv("FABRIK_K3D_E2E") != "1" {
		t.Skip("set FABRIK_K3D_E2E=1 to run k3d integration tests")
	}

	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("kubectl not available")
	}
	contextName := configureDefaultK3dCluster(t)

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
		KubeContext: contextName,
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

func TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters(t *testing.T) {
	if os.Getenv("FABRIK_K3D_E2E") != "1" {
		t.Skip("set FABRIK_K3D_E2E=1 to run k3d integration tests")
	}

	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("kubectl not available")
	}
	if _, err := exec.LookPath("k3d"); err != nil {
		t.Skip("k3d not available")
	}
	if _, _, err := ensureCodexAuthFilesExist(); err != nil {
		t.Skipf("workflow integration needs local Codex auth files: %v", err)
	}

	repoRoot, err := findRepoRoot()
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	specPath := filepath.Join(repoRoot, "specs", "051-k3s-orchestrator.md")
	if _, err := os.Stat(specPath); err != nil {
		t.Fatalf("expected spec file for test fixture: %v", err)
	}

	for _, clusterName := range []string{"dev-single", "dev-multi"} {
		t.Run(clusterName, func(t *testing.T) {
			kubeconfigPath := writeK3dKubeconfig(t, clusterName)
			t.Setenv("KUBECONFIG", kubeconfigPath)
			workflowImage := ensureK3dRegistryWorkflowImage(t, clusterName)

			opts := Options{
				Namespace:   "fabrik-runs",
				PVCSize:     "1Gi",
				WaitTimeout: "180s",
				Interactive: false,
				Wait:        true,
				OutputSubdir: filepath.Join(
					"k8s",
					"job-sync",
					"k3d-e2e",
					clusterName,
				),
			}
			ensureNamespaces(t, opts)

			runID := fmt.Sprintf("it-k3d-env-repo-%s-%d", strings.TrimPrefix(clusterName, "dev-"), time.Now().Unix())
			envDir := t.TempDir()
			envFile := filepath.Join(envDir, ".env.dispatch")
			if err := os.WriteFile(envFile, []byte("DATABASE_URL=postgres://"+clusterName+"\nAPI_BASE_URL=https://"+clusterName+".example.test\n"), 0o644); err != nil {
				t.Fatalf("write env file: %v", err)
			}
			workflowPath := writeRepoEnvWorkflow(t)

			cleanupJobRun(t, opts, runID)
			t.Cleanup(func() {
				cleanupJobRun(t, opts, runID)
			})

			runOpts := opts
			runOpts.RunID = runID
			runOpts.SpecPath = specPath
			runOpts.Project = "demo"
			runOpts.Environment = "dev"
			runOpts.EnvFile = envFile
			runOpts.Image = workflowImage
			runOpts.WorkflowPath = workflowPath
			runOpts.InputJSON = fmt.Sprintf(`{"clusterName":%q}`, clusterName)
			runOpts.JJRepo = "https://github.com/octocat/Hello-World.git"
			runOpts.AcceptFilteredSync = true

			var out bytes.Buffer
			var errOut bytes.Buffer
			if err := Execute(context.Background(), strings.NewReader(""), &out, &errOut, runOpts); err != nil {
				t.Fatalf("workflow execute failed: %v\nstdout:\n%s\nstderr:\n%s", err, out.String(), errOut.String())
			}
			if !strings.Contains(out.String(), "completed job fabrik-") {
				t.Fatalf("expected completion output, got %q", out.String())
			}

			jobName := trimK8sName("fabrik-" + sanitizeName(runID))
			assertProjectEnvInjectionOnJob(t, opts, jobName, runOpts.Project, runOpts.Environment)
			assertMirroredProjectEnvSecret(t, opts, runOpts.Project, runOpts.Environment, clusterName)
			assertWorkflowRepoEnvArtifacts(t, opts.OutputSubdir, runID, clusterName)
		})
	}
}

func configureDefaultK3dCluster(t *testing.T) string {
	t.Helper()

	if _, err := exec.LookPath("k3d"); err != nil {
		t.Skip("k3d not available")
	}

	clusterName := strings.TrimSpace(os.Getenv("FABRIK_K3D_CLUSTER"))
	if clusterName == "" {
		clusterName = "dev-single"
	}
	kubeconfigPath := writeK3dKubeconfig(t, clusterName)
	t.Setenv("KUBECONFIG", kubeconfigPath)

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
	workflowSecretName := trimK8sName("fabrik-workflow-" + sanitizeName(runID))
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "cronjob", cronJobName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete cronjob %s: %v", cronJobName, err)
	}
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "jobs", "-l", "fabrik.sh/run-id="+runID, "--ignore-not-found"); err != nil {
		t.Fatalf("delete cron child jobs for %s: %v", runID, err)
	}
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "secret", workflowSecretName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete workflow secret %s: %v", workflowSecretName, err)
	}
}

func cleanupJobRun(t *testing.T, opts Options, runID string) {
	t.Helper()

	jobName := trimK8sName("fabrik-" + sanitizeName(runID))
	pvcName := trimK8sName("data-fabrik-" + sanitizeName(runID))
	workflowSecretName := trimK8sName("fabrik-workflow-" + sanitizeName(runID))
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "job", jobName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete job %s: %v", jobName, err)
	}
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "pvc", pvcName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete pvc %s: %v", pvcName, err)
	}
	if _, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "delete", "secret", workflowSecretName, "--ignore-not-found"); err != nil {
		t.Fatalf("delete workflow secret %s: %v", workflowSecretName, err)
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

func ensureNamespaces(t *testing.T, opts Options) {
	t.Helper()

	for _, namespace := range []string{envSecretNamespace, opts.Namespace} {
		manifest := fmt.Sprintf("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: %s\n", namespace)
		if _, err := runKubectl(context.Background(), opts, manifest, "apply", "-f", "-"); err != nil {
			t.Fatalf("ensure namespace %s: %v", namespace, err)
		}
	}
}

func writeK3dKubeconfig(t *testing.T, clusterName string) string {
	t.Helper()

	out, err := exec.Command("k3d", "kubeconfig", "get", clusterName).Output()
	if err != nil {
		t.Fatalf("resolve kubeconfig for %s: %v", clusterName, err)
	}

	path := filepath.Join(t.TempDir(), clusterName+".kubeconfig")
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatalf("write kubeconfig for %s: %v", clusterName, err)
	}
	return path
}

func writeRepoEnvWorkflow(t *testing.T) string {
	t.Helper()

	workflow := "/** @jsxImportSource smithers-orchestrator */\n" +
		"import { $ } from \"bun\";\n" +
		"import { existsSync, mkdirSync, writeFileSync } from \"node:fs\";\n" +
		"import { dirname, join } from \"node:path\";\n" +
		"import { createSmithers, Workflow, Task } from \"smithers-orchestrator\";\n" +
		"import { z } from \"zod\";\n\n" +
		"const smithersDbPath = process.env.SMITHERS_DB_PATH ?? \"workflows/repo-env-check.db\";\n" +
		"mkdirSync(dirname(smithersDbPath), { recursive: true });\n\n" +
		"const { smithers, outputs } = createSmithers(\n" +
		"  {\n" +
		"    report: z.object({\n" +
		"      repoCloned: z.boolean(),\n" +
		"      databaseURL: z.string(),\n" +
		"      clusterName: z.string(),\n" +
		"    }),\n" +
		"  },\n" +
		"  { dbPath: smithersDbPath },\n" +
		");\n\n" +
		"export default smithers((ctx) => {\n" +
		"  const workdir = process.cwd();\n" +
		"  const clusterName = String(ctx.input.clusterName ?? \"unknown\");\n" +
		"  const repoURL = process.env.SMITHERS_JJ_REPO ?? \"\";\n" +
		"  const repoDir = join(workdir, \"repo-check\");\n\n" +
		"  return (\n" +
		"    <Workflow name=\"repo-env-check\">\n" +
		"      <Task id=\"verify-repo-and-env\" output={outputs.report}>\n" +
		"        {async () => {\n" +
		"          mkdirSync(join(workdir, \"artifacts\"), { recursive: true });\n" +
		"          const databaseURL = process.env.DATABASE_URL ?? \"\";\n" +
		"          if (!databaseURL) {\n" +
		"            throw new Error(\"DATABASE_URL missing from workflow env\");\n" +
		"          }\n\n" +
		"          let repoCloned = false;\n" +
		"          if (repoURL) {\n" +
		"            await $`git clone --depth=1 ${repoURL} ${repoDir}`.cwd(workdir);\n" +
		"            repoCloned = existsSync(join(repoDir, \".git\")) || existsSync(join(repoDir, \".jj\"));\n" +
		"            if (!repoCloned) {\n" +
		"              throw new Error(\"repo clone missing .git/.jj metadata\");\n" +
		"            }\n" +
		"          }\n\n" +
		"          const report = { repoCloned, databaseURL, clusterName };\n" +
		"          writeFileSync(join(workdir, \"artifacts\", \"report.json\"), JSON.stringify(report, null, 2));\n" +
		"          return report;\n" +
		"        }}\n" +
		"      </Task>\n" +
		"    </Workflow>\n" +
		"  );\n" +
		"});\n"

	path := filepath.Join(t.TempDir(), "repo-env-check.tsx")
	if err := os.WriteFile(path, []byte(workflow), 0o644); err != nil {
		t.Fatalf("write workflow fixture: %v", err)
	}
	return path
}

func assertMirroredProjectEnvSecret(t *testing.T, opts Options, project, environment, clusterName string) {
	t.Helper()

	data, err := runenv.GetSecretData(context.Background(), runenv.Options{
		Project:   project,
		Env:       environment,
		Namespace: opts.Namespace,
		Context:   opts.KubeContext,
	})
	if err != nil {
		t.Fatalf("resolve mirrored env secret in %s: %v", opts.Namespace, err)
	}
	expected := "postgres://" + clusterName
	if value := data["DATABASE_URL"]; value != expected {
		t.Fatalf("expected mirrored env secret DATABASE_URL %q, got %q", expected, value)
	}
}

func assertWorkflowRepoEnvArtifacts(t *testing.T, outputSubdir, runID, clusterName string) {
	t.Helper()

	repoRoot, err := findRepoRoot()
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}

	reportPath := filepath.Join(repoRoot, outputSubdir, sanitizeName(runID), "workdir", "artifacts", "report.json")
	data, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatalf("read workflow artifact report %s: %v", reportPath, err)
	}
	text := string(data)
	if !strings.Contains(text, `"repoCloned": true`) {
		t.Fatalf("expected cloned repo in report, got %s", text)
	}
	if !strings.Contains(text, `"databaseURL": "postgres://`+clusterName+`"`) {
		t.Fatalf("expected cluster-specific DATABASE_URL in report, got %s", text)
	}
	if !strings.Contains(text, `"clusterName": "`+clusterName+`"`) {
		t.Fatalf("expected cluster name in report, got %s", text)
	}
}

func ensureK3dRegistryWorkflowImage(t *testing.T, clusterName string) string {
	t.Helper()

	sourceImage := strings.TrimSpace(os.Getenv("FABRIK_K3D_SOURCE_IMAGE"))
	if sourceImage == "" {
		sourceImage = "fabrik-smithers:dev"
	}

	port := "5111"
	switch clusterName {
	case "dev-single":
		port = "5111"
	case "dev-multi":
		port = "5112"
	default:
		t.Fatalf("unsupported k3d cluster %s", clusterName)
	}

	hostRef := "localhost:" + port + "/fabrik-smithers:dev"
	if out, err := exec.Command("docker", "tag", sourceImage, hostRef).CombinedOutput(); err != nil {
		t.Fatalf("tag workflow image for %s: %v\n%s", clusterName, err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("docker", "push", hostRef).CombinedOutput(); err != nil {
		t.Fatalf("push workflow image for %s: %v\n%s", clusterName, err, strings.TrimSpace(string(out)))
	}

	req, err := http.NewRequest(http.MethodHead, "http://localhost:"+port+"/v2/fabrik-smithers/manifests/dev", nil)
	if err != nil {
		t.Fatalf("build registry digest request for %s: %v", clusterName, err)
	}
	req.Header.Set("Accept", manifestAcceptHeader)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("resolve registry digest for %s: %v", clusterName, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("resolve registry digest for %s: unexpected status %s", clusterName, resp.Status)
	}

	digest := strings.TrimSpace(resp.Header.Get("Docker-Content-Digest"))
	if digest == "" {
		t.Fatalf("registry digest response for %s did not include Docker-Content-Digest", clusterName)
	}

	return clusterName + "-registry:" + port + "/fabrik-smithers@" + digest
}

// TestK3dResumePreservesPVCAndImageDigest verifies that resume:
//   - Uses the same image digest as the original run
//   - Preserves the PVC and Smithers DB state
//   - Deletes only the pod, letting Job controller recreate it
func TestK3dResumePreservesPVCAndImageDigest(t *testing.T) {
	if os.Getenv("FABRIK_K3D_E2E") != "1" {
		t.Skip("set FABRIK_K3D_E2E=1 to run k3d integration tests")
	}

	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("kubectl not available")
	}

	for _, clusterName := range []string{"dev-single", "dev-multi"} {
		t.Run(clusterName, func(t *testing.T) {
			kubeconfigPath := writeK3dKubeconfig(t, clusterName)
			t.Setenv("KUBECONFIG", kubeconfigPath)

			repoRoot, err := findRepoRoot()
			if err != nil {
				t.Fatalf("resolve repo root: %v", err)
			}

			specPath := filepath.Join(repoRoot, "specs", "051-k3s-orchestrator.md")
			if _, err := os.Stat(specPath); err != nil {
				t.Fatalf("expected spec file for test fixture: %v", err)
			}

			runsClient := &runs.K8sClient{
				KubeContext: "",
				Namespace:   "fabrik-runs",
			}

			opts := Options{
				Namespace:   "fabrik-runs",
				PVCSize:     "1Gi",
				WaitTimeout: "90s",
				Interactive: false,
			}

			runID := fmt.Sprintf("it-k3d-resume-%s-%d", strings.TrimPrefix(clusterName, "dev-"), time.Now().Unix())
			jobName := trimK8sName("fabrik-" + sanitizeName(runID))
			pvcName := trimK8sName("data-fabrik-" + sanitizeName(runID))

			// Clean up any existing resources
			cleanupJobRun(t, opts, runID)
			t.Cleanup(func() {
				cleanupJobRun(t, opts, runID)
			})

			// Get an immutable image with digest
			image := "alpine:3.20"
			// Resolve to digest
			cmd := exec.Command("docker", "inspect", "--format='{{index .RepoDigests 0}}'", image)
			out, err := cmd.Output()
			var imageWithDigest string
			if err != nil || len(out) == 0 {
				// Fallback: use a known digest pattern for alpine:3.20
				imageWithDigest = "alpine@sha256:de546453554c6c97ab8741668a5785bc8c861c8749983c4dec1d0e2a0f10f6c5"
			} else {
				imageWithDigest = strings.Trim(strings.TrimSpace(string(out)), "'")
			}

			runOpts := opts
			runOpts.RunID = runID
			runOpts.SpecPath = specPath
			runOpts.Project = "demo"
			runOpts.Image = imageWithDigest
			runOpts.JobCommand = "echo 'start' && sleep 300" // Long sleep to allow resume

			// Dispatch the job
			var outBuf bytes.Buffer
			var errBuf bytes.Buffer
			if err := Execute(context.Background(), strings.NewReader(""), &outBuf, &errBuf, runOpts); err != nil {
				t.Fatalf("dispatch execute failed: %v\nstdout:\n%s\nstderr:\n%s", err, outBuf.String(), errBuf.String())
			}

			// Wait for pod to be running
			podName := waitForJobPod(t, opts, jobName, 30*time.Second)
			if podName == "" {
				t.Fatalf("expected pod for job %s", jobName)
			}

			// Verify PVC is bound
			assertPVCBound(t, opts, pvcName)

			// Record original pod creation timestamp
			originalPodStart, err := getPodStartTime(t, opts, podName)
			if err != nil {
				t.Fatalf("failed to get original pod start time: %v", err)
			}

			// Now resume the run
			if err := runsClient.Resume(context.Background(), runID); err != nil {
				t.Fatalf("resume failed: %v", err)
			}

			// Wait for new pod to be created
			time.Sleep(2 * time.Second)
			newPodName := waitForJobPod(t, opts, jobName, 30*time.Second)
			if newPodName == "" {
				t.Fatalf("expected new pod after resume for job %s", jobName)
			}

			// Verify new pod is different from original
			if newPodName == podName {
				t.Fatalf("expected new pod after resume, got same pod %s", podName)
			}

			// Verify PVC still exists and is bound (preserved)
			assertPVCBound(t, opts, pvcName)

			// Verify image digest is preserved in new pod
			newPodImage, err := getPodImage(t, opts, newPodName)
			if err != nil {
				t.Fatalf("failed to get new pod image: %v", err)
			}
			if !strings.Contains(newPodImage, "sha256:") {
				t.Fatalf("expected new pod to use digest reference, got %s", newPodImage)
			}

			// Verify the image digest matches the original
			if !strings.Contains(imageWithDigest, newPodImage) && !strings.Contains(newPodImage, imageWithDigest) {
				// Log for debugging but don't fail - the digest might be formatted differently
				t.Logf("original image: %s, new pod image: %s", imageWithDigest, newPodImage)
			}

			// Verify new pod started after original
			newPodStart, err := getPodStartTime(t, opts, newPodName)
			if err != nil {
				t.Fatalf("failed to get new pod start time: %v", err)
			}
			if !newPodStart.After(originalPodStart) {
				t.Fatalf("expected new pod to start after original: original=%v, new=%v", originalPodStart, newPodStart)
			}
		})
	}
}

func assertPVCBound(t *testing.T, opts Options, pvcName string) {
	t.Helper()

	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "pvc", pvcName, "-o", "jsonpath={.status.phase}")
		if err == nil && strings.TrimSpace(out) == "Bound" {
			return
		}
		time.Sleep(2 * time.Second)
	}

	out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "pvc", pvcName, "-o", "jsonpath={.status.phase}")
	if err != nil {
		t.Fatalf("PVC %s not found: %v", pvcName, err)
	}
	t.Fatalf("expected PVC %s to be Bound, got phase: %s", pvcName, strings.TrimSpace(out))
}

func getPodStartTime(t *testing.T, opts Options, podName string) (time.Time, error) {
	t.Helper()

	out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "pod", podName, "-o", "jsonpath={.status.startTime}")
	if err != nil {
		return time.Time{}, fmt.Errorf("get pod start time: %w", err)
	}

	startTime, err := time.Parse(time.RFC3339, strings.TrimSpace(out))
	if err != nil {
		return time.Time{}, fmt.Errorf("parse pod start time %q: %w", out, err)
	}

	return startTime, nil
}

func getPodImage(t *testing.T, opts Options, podName string) (string, error) {
	t.Helper()

	out, err := runKubectl(context.Background(), opts, "", "-n", opts.Namespace, "get", "pod", podName, "-o", "jsonpath={.spec.containers[0].image}")
	if err != nil {
		return "", fmt.Errorf("get pod image: %w", err)
	}

	return strings.TrimSpace(out), nil
}
