#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUN_ID="${1:-k3d-local}"
NAMESPACE="${NAMESPACE:-default}"
PRE_CLEAN_WORKDIR="${PRE_CLEAN_WORKDIR:-1}"
PVC_SIZE="${PVC_SIZE:-10Gi}"
PVC_STORAGE_CLASS="${PVC_STORAGE_CLASS:-}"

sanitize() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-'
}

SAFE_RUN_ID="$(sanitize "$RUN_ID")"
JOB_NAME="smithers-${SAFE_RUN_ID}"
SYNC_POD="smithers-sync-${SAFE_RUN_ID}"
CLEAN_POD="smithers-clean-${SAFE_RUN_ID}"
PVC_NAME="data-fabrik-${SAFE_RUN_ID}"

# K8s names must be <=63 chars and start/end with alnum.
JOB_NAME="$(printf '%s' "$JOB_NAME" | cut -c1-63 | sed 's/^[^a-z0-9]*//; s/[^a-z0-9]*$//')"
SYNC_POD="$(printf '%s' "$SYNC_POD" | cut -c1-63 | sed 's/^[^a-z0-9]*//; s/[^a-z0-9]*$//')"
CLEAN_POD="$(printf '%s' "$CLEAN_POD" | cut -c1-63 | sed 's/^[^a-z0-9]*//; s/[^a-z0-9]*$//')"
PVC_NAME="$(printf '%s' "$PVC_NAME" | cut -c1-63 | sed 's/^[^a-z0-9]*//; s/[^a-z0-9]*$//')"
if [ -z "$JOB_NAME" ]; then
  echo "failed to derive a valid job name from run id: $RUN_ID" >&2
  exit 1
fi
if [ -z "$SYNC_POD" ]; then
  echo "failed to derive a valid sync pod name from run id: $RUN_ID" >&2
  exit 1
fi
if [ -z "$CLEAN_POD" ]; then
  echo "failed to derive a valid clean pod name from run id: $RUN_ID" >&2
  exit 1
fi
if [ -z "$PVC_NAME" ]; then
  echo "failed to derive a valid pvc name from run id: $RUN_ID" >&2
  exit 1
fi

cleanup() {
  kubectl -n "$NAMESPACE" delete pod "$SYNC_POD" --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete pod "$CLEAN_POD" --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

SYNC_ROOT="$REPO_ROOT/k8s/job-sync/$SAFE_RUN_ID"
mkdir -p "$SYNC_ROOT"
printf '%s\n' "$RUN_ID" > "$SYNC_ROOT/run-id.txt"

echo "[1/8] Ensuring PVC exists"
if [ -n "$PVC_STORAGE_CLASS" ]; then
  PVC_STORAGE_CLASS_LINE="  storageClassName: $PVC_STORAGE_CLASS"
else
  PVC_STORAGE_CLASS_LINE=""
fi
cat <<YAML | kubectl -n "$NAMESPACE" apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $PVC_NAME
spec:
  accessModes:
    - ReadWriteOnce
$PVC_STORAGE_CLASS_LINE
  resources:
    requests:
      storage: $PVC_SIZE
YAML

if [ "$PRE_CLEAN_WORKDIR" = "1" ]; then
  echo "[2/8] Cleaning /workspace/workdir on PVC"
  kubectl -n "$NAMESPACE" delete pod "$CLEAN_POD" --ignore-not-found >/dev/null
  cat <<YAML | kubectl -n "$NAMESPACE" apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: $CLEAN_POD
spec:
  restartPolicy: Never
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: $PVC_NAME
  containers:
    - name: clean
      image: alpine:3.20
      command: ["sh", "-lc", "mkdir -p /workspace/workdir && find /workspace/workdir -mindepth 1 -maxdepth 1 -exec rm -rf {} +"]
      volumeMounts:
        - name: workspace
          mountPath: /workspace
YAML
  if ! kubectl -n "$NAMESPACE" wait --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s "pod/$CLEAN_POD" >/dev/null; then
    echo "clean pod did not complete successfully; recent logs:" >&2
    kubectl -n "$NAMESPACE" logs "$CLEAN_POD" --tail=200 || true
    exit 1
  fi
  kubectl -n "$NAMESPACE" delete pod "$CLEAN_POD" --ignore-not-found >/dev/null
else
  echo "[2/8] Skipping pre-clean (/workspace/workdir)"
fi

CODEX_AUTH_FILE="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
CODEX_CONFIG_FILE="${CODEX_CONFIG_FILE:-$HOME/.codex/config.toml}"
if [ ! -f "$CODEX_AUTH_FILE" ]; then
  echo "missing Codex auth file: $CODEX_AUTH_FILE" >&2
  exit 1
fi
if [ ! -f "$CODEX_CONFIG_FILE" ]; then
  echo "missing Codex config file: $CODEX_CONFIG_FILE" >&2
  exit 1
fi

echo "[3/8] Applying codex-auth secret"
kubectl -n "$NAMESPACE" create secret generic codex-auth \
  --from-file=auth.json="$CODEX_AUTH_FILE" \
  --from-file=config.toml="$CODEX_CONFIG_FILE" \
  --dry-run=client -o yaml | kubectl -n "$NAMESPACE" apply -f -

echo "[4/8] Creating Job $JOB_NAME"
kubectl -n "$NAMESPACE" delete job "$JOB_NAME" --ignore-not-found >/dev/null
cat <<YAML | kubectl -n "$NAMESPACE" apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 604800
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: smithers
          image: fabrik-smithers:dev
          imagePullPolicy: IfNotPresent
          env:
            - name: SMITHERS_RUN_ID
              value: "$RUN_ID"
            - name: SMITHERS_INPUT_JSON
              value: "{}"
            - name: SMITHERS_RUNTIME_DIR
              value: "/opt/smithers-runtime"
            - name: SMITHERS_WORKDIR
              value: "/workspace/workdir"
            - name: SMITHERS_DB_PATH
              value: "/workspace/.smithers/state.db"
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: codex-auth
              mountPath: /root/.codex/auth.json
              subPath: auth.json
              readOnly: true
            - name: codex-auth
              mountPath: /root/.codex/config.toml
              subPath: config.toml
              readOnly: true
      volumes:
        - name: workspace
          persistentVolumeClaim:
            claimName: $PVC_NAME
        - name: codex-auth
          secret:
            secretName: codex-auth
            defaultMode: 0400
YAML

echo "[5/8] Linking PVC to Job for TTL cleanup"
JOB_UID="$(kubectl -n "$NAMESPACE" get job "$JOB_NAME" -o jsonpath='{.metadata.uid}')"
kubectl -n "$NAMESPACE" patch pvc "$PVC_NAME" --type=merge -p "{
  \"metadata\": {
    \"ownerReferences\": [{
      \"apiVersion\": \"batch/v1\",
      \"kind\": \"Job\",
      \"name\": \"$JOB_NAME\",
      \"uid\": \"$JOB_UID\"
    }]
  }
}" >/dev/null

echo "[6/8] Waiting for job completion"
if ! kubectl -n "$NAMESPACE" wait --for=condition=complete --timeout=30m "job/$JOB_NAME" >/dev/null; then
  echo "job did not complete successfully; recent logs:" >&2
  POD_NAME="$(kubectl -n "$NAMESPACE" get pods -l job-name="$JOB_NAME" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "$POD_NAME" ]; then
    kubectl -n "$NAMESPACE" logs "$POD_NAME" --tail=200 || true
  fi
  exit 1
fi

POD_NAME="$(kubectl -n "$NAMESPACE" get pods -l job-name="$JOB_NAME" -o jsonpath='{.items[0].metadata.name}')"

echo "[7/8] Saving pod logs"
kubectl -n "$NAMESPACE" logs "$POD_NAME" > "$SYNC_ROOT/job.log"

echo "[8/8] Syncing /workspace/workdir and state.db from PVC"
kubectl -n "$NAMESPACE" delete pod "$SYNC_POD" --ignore-not-found >/dev/null
cat <<YAML | kubectl -n "$NAMESPACE" apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: $SYNC_POD
spec:
  restartPolicy: Never
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: $PVC_NAME
  containers:
    - name: sync
      image: alpine:3.20
      command: ["sh", "-lc", "sleep 1800"]
      volumeMounts:
        - name: workspace
          mountPath: /workspace
YAML
kubectl -n "$NAMESPACE" wait --for=condition=Ready --timeout=120s "pod/$SYNC_POD" >/dev/null
rm -rf "$SYNC_ROOT/workdir"
kubectl -n "$NAMESPACE" cp "$SYNC_POD:/workspace/workdir" "$SYNC_ROOT/workdir"
kubectl -n "$NAMESPACE" cp "$SYNC_POD:/workspace/.smithers/state.db" "$SYNC_ROOT/state.db" || true

echo "[9/9] Done"
echo "Synced artifacts: $SYNC_ROOT"
echo "Generated file: $SYNC_ROOT/workdir/public/hello-world.html"
