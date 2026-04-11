#!/usr/bin/env bash
# Update the Codex auth pool in a Kubernetes cluster from local ~/.codex profiles.
#
# Usage:
#   KUBECONFIG=~/.kube/hoth ./scripts/cluster-codex-update-credentials.sh
#   ./scripts/cluster-codex-update-credentials.sh --kubeconfig ~/.kube/hoth
#   ./scripts/cluster-codex-update-credentials.sh --kubeconfig ~/.kube/hoth --dry-run
#
# Reads all *.auth.json files from ~/.codex (or CODEX_DIR) and upserts them
# into the fabrik-credentials secret. Only named pool files are synced —
# auth.json (the active slot) is excluded because the fabrik-runtime
# auto-rotates the best pool member into it at startup.
#
# Requires:
#   - kubectl
#   - At least one *.auth.json in ~/.codex
#
# Notes:
#   - Uses a bash array for --from-file args, so filenames are passed safely
#   - Fails with a clear error if no *.auth.json files exist
#   - Secret keys match the local filenames (e.g. samb.auth.json)
#
# See also:
#   - https://github.com/SamuelLHuber/ai-sub-usage-tracker (check usage first)
#   - scripts/cluster-codex-usage.sh (view pool status)
set -euo pipefail

CODEX_DIR="${CODEX_DIR:-${HOME}/.codex}"
KUBE="${KUBECONFIG:-}"
SECRET_NAME="${FABRIK_CREDENTIALS_SECRET:-fabrik-credentials}"
SECRET_NS="${FABRIK_CREDENTIALS_NS:-fabrik-system}"
DRY_RUN=""

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kubeconfig=*) KUBE="${1#--kubeconfig=}"; shift ;;
    --kubeconfig)   KUBE="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --secret)       SECRET_NAME="$2"; shift 2 ;;
    --namespace)    SECRET_NS="$2"; shift 2 ;;
    *)              echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$KUBE" ]]; then
  echo "error: KUBECONFIG not set" >&2
  echo "usage: KUBECONFIG=~/.kube/hoth $0" >&2
  echo "       $0 --kubeconfig ~/.kube/hoth" >&2
  exit 1
fi

if ! command -v kubectl &>/dev/null; then
  echo "error: kubectl not found" >&2
  exit 1
fi

if [[ ! -d "$CODEX_DIR" ]]; then
  echo "error: codex dir not found at $CODEX_DIR" >&2
  exit 1
fi

# Collect named pool files (exclude auth.json — that's the active slot)
AUTH_FILES=()
for f in "$CODEX_DIR"/*.auth.json; do
  [[ -f "$f" ]] || continue
  AUTH_FILES+=("$f")
done

if [[ ${#AUTH_FILES[@]} -eq 0 ]]; then
  echo "error: no *.auth.json files found in $CODEX_DIR" >&2
  echo "hint:  run 'codex auth login' then copy to ~/.codex/<name>.auth.json" >&2
  exit 1
fi

echo "Updating ${SECRET_NS}/${SECRET_NAME} with ${#AUTH_FILES[@]} auth files:"
FROM_FILE_ARGS=()
for f in "${AUTH_FILES[@]}"; do
  name="$(basename "$f")"
  echo "  + $name"
  FROM_FILE_ARGS+=(--from-file="${name}=${f}")
done

CLUSTER_CTX="$(KUBECONFIG="$KUBE" kubectl config current-context 2>/dev/null || echo "unknown")"
echo ""
echo "Cluster: $CLUSTER_CTX"
echo "Secret:  ${SECRET_NS}/${SECRET_NAME}"
echo ""

if [[ -n "$DRY_RUN" ]]; then
  echo "[dry-run] would apply:"
  KUBECONFIG="$KUBE" kubectl create secret generic "$SECRET_NAME" \
    -n "$SECRET_NS" \
    "${FROM_FILE_ARGS[@]}" \
    --dry-run=client -o yaml | head -20
  echo "  ..."
  echo "[dry-run] no changes applied"
  exit 0
fi

KUBECONFIG="$KUBE" kubectl create secret generic "$SECRET_NAME" \
  -n "$SECRET_NS" \
  "${FROM_FILE_ARGS[@]}" \
  --dry-run=client -o yaml | \
  KUBECONFIG="$KUBE" kubectl apply -f -

echo ""
echo "✅ Secret updated. New pods will pick up the refreshed credentials."
