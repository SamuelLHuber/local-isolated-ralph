package run

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type Manifests struct {
	Kind            string
	JobName         string
	CronJobName     string
	PVCName         string
	ServiceAccount  string
	RoleYAML        string
	RoleBindingYAML string
	WorkflowSecret  string
	SyncSecret      string
	PVCYAML         string
	JobYAML         string
	CronJobYAML     string
}

func (m Manifests) AllYAML() string {
	parts := []string{}
	if m.WorkflowSecret != "" {
		parts = append(parts, m.WorkflowSecret)
	}
	if m.SyncSecret != "" {
		parts = append(parts, m.SyncSecret)
	}
	if m.ServiceAccount != "" {
		parts = append(parts, m.ServiceAccount)
	}
	if m.RoleYAML != "" {
		parts = append(parts, m.RoleYAML)
	}
	if m.RoleBindingYAML != "" {
		parts = append(parts, m.RoleBindingYAML)
	}
	if m.PVCYAML != "" {
		parts = append(parts, m.PVCYAML)
	}
	if m.JobYAML != "" {
		parts = append(parts, m.JobYAML)
	}
	if m.CronJobYAML != "" {
		parts = append(parts, m.CronJobYAML)
	}
	return strings.Join(parts, "---\n")
}

func (m Manifests) Summary() string {
	if m.Kind == "CronJob" {
		return fmt.Sprintf("scheduling\n  cronjob: %s\n  schedule: %s\n", m.CronJobName, m.PVCName)
	}
	return fmt.Sprintf("dispatching\n  job: %s\n  pvc: %s\n", m.JobName, m.PVCName)
}

func BuildManifests(opts Options) (Manifests, error) {
	sharedBundle, err := resolveSharedCredentialBundle(opts)
	if err != nil {
		return Manifests{}, err
	}

	safeRunID := sanitizeName(opts.RunID)
	specID := sanitizeName(strings.TrimSuffix(filepath.Base(opts.SpecPath), filepath.Ext(opts.SpecPath)))
	jobName := trimK8sName("fabrik-" + safeRunID)
	cronJobName := trimK8sName("fabrik-cron-" + safeRunID)
	pvcName := trimK8sName("data-fabrik-" + safeRunID)

	statusJSON, err := json.Marshal(map[string]any{
		"phase":        "run",
		"current_task": "dispatch",
		"attempt":      1,
		"progress": map[string]int{
			"finished": 0,
			"total":    1,
		},
	})
	if err != nil {
		return Manifests{}, err
	}

	startedAt := buildStartedAt()
	progressJSON := `{"finished":0,"total":1}`
	labels := map[string]string{
		"fabrik.sh/run-id":     opts.RunID,
		"fabrik.sh/spec":       specID,
		"fabrik.sh/project":    opts.Project,
		"fabrik.sh/phase":      "run",
		"fabrik.sh/status":     "running",
		"fabrik.sh/task":       "dispatch",
		"fabrik.sh/managed-by": "fabrik",
	}
	annotations := map[string]string{
		"fabrik.sh/status":      string(statusJSON),
		"fabrik.sh/started-at":  startedAt,
		"fabrik.sh/finished-at": "",
		"fabrik.sh/outcome":     "",
		"fabrik.sh/progress":    progressJSON,
		"fabrik.sh/spec-path":   opts.SpecPath,
	}
	if opts.IsCron() {
		annotations["fabrik.sh/cron-schedule"] = opts.CronSchedule
	}

	workflowSecretName := ""
	workflowSecret := ""
	syncSecretName := ""
	syncSecret := ""
	serviceAccountName := ""
	serviceAccountYAML := ""
	roleName := ""
	roleYAML := ""
	roleBindingName := ""
	roleBindingYAML := ""
	needsSharedCredentialSync := requiresSharedCredentialSync(opts, sharedBundle)
	needsServiceAccount := strings.TrimSpace(opts.WorkflowPath) != "" || needsSharedCredentialSync
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		workflowSecretName = trimK8sName("fabrik-workflow-" + safeRunID)
		workflowSecret = buildWorkflowSecret(opts.Namespace, workflowSecretName, opts.WorkflowBundle)
		annotations["fabrik.sh/workflow-path"] = opts.WorkflowPath
		if opts.SyncBundle != nil {
			syncSecretName = trimK8sName("fabrik-sync-" + safeRunID)
			syncSecret = buildSyncSecret(opts.Namespace, syncSecretName, opts.SyncBundle)
			annotations["fabrik.sh/fabrik-sync-path"] = opts.SyncBundle.ManifestPath
		}
	}
	if needsServiceAccount {
		serviceAccountName = trimK8sName("fabrik-runner-" + safeRunID)
		roleName = trimK8sName("fabrik-runner-" + safeRunID)
		roleBindingName = trimK8sName("fabrik-runner-" + safeRunID)
		serviceAccountYAML = buildServiceAccountYAML(opts.Namespace, serviceAccountName)
		roleYAML = buildRunnerRoleYAML(opts.Namespace, roleName, strings.TrimSpace(opts.WorkflowPath) != "", needsSharedCredentialSync, sharedBundle.SecretName)
		roleBindingYAML = buildWorkflowRunnerRoleBindingYAML(opts.Namespace, roleBindingName, roleName, serviceAccountName)
		if needsSharedCredentialSync {
			sourceRoleName := trimK8sName("fabrik-credential-source-" + safeRunID)
			sourceRoleBindingName := trimK8sName("fabrik-credential-source-" + safeRunID)
			if roleYAML != "" {
				roleYAML += "---\n"
			}
			roleYAML += buildSharedCredentialSourceRoleYAML(envSecretNamespace, sourceRoleName, sharedBundle.SecretName)
			if roleBindingYAML != "" {
				roleBindingYAML += "---\n"
			}
			roleBindingYAML += buildSharedCredentialSourceRoleBindingYAML(
				envSecretNamespace,
				sourceRoleBindingName,
				sourceRoleName,
				serviceAccountName,
				opts.Namespace,
			)
		}
	}

	if opts.IsCron() {
		cronJobYAML := buildCronJobYAML(opts, sharedBundle, cronJobName, workflowSecretName, syncSecretName, labels, annotations)
		return Manifests{
			Kind:            "CronJob",
			CronJobName:     cronJobName,
			PVCName:         opts.CronSchedule,
			ServiceAccount:  serviceAccountYAML,
			RoleYAML:        roleYAML,
			RoleBindingYAML: roleBindingYAML,
			WorkflowSecret:  workflowSecret,
			SyncSecret:      syncSecret,
			CronJobYAML:     cronJobYAML,
		}, nil
	}

	pvcYAML := buildPVCYAML(opts, pvcName, labels)
	jobYAML := buildJobYAML(opts, sharedBundle, jobName, pvcName, workflowSecretName, syncSecretName, labels, annotations)

	return Manifests{
		Kind:            "Job",
		JobName:         jobName,
		PVCName:         pvcName,
		ServiceAccount:  serviceAccountYAML,
		RoleYAML:        roleYAML,
		RoleBindingYAML: roleBindingYAML,
		WorkflowSecret:  workflowSecret,
		SyncSecret:      syncSecret,
		PVCYAML:         pvcYAML,
		JobYAML:         jobYAML,
	}, nil
}

func buildPVCYAML(opts Options, pvcName string, labels map[string]string) string {
	var b strings.Builder
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: PersistentVolumeClaim\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + pvcName + "\n")
	b.WriteString("  namespace: " + opts.Namespace + "\n")
	writeMap(&b, "  ", "labels", labels)
	b.WriteString("spec:\n")
	b.WriteString("  accessModes:\n")
	b.WriteString("    - ReadWriteOnce\n")
	if strings.TrimSpace(opts.StorageClass) != "" {
		b.WriteString("  storageClassName: " + opts.StorageClass + "\n")
	}
	b.WriteString("  resources:\n")
	b.WriteString("    requests:\n")
	b.WriteString("      storage: " + opts.PVCSize + "\n")
	return b.String()
}

func buildJobYAML(opts Options, sharedBundle sharedCredentialBundle, jobName, pvcName, workflowSecretName, syncSecretName string, labels, annotations map[string]string) string {
	var b strings.Builder
	b.WriteString("apiVersion: batch/v1\n")
	b.WriteString("kind: Job\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + jobName + "\n")
	b.WriteString("  namespace: " + opts.Namespace + "\n")
	writeMap(&b, "  ", "labels", labels)
	writeMap(&b, "  ", "annotations", annotations)
	b.WriteString("spec:\n")
	b.WriteString("  ttlSecondsAfterFinished: 604800\n")
	b.WriteString("  backoffLimit: 1\n")
	writePodTemplate(&b, "  ", opts, sharedBundle, labels, annotations, workflowSecretName, syncSecretName, pvcName)
	return b.String()
}

func buildCronJobYAML(opts Options, sharedBundle sharedCredentialBundle, cronJobName, workflowSecretName, syncSecretName string, labels, annotations map[string]string) string {
	var b strings.Builder
	b.WriteString("apiVersion: batch/v1\n")
	b.WriteString("kind: CronJob\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + cronJobName + "\n")
	b.WriteString("  namespace: " + opts.Namespace + "\n")
	writeMap(&b, "  ", "labels", labels)
	writeMap(&b, "  ", "annotations", annotations)
	b.WriteString("spec:\n")
	b.WriteString("  schedule: " + yamlQuote(opts.CronSchedule) + "\n")
	b.WriteString("  concurrencyPolicy: Forbid\n")
	b.WriteString("  successfulJobsHistoryLimit: 3\n")
	b.WriteString("  failedJobsHistoryLimit: 1\n")
	b.WriteString("  jobTemplate:\n")
	b.WriteString("    spec:\n")
	b.WriteString("      backoffLimit: 1\n")
	writePodTemplate(&b, "      ", opts, sharedBundle, labels, annotations, workflowSecretName, syncSecretName, "")
	return b.String()
}

func writePodTemplate(b *strings.Builder, indent string, opts Options, sharedBundle sharedCredentialBundle, labels, annotations map[string]string, workflowSecretName, syncSecretName, pvcName string) {
	envSecretName := opts.EnvSecretName()
	b.WriteString(indent + "template:\n")
	b.WriteString(indent + "  metadata:\n")
	writeMap(b, indent+"    ", "labels", labels)
	writeMap(b, indent+"    ", "annotations", annotations)
	b.WriteString(indent + "  spec:\n")
	b.WriteString(indent + "    securityContext:\n")
	b.WriteString(indent + "      runAsNonRoot: true\n")
	b.WriteString(indent + "      runAsUser: 1000\n")
	b.WriteString(indent + "      runAsGroup: 1000\n")
	b.WriteString(indent + "      fsGroup: 1000\n")
	b.WriteString(indent + "      seccompProfile:\n")
	b.WriteString(indent + "        type: RuntimeDefault\n")
	b.WriteString(indent + "    nodeSelector:\n")
	b.WriteString(indent + "      node-role.kubernetes.io/control-plane: \"true\"\n")
	if strings.TrimSpace(opts.WorkflowPath) != "" || requiresSharedCredentialSync(opts, sharedBundle) {
		b.WriteString(indent + "    serviceAccountName: " + trimK8sName("fabrik-runner-"+sanitizeName(opts.RunID)) + "\n")
	}
	b.WriteString(indent + "    restartPolicy: Never\n")
	b.WriteString(indent + "    containers:\n")
	b.WriteString(indent + "      - name: fabrik\n")
	b.WriteString(indent + "        image: " + opts.Image + "\n")
	b.WriteString(indent + "        imagePullPolicy: IfNotPresent\n")
	b.WriteString(indent + "        securityContext:\n")
	b.WriteString(indent + "          allowPrivilegeEscalation: false\n")
	b.WriteString(indent + "          readOnlyRootFilesystem: true\n")
	b.WriteString(indent + "          capabilities:\n")
	b.WriteString(indent + "            drop:\n")
	b.WriteString(indent + "              - ALL\n")
	if strings.TrimSpace(opts.WorkflowPath) == "" {
		command := buildSharedCredentialBootstrap(sharedBundle) + " && " + opts.JobCommand
		b.WriteString(indent + "        command: [\"sh\", \"-lc\", " + yamlQuote(command) + "]\n")
	} else {
		bootstrap := "smithers_exit=0"
		bootstrap += " && runtime_outcome=succeeded"
		bootstrap += " && runtime_status=finished"
		bootstrap += " && fabrik_status='{\"phase\":\"complete\",\"current_task\":\"done\",\"attempt\":1,\"progress\":{\"finished\":1,\"total\":1}}'"
		bootstrap += " && fabrik_progress='{\"finished\":1,\"total\":1}'"
		bootstrap += " && if ( WORKDIR=${SMITHERS_WORKDIR:-/workspace/workdir}"
		bootstrap += " && DB_PATH=${SMITHERS_DB_PATH:-/workspace/.smithers/state.db}"
		bootstrap += " && LOG_DIR=${SMITHERS_LOG_DIR:-/workspace/.smithers/executions/$SMITHERS_RUN_ID/logs}"
		bootstrap += " && mkdir -p \"$WORKDIR\" /workspace/.fabrik \"$(dirname \"$DB_PATH\")\" \"$LOG_DIR\""
		if workflowSecretName != "" {
			bootstrap += " && if [ -f /opt/fabrik-workflow/bundle.tgz ]; then tar -xzf /opt/fabrik-workflow/bundle.tgz -C /workspace/.fabrik; fi"
		}
		if syncSecretName != "" {
			bootstrap += " && if [ -f /opt/fabrik-sync/bundle.tgz ]; then tar -xzf /opt/fabrik-sync/bundle.tgz -C \"$WORKDIR\"; fi"
		}
		bootstrap += " && RUNTIME_DIR=${SMITHERS_RUNTIME_DIR:-/opt/smithers-runtime}"
		bootstrap += " && WORKFLOW_PATH=${SMITHERS_WORKFLOW_PATH:-/workspace/.fabrik/" + opts.WorkflowBundle.WorkdirPath + "}"
		bootstrap += " && WORKFLOW_DIR=$(dirname \"$WORKFLOW_PATH\")"
		bootstrap += " && WORKFLOW_RUNTIME_DIR=$(dirname \"$WORKFLOW_DIR\")"
		bootstrap += " && RUNTIME_HOME=${SMITHERS_HOME:-/workspace}"
		bootstrap += " && export HOME=\"$RUNTIME_HOME\" XDG_CONFIG_HOME=\"$RUNTIME_HOME/.config\" XDG_CACHE_HOME=\"$RUNTIME_HOME/.cache\" GIT_CONFIG_GLOBAL=\"$RUNTIME_HOME/.gitconfig\""
		bootstrap += " && " + buildSharedCredentialBootstrap(sharedBundle)
		bootstrap += " && mkdir -p \"$WORKFLOW_RUNTIME_DIR\" /tmp/pi-agent \"$HOME\" \"$XDG_CONFIG_HOME\" \"$XDG_CACHE_HOME\""
		bootstrap += " && if [ ! -e \"$WORKFLOW_RUNTIME_DIR/node_modules\" ]; then ln -s \"$RUNTIME_DIR/node_modules\" \"$WORKFLOW_RUNTIME_DIR/node_modules\"; fi"
		bootstrap += " && if [ ! -e \"$WORKFLOW_RUNTIME_DIR/package.json\" ]; then cp \"$RUNTIME_DIR/package.json\" \"$WORKFLOW_RUNTIME_DIR/package.json\"; fi"
		bootstrap += " && if [ -n \"${FIREWORKS_API_KEY:-}\" ]; then cat > /tmp/pi-agent/models.json <<'EOF'\n{\n  \"providers\": {\n    \"fireworks\": {\n      \"baseUrl\": \"https://api.fireworks.ai/inference/v1\",\n      \"api\": \"openai-completions\",\n      \"apiKey\": \"FIREWORKS_API_KEY\",\n      \"authHeader\": true,\n      \"models\": [\n        {\n          \"id\": \"accounts/fireworks/models/kimi-k2p5\",\n          \"name\": \"Fireworks Kimi K2.5\",\n          \"reasoning\": true,\n          \"input\": [\"text\"],\n          \"contextWindow\": 262144,\n          \"maxTokens\": 32768,\n          \"cost\": {\n            \"input\": 0,\n            \"output\": 0,\n            \"cacheRead\": 0,\n            \"cacheWrite\": 0\n          }\n        }\n      ]\n    }\n  }\n}\nEOF\nfi"
		bootstrap += " && VCS_USER_NAME=${JJ_USER_NAME:-${GIT_AUTHOR_NAME:-${GIT_COMMITTER_NAME:-}}}"
		bootstrap += " && VCS_USER_EMAIL=${JJ_USER_EMAIL:-${GIT_AUTHOR_EMAIL:-${GIT_COMMITTER_EMAIL:-}}}"
		bootstrap += " && if [ -n \"$VCS_USER_NAME\" ] && [ -n \"$VCS_USER_EMAIL\" ]; then export GIT_AUTHOR_NAME=\"$VCS_USER_NAME\" GIT_COMMITTER_NAME=\"${GIT_COMMITTER_NAME:-$VCS_USER_NAME}\" GIT_AUTHOR_EMAIL=\"$VCS_USER_EMAIL\" GIT_COMMITTER_EMAIL=\"${GIT_COMMITTER_EMAIL:-$VCS_USER_EMAIL}\" && git config --global user.name \"$VCS_USER_NAME\" && git config --global user.email \"$VCS_USER_EMAIL\" && jj config set --user user.name \"$VCS_USER_NAME\" >/dev/null && jj config set --user user.email \"$VCS_USER_EMAIL\" >/dev/null; fi"
		bootstrap += " && GITHUB_AUTH_TOKEN=${GITHUB_TOKEN:-${GH_TOKEN:-}}"
		bootstrap += " && if [ -n \"$GITHUB_AUTH_TOKEN\" ]; then cat > /tmp/fabrik-git-askpass.sh <<'EOF'\n#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"x-access-token\" ;;\n  *Password*) printf '%s\\n' \"${GITHUB_AUTH_TOKEN:?}\" ;;\n  *) printf '\\n' ;;\nesac\nEOF\nchmod 700 /tmp/fabrik-git-askpass.sh && export GITHUB_AUTH_TOKEN GIT_ASKPASS=/tmp/fabrik-git-askpass.sh GIT_TERMINAL_PROMPT=0; fi"
		bootstrap += " && /opt/smithers-runtime/node_modules/.bin/smithers run \"$WORKFLOW_PATH\" --run-id \"$SMITHERS_RUN_ID\" --input \"$SMITHERS_INPUT_JSON\" --root \"$WORKDIR\" --log-dir \"$LOG_DIR\" ); then :; else smithers_exit=$?; fi"
		bootstrap += " && if [ \"$smithers_exit\" -ne 0 ]; then runtime_outcome=failed; fi"
		bootstrap += " && finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		bootstrap += " && if [ -n \"${KUBERNETES_NAMESPACE:-}\" ] && [ -n \"${KUBERNETES_POD_NAME:-}\" ]; then job_name=$(kubectl -n \"$KUBERNETES_NAMESPACE\" get pod \"$KUBERNETES_POD_NAME\" -o jsonpath='{.metadata.labels.job-name}' 2>/dev/null || true); if [ -n \"$job_name\" ]; then kubectl -n \"$KUBERNETES_NAMESPACE\" label job \"$job_name\" fabrik.sh/phase=complete fabrik.sh/status=\"$runtime_status\" fabrik.sh/task=done --overwrite >/dev/null 2>&1 || true; kubectl -n \"$KUBERNETES_NAMESPACE\" annotate job \"$job_name\" fabrik.sh/status=\"$fabrik_status\" fabrik.sh/finished-at=\"$finished_at\" fabrik.sh/outcome=\"$runtime_outcome\" fabrik.sh/progress=\"$fabrik_progress\" --overwrite >/dev/null 2>&1 || true; fi; kubectl -n \"$KUBERNETES_NAMESPACE\" label pod \"$KUBERNETES_POD_NAME\" fabrik.sh/phase=complete fabrik.sh/status=\"$runtime_status\" fabrik.sh/task=done --overwrite >/dev/null 2>&1 || true; kubectl -n \"$KUBERNETES_NAMESPACE\" annotate pod \"$KUBERNETES_POD_NAME\" fabrik.sh/status=\"$fabrik_status\" fabrik.sh/finished-at=\"$finished_at\" fabrik.sh/outcome=\"$runtime_outcome\" fabrik.sh/progress=\"$fabrik_progress\" --overwrite >/dev/null 2>&1 || true; fi"
		bootstrap += " && exit \"$smithers_exit\""
		b.WriteString(indent + "        command: [\"sh\", \"-lc\", " + yamlQuote(bootstrap) + "]\n")
	}
	b.WriteString(indent + "        env:\n")
	b.WriteString(indent + "          - name: SMITHERS_RUN_ID\n")
	b.WriteString(indent + "            value: " + yamlQuote(opts.RunID) + "\n")
	b.WriteString(indent + "          - name: SMITHERS_SPEC_PATH\n")
	b.WriteString(indent + "            value: " + yamlQuote(opts.SpecPath) + "\n")
	b.WriteString(indent + "          - name: SMITHERS_PROJECT\n")
	b.WriteString(indent + "            value: " + yamlQuote(opts.Project) + "\n")
	if sharedBundle.SecretName != "" {
		b.WriteString(indent + "          - name: FABRIK_SHARED_CREDENTIALS_DIR\n")
		b.WriteString(indent + "            value: " + yamlQuote(sharedBundle.MountPath) + "\n")
	}
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		b.WriteString(indent + "          - name: FABRIK_RUN_IMAGE\n")
		b.WriteString(indent + "            value: " + yamlQuote(opts.Image) + "\n")
		if pvcName != "" {
			b.WriteString(indent + "          - name: FABRIK_WORKSPACE_PVC\n")
			b.WriteString(indent + "            value: " + yamlQuote(pvcName) + "\n")
		}
		b.WriteString(indent + "          - name: KUBERNETES_NAMESPACE\n")
		b.WriteString(indent + "            valueFrom:\n")
		b.WriteString(indent + "              fieldRef:\n")
		b.WriteString(indent + "                fieldPath: metadata.namespace\n")
		b.WriteString(indent + "          - name: KUBERNETES_POD_NAME\n")
		b.WriteString(indent + "            valueFrom:\n")
		b.WriteString(indent + "              fieldRef:\n")
		b.WriteString(indent + "                fieldPath: metadata.name\n")
		b.WriteString(indent + "          - name: KUBERNETES_NODE_NAME\n")
		b.WriteString(indent + "            valueFrom:\n")
		b.WriteString(indent + "              fieldRef:\n")
		b.WriteString(indent + "                fieldPath: spec.nodeName\n")
	}
	if opts.IsCron() {
		b.WriteString(indent + "          - name: SMITHERS_CRON_SCHEDULE\n")
		b.WriteString(indent + "            value: " + yamlQuote(opts.CronSchedule) + "\n")
	}
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		b.WriteString(indent + "          - name: SMITHERS_WORKFLOW_PATH\n")
		b.WriteString(indent + "            value: " + yamlQuote("/workspace/.fabrik/"+opts.WorkflowBundle.WorkdirPath) + "\n")
		b.WriteString(indent + "          - name: SMITHERS_WORKDIR\n")
		b.WriteString(indent + "            value: " + yamlQuote("/workspace/workdir") + "\n")
		b.WriteString(indent + "          - name: SMITHERS_DB_PATH\n")
		b.WriteString(indent + "            value: " + yamlQuote("/workspace/.smithers/state.db") + "\n")
		b.WriteString(indent + "          - name: SMITHERS_LOG_DIR\n")
		b.WriteString(indent + "            value: " + yamlQuote("/workspace/.smithers/executions/"+opts.RunID+"/logs") + "\n")
		b.WriteString(indent + "          - name: SMITHERS_HOME\n")
		b.WriteString(indent + "            value: " + yamlQuote("/workspace") + "\n")
		b.WriteString(indent + "          - name: SMITHERS_INPUT_JSON\n")
		b.WriteString(indent + "            value: " + yamlQuote(opts.InputJSON) + "\n")
		if strings.TrimSpace(opts.JJRepo) != "" {
			b.WriteString(indent + "          - name: SMITHERS_JJ_REPO\n")
			b.WriteString(indent + "            value: " + yamlQuote(opts.JJRepo) + "\n")
		}
		if strings.TrimSpace(opts.JJBookmark) != "" {
			b.WriteString(indent + "          - name: SMITHERS_JJ_BOOKMARK\n")
			b.WriteString(indent + "            value: " + yamlQuote(opts.JJBookmark) + "\n")
		}
	}
	if envSecretName != "" {
		b.WriteString(indent + "        envFrom:\n")
		b.WriteString(indent + "          - secretRef:\n")
		b.WriteString(indent + "              name: " + envSecretName + "\n")
	}
	b.WriteString(indent + "        volumeMounts:\n")
	b.WriteString(indent + "          - name: workspace\n")
	b.WriteString(indent + "            mountPath: /workspace\n")
	b.WriteString(indent + "          - name: tmp\n")
	b.WriteString(indent + "            mountPath: /tmp\n")
	if envSecretName != "" {
		b.WriteString(indent + "          - name: project-env\n")
		b.WriteString(indent + "            mountPath: /etc/fabrik/env\n")
		b.WriteString(indent + "            readOnly: true\n")
	}
	// Shared credentials: directory mount (no subPath) so running jobs
	// can observe file replacements during credential rotation.
	// Mounted for ALL job types per spec 051 § Secret classes.
	if sharedBundle.SecretName != "" {
		b.WriteString(indent + "          - name: " + sharedCredentialVolume + "\n")
		b.WriteString(indent + "            mountPath: " + sharedBundle.MountPath + "\n")
		b.WriteString(indent + "            readOnly: true\n")
	}
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		b.WriteString(indent + "          - name: workflow\n")
		b.WriteString(indent + "            mountPath: /opt/fabrik-workflow/bundle.tgz\n")
		b.WriteString(indent + "            subPath: bundle.tgz\n")
		b.WriteString(indent + "            readOnly: true\n")
		if syncSecretName != "" {
			b.WriteString(indent + "          - name: fabrik-sync\n")
			b.WriteString(indent + "            mountPath: /opt/fabrik-sync/bundle.tgz\n")
			b.WriteString(indent + "            subPath: bundle.tgz\n")
			b.WriteString(indent + "            readOnly: true\n")
		}
	}
	if requiresSharedCredentialSync(opts, sharedBundle) {
		b.WriteString(indent + "      - name: shared-credential-sync\n")
		b.WriteString(indent + "        image: " + sharedCredentialHelperImage(opts) + "\n")
		b.WriteString(indent + "        imagePullPolicy: IfNotPresent\n")
		b.WriteString(indent + "        command: [\"sh\", \"-lc\", " + yamlQuote(buildSharedCredentialSyncCommand(sharedBundle)) + "]\n")
		b.WriteString(indent + "        env:\n")
		b.WriteString(indent + "          - name: FABRIK_SHARED_CREDENTIAL_SOURCE_NAMESPACE\n")
		b.WriteString(indent + "            value: " + yamlQuote(envSecretNamespace) + "\n")
		b.WriteString(indent + "          - name: FABRIK_SHARED_CREDENTIAL_SOURCE_SECRET\n")
		b.WriteString(indent + "            value: " + yamlQuote(sharedBundle.SecretName) + "\n")
		b.WriteString(indent + "          - name: FABRIK_SHARED_CREDENTIAL_TARGET_NAMESPACE\n")
		b.WriteString(indent + "            valueFrom:\n")
		b.WriteString(indent + "              fieldRef:\n")
		b.WriteString(indent + "                fieldPath: metadata.namespace\n")
		b.WriteString(indent + "          - name: FABRIK_SHARED_CREDENTIAL_TARGET_SECRET\n")
		b.WriteString(indent + "            value: " + yamlQuote(sharedBundle.SecretName) + "\n")
		b.WriteString(indent + "          - name: FABRIK_SHARED_CREDENTIAL_OPTIONAL\n")
		b.WriteString(indent + "            value: " + yamlQuote(strconv.FormatBool(sharedBundle.Optional)) + "\n")
		b.WriteString(indent + "          - name: FABRIK_SHARED_CREDENTIAL_POD_NAME\n")
		b.WriteString(indent + "            valueFrom:\n")
		b.WriteString(indent + "              fieldRef:\n")
		b.WriteString(indent + "                fieldPath: metadata.name\n")
		b.WriteString(indent + "        securityContext:\n")
		b.WriteString(indent + "          allowPrivilegeEscalation: false\n")
		b.WriteString(indent + "          readOnlyRootFilesystem: true\n")
		b.WriteString(indent + "          capabilities:\n")
		b.WriteString(indent + "            drop:\n")
		b.WriteString(indent + "              - ALL\n")
		b.WriteString(indent + "        volumeMounts:\n")
		b.WriteString(indent + "          - name: tmp\n")
		b.WriteString(indent + "            mountPath: /tmp\n")
	}
	b.WriteString(indent + "    volumes:\n")
	writeWorkspaceVolume(b, indent+"      ", opts, labels, pvcName)
	b.WriteString(indent + "      - name: tmp\n")
	b.WriteString(indent + "        emptyDir:\n")
	b.WriteString(indent + "          sizeLimit: 1Gi\n")
	if envSecretName != "" {
		b.WriteString(indent + "      - name: project-env\n")
		b.WriteString(indent + "        secret:\n")
		b.WriteString(indent + "          secretName: " + envSecretName + "\n")
		b.WriteString(indent + "          defaultMode: 0400\n")
	}
	// Shared credentials volume: available to all job types.
	// Secret is optional — Kubernetes handles missing secrets by keeping pod Pending.
	if sharedBundle.SecretName != "" {
		b.WriteString(indent + "      - name: " + sharedCredentialVolume + "\n")
		b.WriteString(indent + "        secret:\n")
		b.WriteString(indent + "          secretName: " + sharedBundle.SecretName + "\n")
		b.WriteString(indent + "          defaultMode: 0400\n")
		b.WriteString(indent + "          optional: " + strconv.FormatBool(sharedBundle.Optional) + "\n")
	}
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		b.WriteString(indent + "      - name: workflow\n")
		b.WriteString(indent + "        secret:\n")
		b.WriteString(indent + "          secretName: " + workflowSecretName + "\n")
		b.WriteString(indent + "          defaultMode: 0400\n")
		if syncSecretName != "" {
			b.WriteString(indent + "      - name: fabrik-sync\n")
			b.WriteString(indent + "        secret:\n")
			b.WriteString(indent + "          secretName: " + syncSecretName + "\n")
			b.WriteString(indent + "          defaultMode: 0400\n")
		}
	}
}

func writeWorkspaceVolume(b *strings.Builder, indent string, opts Options, labels map[string]string, pvcName string) {
	b.WriteString(indent + "- name: workspace\n")
	if opts.IsCron() {
		b.WriteString(indent + "  ephemeral:\n")
		b.WriteString(indent + "    volumeClaimTemplate:\n")
		b.WriteString(indent + "      metadata:\n")
		writeMap(b, indent+"        ", "labels", labels)
		b.WriteString(indent + "      spec:\n")
		b.WriteString(indent + "        accessModes:\n")
		b.WriteString(indent + "          - ReadWriteOnce\n")
		if strings.TrimSpace(opts.StorageClass) != "" {
			b.WriteString(indent + "        storageClassName: " + opts.StorageClass + "\n")
		}
		b.WriteString(indent + "        resources:\n")
		b.WriteString(indent + "          requests:\n")
		b.WriteString(indent + "            storage: " + opts.PVCSize + "\n")
		return
	}

	b.WriteString(indent + "  persistentVolumeClaim:\n")
	b.WriteString(indent + "    claimName: " + pvcName + "\n")
}

func buildWorkflowSecret(namespace, secretName string, bundle *WorkflowBundle) string {
	var b strings.Builder
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: Secret\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + secretName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	b.WriteString("type: Opaque\n")
	b.WriteString("data:\n")
	b.WriteString("  bundle.tgz: " + yamlQuote(bundle.ArchiveBase64) + "\n")
	return b.String()
}

func buildServiceAccountYAML(namespace, serviceAccountName string) string {
	var b strings.Builder
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: ServiceAccount\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + serviceAccountName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	return b.String()
}

func buildRunnerRoleYAML(namespace, roleName string, includeWorkflowAccess, includeSecretSync bool, sharedSecretName string) string {
	var b strings.Builder
	b.WriteString("apiVersion: rbac.authorization.k8s.io/v1\n")
	b.WriteString("kind: Role\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + roleName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	b.WriteString("rules:\n")
	if includeWorkflowAccess {
		b.WriteString("  - apiGroups: [\"batch\"]\n")
		b.WriteString("    resources: [\"jobs\", \"cronjobs\"]\n")
		b.WriteString("    verbs: [\"create\", \"delete\", \"get\", \"list\", \"patch\", \"update\", \"watch\"]\n")
		b.WriteString("  - apiGroups: [\"\"]\n")
		b.WriteString("    resources: [\"persistentvolumeclaims\"]\n")
		b.WriteString("    verbs: [\"create\", \"delete\", \"get\", \"list\", \"patch\", \"update\", \"watch\"]\n")
		b.WriteString("  - apiGroups: [\"\"]\n")
		b.WriteString("    resources: [\"pods\"]\n")
		b.WriteString("    verbs: [\"get\", \"list\", \"patch\", \"update\", \"watch\"]\n")
		b.WriteString("  - apiGroups: [\"\"]\n")
		b.WriteString("    resources: [\"pods/log\"]\n")
		b.WriteString("    verbs: [\"get\"]\n")
	}
	if includeSecretSync {
		b.WriteString("  - apiGroups: [\"\"]\n")
		b.WriteString("    resources: [\"secrets\"]\n")
		b.WriteString("    resourceNames: [" + yamlQuote(sharedSecretName) + "]\n")
		b.WriteString("    verbs: [\"get\", \"patch\", \"update\"]\n")
		b.WriteString("  - apiGroups: [\"\"]\n")
		b.WriteString("    resources: [\"pods\"]\n")
		b.WriteString("    verbs: [\"get\"]\n")
	}
	return b.String()
}

func buildWorkflowRunnerRoleBindingYAML(namespace, roleBindingName, roleName, serviceAccountName string) string {
	var b strings.Builder
	b.WriteString("apiVersion: rbac.authorization.k8s.io/v1\n")
	b.WriteString("kind: RoleBinding\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + roleBindingName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	b.WriteString("subjects:\n")
	b.WriteString("  - kind: ServiceAccount\n")
	b.WriteString("    name: " + serviceAccountName + "\n")
	b.WriteString("    namespace: " + namespace + "\n")
	b.WriteString("roleRef:\n")
	b.WriteString("  apiGroup: rbac.authorization.k8s.io\n")
	b.WriteString("  kind: Role\n")
	b.WriteString("  name: " + roleName + "\n")
	return b.String()
}

func buildSharedCredentialSourceRoleYAML(namespace, roleName, secretName string) string {
	var b strings.Builder
	b.WriteString("apiVersion: rbac.authorization.k8s.io/v1\n")
	b.WriteString("kind: Role\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + roleName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	b.WriteString("rules:\n")
	b.WriteString("  - apiGroups: [\"\"]\n")
	b.WriteString("    resources: [\"secrets\"]\n")
	b.WriteString("    resourceNames: [" + yamlQuote(secretName) + "]\n")
	b.WriteString("    verbs: [\"get\"]\n")
	return b.String()
}

func buildSharedCredentialSourceRoleBindingYAML(namespace, roleBindingName, roleName, serviceAccountName, serviceAccountNamespace string) string {
	var b strings.Builder
	b.WriteString("apiVersion: rbac.authorization.k8s.io/v1\n")
	b.WriteString("kind: RoleBinding\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + roleBindingName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	b.WriteString("subjects:\n")
	b.WriteString("  - kind: ServiceAccount\n")
	b.WriteString("    name: " + serviceAccountName + "\n")
	b.WriteString("    namespace: " + serviceAccountNamespace + "\n")
	b.WriteString("roleRef:\n")
	b.WriteString("  apiGroup: rbac.authorization.k8s.io\n")
	b.WriteString("  kind: Role\n")
	b.WriteString("  name: " + roleName + "\n")
	return b.String()
}

func buildSyncSecret(namespace, secretName string, bundle *SyncBundle) string {
	var b strings.Builder
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: Secret\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + secretName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	b.WriteString("type: Opaque\n")
	b.WriteString("data:\n")
	b.WriteString("  bundle.tgz: " + yamlQuote(bundle.ArchiveBase64) + "\n")
	return b.String()
}

func buildSyncPodYAML(namespace, podName, pvcName string) string {
	var b strings.Builder
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: Pod\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + podName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	b.WriteString("spec:\n")
	b.WriteString("  securityContext:\n")
	b.WriteString("    runAsNonRoot: true\n")
	b.WriteString("    runAsUser: 1000\n")
	b.WriteString("    runAsGroup: 1000\n")
	b.WriteString("    fsGroup: 1000\n")
	b.WriteString("    seccompProfile:\n")
	b.WriteString("      type: RuntimeDefault\n")
	b.WriteString("  restartPolicy: Never\n")
	b.WriteString("  nodeSelector:\n")
	b.WriteString("    node-role.kubernetes.io/control-plane: \"true\"\n")
	b.WriteString("  containers:\n")
	b.WriteString("    - name: sync\n")
	b.WriteString("      image: alpine:3.20\n")
	b.WriteString("      command: [\"sh\", \"-lc\", \"sleep 300\"]\n")
	b.WriteString("      securityContext:\n")
	b.WriteString("        allowPrivilegeEscalation: false\n")
	b.WriteString("        readOnlyRootFilesystem: true\n")
	b.WriteString("        capabilities:\n")
	b.WriteString("          drop:\n")
	b.WriteString("            - ALL\n")
	b.WriteString("      volumeMounts:\n")
	b.WriteString("        - name: workspace\n")
	b.WriteString("          mountPath: /workspace\n")
	b.WriteString("        - name: tmp\n")
	b.WriteString("          mountPath: /tmp\n")
	b.WriteString("  volumes:\n")
	b.WriteString("    - name: workspace\n")
	b.WriteString("      persistentVolumeClaim:\n")
	b.WriteString("        claimName: " + pvcName + "\n")
	b.WriteString("    - name: tmp\n")
	b.WriteString("      emptyDir:\n")
	b.WriteString("        sizeLimit: 1Gi\n")
	return b.String()
}

func writeMap(b *strings.Builder, indent, key string, values map[string]string) {
	b.WriteString(indent + key + ":\n")
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := values[k]
		b.WriteString(indent + "  " + k + ": " + yamlQuote(v) + "\n")
	}
}

func yamlQuote(value string) string {
	return strconv.Quote(value)
}

func sanitizeName(value string) string {
	value = strings.ToLower(value)
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteRune('-')
			lastDash = true
		}
	}

	result := strings.Trim(b.String(), "-")
	if result == "" {
		return "run"
	}

	return result
}

func trimK8sName(value string) string {
	value = sanitizeName(value)
	if len(value) > 63 {
		value = value[:63]
	}
	return strings.Trim(value, "-")
}

func DefaultJobCommand() string {
	return strings.Join([]string{
		"set -eu",
		"mkdir -p /workspace/workdir/public /workspace/.smithers",
		"printf '%s\\n' \"$SMITHERS_RUN_ID\" > /workspace/workdir/run-id.txt",
		"printf '<html><body><h1>Hello from Fabrik</h1><p>%s</p></body></html>\\n' \"$SMITHERS_RUN_ID\" > /workspace/workdir/public/hello-world.html",
		": > /workspace/.smithers/state.db",
		"echo 'dispatch complete'",
	}, " && ")
}
