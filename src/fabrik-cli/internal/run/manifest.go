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
	JobName        string
	PVCName        string
	WorkflowConfig string
	SyncSecret     string
	PVCYAML        string
	JobYAML        string
}

func (m Manifests) AllYAML() string {
	parts := []string{}
	if m.WorkflowConfig != "" {
		parts = append(parts, m.WorkflowConfig)
	}
	if m.SyncSecret != "" {
		parts = append(parts, m.SyncSecret)
	}
	parts = append(parts, m.PVCYAML, m.JobYAML)
	return strings.Join(parts, "---\n")
}

func (m Manifests) Summary() string {
	return fmt.Sprintf("dispatching\n  job: %s\n  pvc: %s\n", m.JobName, m.PVCName)
}

func BuildManifests(opts Options) (Manifests, error) {
	safeRunID := sanitizeName(opts.RunID)
	specID := sanitizeName(strings.TrimSuffix(filepath.Base(opts.SpecPath), filepath.Ext(opts.SpecPath)))
	jobName := trimK8sName("fabrik-" + safeRunID)
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

	pvcYAML := buildPVCYAML(opts, pvcName, labels)
	jobYAML := buildJobYAML(opts, jobName, pvcName, workflowConfigName, syncSecretName, labels, annotations)

	return Manifests{
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
	b.WriteString("  template:\n")
	b.WriteString("    metadata:\n")
	writeMap(&b, "      ", "labels", labels)
	writeMap(&b, "      ", "annotations", annotations)
	b.WriteString("    spec:\n")
	b.WriteString("      nodeSelector:\n")
	b.WriteString("        node-role.kubernetes.io/control-plane: \"true\"\n")
	b.WriteString("      restartPolicy: Never\n")
	b.WriteString("      containers:\n")
	b.WriteString("        - name: fabrik\n")
	b.WriteString("          image: " + opts.Image + "\n")
	b.WriteString("          imagePullPolicy: IfNotPresent\n")
	if strings.TrimSpace(opts.WorkflowPath) == "" {
		b.WriteString("          command: [\"sh\", \"-lc\", " + yamlQuote(opts.JobCommand) + "]\n")
	} else {
		bootstrap := "mkdir -p /workspace/workdir/workflows /workspace/.smithers"
		if syncSecretName != "" {
			bootstrap += " && if [ -f /opt/fabrik-sync/bundle.tgz ]; then tar -xzf /opt/fabrik-sync/bundle.tgz -C /workspace/workdir; fi"
		}
		bootstrap += " && exec /opt/smithers-runtime/run.sh"
		b.WriteString("          command: [\"sh\", \"-lc\", " + yamlQuote(bootstrap) + "]\n")
	}
	b.WriteString("          env:\n")
	b.WriteString("            - name: SMITHERS_RUN_ID\n")
	b.WriteString("              value: " + yamlQuote(opts.RunID) + "\n")
	b.WriteString("            - name: SMITHERS_SPEC_PATH\n")
	b.WriteString("              value: " + yamlQuote(opts.SpecPath) + "\n")
	b.WriteString("            - name: SMITHERS_PROJECT\n")
	b.WriteString("              value: " + yamlQuote(opts.Project) + "\n")
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		b.WriteString("            - name: SMITHERS_INPUT_JSON\n")
		b.WriteString("              value: " + yamlQuote(opts.InputJSON) + "\n")
		if strings.TrimSpace(opts.JJRepo) != "" {
			b.WriteString("            - name: SMITHERS_JJ_REPO\n")
			b.WriteString("              value: " + yamlQuote(opts.JJRepo) + "\n")
		}
		if strings.TrimSpace(opts.JJBookmark) != "" {
			b.WriteString("            - name: SMITHERS_JJ_BOOKMARK\n")
			b.WriteString("              value: " + yamlQuote(opts.JJBookmark) + "\n")
		}
	}
	b.WriteString("          volumeMounts:\n")
	b.WriteString("            - name: workspace\n")
	b.WriteString("              mountPath: /workspace\n")
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		b.WriteString("            - name: workflow\n")
		b.WriteString("              mountPath: /opt/smithers-runtime/workflow.tsx\n")
		b.WriteString("              subPath: workflow.tsx\n")
		b.WriteString("            - name: codex-auth\n")
		b.WriteString("              mountPath: /root/.codex/auth.json\n")
		b.WriteString("              subPath: auth.json\n")
		b.WriteString("              readOnly: true\n")
		b.WriteString("            - name: codex-auth\n")
		b.WriteString("              mountPath: /root/.codex/config.toml\n")
		b.WriteString("              subPath: config.toml\n")
		b.WriteString("              readOnly: true\n")
		if syncSecretName != "" {
			b.WriteString("            - name: fabrik-sync\n")
			b.WriteString("              mountPath: /opt/fabrik-sync/bundle.tgz\n")
			b.WriteString("              subPath: bundle.tgz\n")
			b.WriteString("              readOnly: true\n")
		}
	}
	b.WriteString("      volumes:\n")
	b.WriteString("        - name: workspace\n")
	b.WriteString("          persistentVolumeClaim:\n")
	b.WriteString("            claimName: " + pvcName + "\n")
	if strings.TrimSpace(opts.WorkflowPath) != "" {
		b.WriteString("        - name: workflow\n")
		b.WriteString("          configMap:\n")
		b.WriteString("            name: " + workflowConfigName + "\n")
		b.WriteString("        - name: codex-auth\n")
		b.WriteString("          secret:\n")
		b.WriteString("            secretName: codex-auth\n")
		b.WriteString("            defaultMode: 0400\n")
		if syncSecretName != "" {
			b.WriteString("        - name: fabrik-sync\n")
			b.WriteString("          secret:\n")
			b.WriteString("            secretName: " + syncSecretName + "\n")
			b.WriteString("            defaultMode: 0400\n")
		}
	}
	return b.String()
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
