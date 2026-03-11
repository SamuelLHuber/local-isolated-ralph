package run

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type Manifests struct {
	Kind           string
	JobName        string
	CronJobName    string
	PVCName        string
	WorkflowConfig string
	SyncSecret     string
	PVCYAML        string
	JobYAML        string
	CronJobYAML    string
}

func (m Manifests) AllYAML() string {
	parts := []string{}
	if m.WorkflowConfig != "" {
		parts = append(parts, m.WorkflowConfig)
	}
	if m.SyncSecret != "" {
		parts = append(parts, m.SyncSecret)
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

	workflowConfigName := ""
	workflowConfig := ""
	syncSecretName := ""
	syncSecret := ""
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		source, err := os.ReadFile(opts.WorkflowPath)
		if err != nil {
			return Manifests{}, err
		}
		workflowConfigName = trimK8sName("fabrik-workflow-" + safeRunID)
		workflowConfig = buildWorkflowConfigMap(opts.Namespace, workflowConfigName, string(source))
		annotations["fabrik.sh/workflow-path"] = opts.WorkflowPath
		if opts.SyncBundle != nil {
			syncSecretName = trimK8sName("fabrik-sync-" + safeRunID)
			syncSecret = buildSyncSecret(opts.Namespace, syncSecretName, opts.SyncBundle)
			annotations["fabrik.sh/fabrik-sync-path"] = opts.SyncBundle.ManifestPath
		}
	}

	if opts.IsCron() {
		cronJobYAML := buildCronJobYAML(opts, cronJobName, workflowConfigName, syncSecretName, labels, annotations)
		return Manifests{
			Kind:           "CronJob",
			CronJobName:    cronJobName,
			PVCName:        opts.CronSchedule,
			WorkflowConfig: workflowConfig,
			SyncSecret:     syncSecret,
			CronJobYAML:    cronJobYAML,
		}, nil
	}

	pvcYAML := buildPVCYAML(opts, pvcName, labels)
	jobYAML := buildJobYAML(opts, jobName, pvcName, workflowConfigName, syncSecretName, labels, annotations)

	return Manifests{
		Kind:           "Job",
		JobName:        jobName,
		PVCName:        pvcName,
		WorkflowConfig: workflowConfig,
		SyncSecret:     syncSecret,
		PVCYAML:        pvcYAML,
		JobYAML:        jobYAML,
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

func buildJobYAML(opts Options, jobName, pvcName, workflowConfigName, syncSecretName string, labels, annotations map[string]string) string {
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
	b.WriteString("  backoffLimit: 0\n")
	writePodTemplate(&b, "  ", opts, labels, annotations, workflowConfigName, syncSecretName, pvcName)
	return b.String()
}

func buildCronJobYAML(opts Options, cronJobName, workflowConfigName, syncSecretName string, labels, annotations map[string]string) string {
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
	b.WriteString("      backoffLimit: 0\n")
	writePodTemplate(&b, "      ", opts, labels, annotations, workflowConfigName, syncSecretName, "")
	return b.String()
}

func writePodTemplate(b *strings.Builder, indent string, opts Options, labels, annotations map[string]string, workflowConfigName, syncSecretName, pvcName string) {
	envSecretName := opts.EnvSecretName()
	b.WriteString(indent + "template:\n")
	b.WriteString(indent + "  metadata:\n")
	writeMap(b, indent+"    ", "labels", labels)
	writeMap(b, indent+"    ", "annotations", annotations)
	b.WriteString(indent + "  spec:\n")
	b.WriteString(indent + "    nodeSelector:\n")
	b.WriteString(indent + "      node-role.kubernetes.io/control-plane: \"true\"\n")
	b.WriteString(indent + "    restartPolicy: Never\n")
	b.WriteString(indent + "    containers:\n")
	b.WriteString(indent + "      - name: fabrik\n")
	b.WriteString(indent + "        image: " + opts.Image + "\n")
	b.WriteString(indent + "        imagePullPolicy: IfNotPresent\n")
	if strings.TrimSpace(opts.WorkflowPath) == "" {
		b.WriteString(indent + "        command: [\"sh\", \"-lc\", " + yamlQuote(opts.JobCommand) + "]\n")
	} else {
		bootstrap := "mkdir -p /workspace/workdir/workflows /workspace/.smithers"
		if syncSecretName != "" {
			bootstrap += " && if [ -f /opt/fabrik-sync/bundle.tgz ]; then tar -xzf /opt/fabrik-sync/bundle.tgz -C /workspace/workdir; fi"
		}
		bootstrap += " && exec /opt/smithers-runtime/run.sh"
		b.WriteString(indent + "        command: [\"sh\", \"-lc\", " + yamlQuote(bootstrap) + "]\n")
	}
	b.WriteString(indent + "        env:\n")
	b.WriteString(indent + "          - name: SMITHERS_RUN_ID\n")
	b.WriteString(indent + "            value: " + yamlQuote(opts.RunID) + "\n")
	b.WriteString(indent + "          - name: SMITHERS_SPEC_PATH\n")
	b.WriteString(indent + "            value: " + yamlQuote(opts.SpecPath) + "\n")
	b.WriteString(indent + "          - name: SMITHERS_PROJECT\n")
	b.WriteString(indent + "            value: " + yamlQuote(opts.Project) + "\n")
	if opts.IsCron() {
		b.WriteString(indent + "          - name: SMITHERS_CRON_SCHEDULE\n")
		b.WriteString(indent + "            value: " + yamlQuote(opts.CronSchedule) + "\n")
	}
	if strings.TrimSpace(opts.WorkflowPath) != "" {
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
	if envSecretName != "" {
		b.WriteString(indent + "          - name: project-env\n")
		b.WriteString(indent + "            mountPath: /etc/fabrik/env\n")
		b.WriteString(indent + "            readOnly: true\n")
	}
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		b.WriteString(indent + "          - name: workflow\n")
		b.WriteString(indent + "            mountPath: /opt/smithers-runtime/workflow.tsx\n")
		b.WriteString(indent + "            subPath: workflow.tsx\n")
		b.WriteString(indent + "          - name: codex-auth\n")
		b.WriteString(indent + "            mountPath: /root/.codex/auth.json\n")
		b.WriteString(indent + "            subPath: auth.json\n")
		b.WriteString(indent + "            readOnly: true\n")
		b.WriteString(indent + "          - name: codex-auth\n")
		b.WriteString(indent + "            mountPath: /root/.codex/config.toml\n")
		b.WriteString(indent + "            subPath: config.toml\n")
		b.WriteString(indent + "            readOnly: true\n")
		if syncSecretName != "" {
			b.WriteString(indent + "          - name: fabrik-sync\n")
			b.WriteString(indent + "            mountPath: /opt/fabrik-sync/bundle.tgz\n")
			b.WriteString(indent + "            subPath: bundle.tgz\n")
			b.WriteString(indent + "            readOnly: true\n")
		}
	}
	b.WriteString(indent + "    volumes:\n")
	writeWorkspaceVolume(b, indent+"      ", opts, labels, pvcName)
	if envSecretName != "" {
		b.WriteString(indent + "      - name: project-env\n")
		b.WriteString(indent + "        secret:\n")
		b.WriteString(indent + "          secretName: " + envSecretName + "\n")
		b.WriteString(indent + "          defaultMode: 0400\n")
	}
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		b.WriteString(indent + "      - name: workflow\n")
		b.WriteString(indent + "        configMap:\n")
		b.WriteString(indent + "          name: " + workflowConfigName + "\n")
		b.WriteString(indent + "      - name: codex-auth\n")
		b.WriteString(indent + "        secret:\n")
		b.WriteString(indent + "          secretName: codex-auth\n")
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

func buildWorkflowConfigMap(namespace, configMapName, workflowSource string) string {
	var b strings.Builder
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: ConfigMap\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + configMapName + "\n")
	b.WriteString("  namespace: " + namespace + "\n")
	b.WriteString("data:\n")
	b.WriteString("  workflow.tsx: |-\n")
	for _, line := range strings.Split(strings.ReplaceAll(workflowSource, "\r\n", "\n"), "\n") {
		b.WriteString("    " + line + "\n")
	}
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
	b.WriteString("  restartPolicy: Never\n")
	b.WriteString("  nodeSelector:\n")
	b.WriteString("    node-role.kubernetes.io/control-plane: \"true\"\n")
	b.WriteString("  containers:\n")
	b.WriteString("    - name: sync\n")
	b.WriteString("      image: alpine:3.20\n")
	b.WriteString("      command: [\"sh\", \"-lc\", \"sleep 300\"]\n")
	b.WriteString("      volumeMounts:\n")
	b.WriteString("        - name: workspace\n")
	b.WriteString("          mountPath: /workspace\n")
	b.WriteString("  volumes:\n")
	b.WriteString("    - name: workspace\n")
	b.WriteString("      persistentVolumeClaim:\n")
	b.WriteString("        claimName: " + pvcName + "\n")
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
