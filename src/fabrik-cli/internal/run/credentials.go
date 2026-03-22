package run

import (
	"fmt"
	"strings"
)

const (
	sharedCredentialDefaultSecretName  = "fabrik-credentials"
	sharedCredentialMountPath          = "/var/run/fabrik/credentials/shared"
	sharedCredentialVolume             = "fabrik-credentials"
	sharedCredentialSecretName         = sharedCredentialDefaultSecretName
	defaultSharedCredentialHelperImage = "bitnami/kubectl:latest"
	sharedCredentialHelperImageEnv     = "FABRIK_SHARED_CREDENTIAL_HELPER_IMAGE"
	sharedCredentialSyncInterval       = "5"
	sharedCredentialSyncMaxFailures    = "3"
)

type sharedCredentialBundle struct {
	SecretName string
	MountPath  string
	Optional   bool
	SourceKind string
}

func resolveSharedCredentialBundle(opts Options) (sharedCredentialBundle, error) {
	if opts.DisableSharedCredentials {
		return sharedCredentialBundle{}, nil
	}

	bundle := sharedCredentialBundle{
		MountPath: sharedCredentialMountPath,
	}

	switch {
	case strings.TrimSpace(opts.SharedCredentialFile) != "":
		bundle.SecretName = trimK8sName("fabrik-credential-" + sanitizeName(opts.RunID))
		bundle.Optional = false
		bundle.SourceKind = "file"
	case strings.TrimSpace(opts.SharedCredentialDir) != "":
		bundle.SecretName = trimK8sName("fabrik-credential-" + sanitizeName(opts.RunID))
		bundle.Optional = false
		bundle.SourceKind = "dir"
	case strings.TrimSpace(opts.SharedCredentialSecret) != "":
		name := strings.TrimSpace(opts.SharedCredentialSecret)
		if name == "" {
			return sharedCredentialBundle{}, fmt.Errorf("shared credential secret name is empty")
		}
		bundle.SecretName = name
		bundle.Optional = false
		bundle.SourceKind = "secret"
	default:
		bundle.SecretName = sharedCredentialDefaultSecretName
		bundle.Optional = true
		bundle.SourceKind = "default"
	}

	return bundle, nil
}

func buildSharedCredentialBootstrap(bundle sharedCredentialBundle) string {
	if bundle.SecretName == "" {
		return ":"
	}
	return "CRED_DIR=${FABRIK_SHARED_CREDENTIALS_DIR:-" + bundle.MountPath + "}" +
		" && if [ -d \"$CRED_DIR\" ]; then " +
		"for cred_file in \"$CRED_DIR\"/*; do " +
		"[ -f \"$cred_file\" ] || continue; " +
		"cred_name=$(basename \"$cred_file\"); " +
		"case \"$cred_name\" in ''|*[!A-Za-z0-9_]*|[0-9]*) continue ;; esac; " +
		"if env | grep -q \"^${cred_name}=\"; then continue; fi; " +
		"cred_value=$(cat \"$cred_file\") && export \"$cred_name=$cred_value\"; " +
		"done; fi"
}

func requiresSharedCredentialSync(opts Options, bundle sharedCredentialBundle) bool {
	if bundle.SecretName == "" {
		return false
	}
	if opts.Namespace == envSecretNamespace {
		return false
	}
	switch bundle.SourceKind {
	case "default", "secret":
		return true
	default:
		return false
	}
}

func sharedCredentialHelperImage(opts Options) string {
	if strings.TrimSpace(opts.SharedCredentialHelperImage) != "" {
		return opts.SharedCredentialHelperImage
	}
	return defaultSharedCredentialHelperImage
}

func buildSharedCredentialSyncCommand(bundle sharedCredentialBundle) string {
	if bundle.SecretName == "" {
		return "sleep infinity"
	}
	return strings.Join([]string{
		"set -eu",
		"MANIFEST_FILE=$(mktemp /tmp/fabrik-shared-credentials.XXXXXX)",
		"MAX_FAILURES=" + sharedCredentialSyncMaxFailures,
		"failure_count=0",
		"cleanup() { rm -f \"$MANIFEST_FILE\"; }",
		"trap cleanup EXIT",
		"main_container_done() { " +
			"terminated=$(kubectl -n \"$FABRIK_SHARED_CREDENTIAL_TARGET_NAMESPACE\" get pod \"$FABRIK_SHARED_CREDENTIAL_POD_NAME\" -o jsonpath='{.status.containerStatuses[?(@.name==\"fabrik\")].state.terminated.exitCode}' 2>/dev/null || true); " +
			"[ -n \"$terminated\" ]; " +
			"}",
		"render_manifest() { " +
			"data_lines=''; " +
			"if kubectl -n \"$FABRIK_SHARED_CREDENTIAL_SOURCE_NAMESPACE\" get secret \"$FABRIK_SHARED_CREDENTIAL_SOURCE_SECRET\" >/dev/null 2>&1; then " +
			"data_lines=$(kubectl -n \"$FABRIK_SHARED_CREDENTIAL_SOURCE_NAMESPACE\" get secret \"$FABRIK_SHARED_CREDENTIAL_SOURCE_SECRET\" -o go-template='{{range $k, $v := .data}}{{printf \"  %s: %s\\n\" $k $v}}{{end}}'); " +
			"elif [ \"$FABRIK_SHARED_CREDENTIAL_OPTIONAL\" != \"true\" ]; then " +
			"echo \"missing shared credential source secret $FABRIK_SHARED_CREDENTIAL_SOURCE_NAMESPACE/$FABRIK_SHARED_CREDENTIAL_SOURCE_SECRET\" >&2; return 1; " +
			"fi; " +
			"{ " +
			"printf '%s\\n' 'apiVersion: v1' 'kind: Secret' 'metadata:'; " +
			"printf '  name: %s\\n' \"$FABRIK_SHARED_CREDENTIAL_TARGET_SECRET\"; " +
			"printf '  namespace: %s\\n' \"$FABRIK_SHARED_CREDENTIAL_TARGET_NAMESPACE\"; " +
			"printf '%s\\n' 'type: Opaque' 'data:'; " +
			"if [ -n \"$data_lines\" ]; then printf '%s\\n' \"$data_lines\"; fi; " +
			"} > \"$MANIFEST_FILE\"; " +
			"}",
		"sync_once() { render_manifest && kubectl -n \"$FABRIK_SHARED_CREDENTIAL_TARGET_NAMESPACE\" replace -f \"$MANIFEST_FILE\" >/dev/null; }",
		"if ! sync_once; then echo 'shared credential sync failed during initial reconcile' >&2; exit 1; fi",
		"while true; do " +
			"if main_container_done; then exit 0; fi; " +
			"sleep " + sharedCredentialSyncInterval + "; " +
			"if sync_once; then failure_count=0; " +
			"else failure_count=$((failure_count + 1)); echo \"shared credential sync failed (${failure_count}/${MAX_FAILURES})\" >&2; if [ \"$failure_count\" -ge \"$MAX_FAILURES\" ]; then exit 1; fi; fi; " +
			"done",
	}, " && ")
}
