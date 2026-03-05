#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  scripts/k3d/cluster.sh create <single|multi> [name]
  scripts/k3d/cluster.sh verify <single|multi> [name]
  scripts/k3d/cluster.sh delete [name]

Options (env vars):
  K3D_REGISTRY_PORT   Registry port for k3d (default: 5111)

Notes:
  - Cluster context is assumed to be k3d-<name> when verifying.
  - Multi-node = 1 server + 2 agents.
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[k3d] missing required command: $1" >&2
    exit 1
  fi
}

action="${1:-}"
shape="${2:-}"
name="${3:-dev}"

case "$action" in
  create)
    require_cmd k3d
    require_cmd kubectl

    case "$shape" in
      single)
        agents=0
        port_args=()
        ;;
      multi)
        agents=2
        port_args=("-p" "8080:80@loadbalancer")
        ;;
      *)
        echo "[k3d] expected shape: single or multi" >&2
        usage
        exit 1
        ;;
    esac

    registry_port="${K3D_REGISTRY_PORT:-5111}"
    registry_name="${name}-registry"
    registry_ref="${registry_name}:0.0.0.0:${registry_port}"

    echo "[k3d] creating cluster '$name' ($shape)"
    echo "[k3d] registry: $registry_ref"

    k3d cluster create "$name" \
      --agents "$agents" \
      --registry-create "$registry_ref" \
      "${port_args[@]}"

    echo "[k3d] done"
    ;;

  verify)
    require_cmd kubectl

    case "$shape" in
      single) expected=1 ;;
      multi) expected=3 ;;
      *)
        echo "[k3d] expected shape: single or multi" >&2
        usage
        exit 1
        ;;
    esac

    context="k3d-${name}"
    echo "[k3d] verifying cluster '$name' via context '$context'"

    if ! kubectl --context "$context" get nodes >/dev/null 2>&1; then
      echo "[k3d] unable to reach cluster via context '$context'" >&2
      exit 1
    fi

    node_count="$(kubectl --context "$context" get nodes --no-headers | wc -l | tr -d ' ')"

    if [[ "$node_count" != "$expected" ]]; then
      echo "[k3d] expected $expected node(s), found $node_count" >&2
      exit 1
    fi

    echo "[k3d] ok: $node_count node(s) ready"
    ;;

  delete)
    require_cmd k3d

    echo "[k3d] deleting cluster '$name'"
    k3d cluster delete "$name"
    ;;

  *)
    usage
    exit 1
    ;;
esac
