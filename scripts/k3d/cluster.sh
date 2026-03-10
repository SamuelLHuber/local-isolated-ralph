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
  K3D_REGISTRY_PORT   Registry port for k3d (default: 5111 for single, 5112 for multi)
  K3D_WAIT_TIMEOUT    Timeout used for node readiness checks (default: 120s)

Notes:
  - Verification reads kubeconfig directly from k3d and does not require ~/.kube/config updates.
  - Multi-node = 1 server + 2 agents.
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[k3d] missing required command: $1" >&2
    exit 1
  fi
}

default_name() {
  local requested_shape="$1"

  case "$requested_shape" in
    single) echo "dev-single" ;;
    multi) echo "dev-multi" ;;
    *) echo "dev" ;;
  esac
}

default_registry_port() {
  local requested_shape="$1"

  case "$requested_shape" in
    single) echo "5111" ;;
    multi) echo "5112" ;;
    *) echo "5111" ;;
  esac
}

cluster_name() {
  local requested_shape="$1"
  local requested_name="${2:-}"

  if [[ -n "$requested_name" ]]; then
    echo "$requested_name"
    return
  fi

  default_name "$requested_shape"
}

with_cluster_kubeconfig() {
  local cluster_name="$1"
  shift

  local kubeconfig_file
  local status
  kubeconfig_file="$(mktemp "${TMPDIR:-/tmp}/fabrik-k3d-${cluster_name}-XXXXXX.kubeconfig")"

  k3d kubeconfig get "$cluster_name" >"$kubeconfig_file"
  if KUBECONFIG="$kubeconfig_file" "$@"; then
    status=0
  else
    status=$?
  fi
  rm -f "$kubeconfig_file"
  return "$status"
}

verify_registry() {
  local cluster_name="$1"
  local registry_name="${cluster_name}-registry"

  if ! k3d registry list | awk 'NR > 1 { print $1 }' | grep -qx "$registry_name"; then
    echo "[k3d] expected local registry '$registry_name' for cluster '$cluster_name'" >&2
    exit 1
  fi
}

verify_shape() {
  local shape="$1"
  local cluster_name="$2"
  local expected_nodes
  local expected_agents
  local timeout="${K3D_WAIT_TIMEOUT:-120s}"

  case "$shape" in
    single)
      expected_nodes=1
      expected_agents=0
      ;;
    multi)
      expected_nodes=3
      expected_agents=2
      ;;
    *)
      echo "[k3d] expected shape: single or multi" >&2
      usage
      exit 1
      ;;
  esac

  echo "[k3d] verifying cluster '$cluster_name' ($shape)"

  verify_registry "$cluster_name"

  if ! with_cluster_kubeconfig "$cluster_name" kubectl get nodes >/dev/null 2>&1; then
    echo "[k3d] unable to reach cluster '$cluster_name'" >&2
    exit 1
  fi

  with_cluster_kubeconfig "$cluster_name" kubectl wait --for=condition=Ready nodes --all "--timeout=${timeout}" >/dev/null

  local nodes
  nodes="$(with_cluster_kubeconfig "$cluster_name" kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"

  local node_count
  local server_count
  local agent_count
  node_count="$(printf '%s\n' "$nodes" | sed '/^$/d' | wc -l | tr -d ' ')"
  server_count="$(printf '%s\n' "$nodes" | grep -c -- '-server-' || true)"
  agent_count="$(printf '%s\n' "$nodes" | grep -c -- '-agent-' || true)"

  if [[ "$node_count" != "$expected_nodes" ]]; then
    echo "[k3d] expected $expected_nodes node(s), found $node_count" >&2
    exit 1
  fi

  if [[ "$server_count" != "1" ]]; then
    echo "[k3d] expected 1 server node, found $server_count" >&2
    exit 1
  fi

  if [[ "$agent_count" != "$expected_agents" ]]; then
    echo "[k3d] expected $expected_agents agent node(s), found $agent_count" >&2
    exit 1
  fi

  echo "[k3d] ok: $node_count node(s) ready, registry '$cluster_name-registry' present"
}

action="${1:-}"
shape="${2:-}"
name=""

case "$action" in
  create|verify)
    name="$(cluster_name "$shape" "${3:-}")"
    ;;
  delete)
    name="${2:-dev}"
    ;;
esac

case "$action" in
  create)
    require_cmd k3d
    require_cmd kubectl

    case "$shape" in
      single)
        agents=0
        ;;
      multi)
        agents=2
        ;;
      *)
        echo "[k3d] expected shape: single or multi" >&2
        usage
        exit 1
        ;;
    esac

    registry_port="${K3D_REGISTRY_PORT:-$(default_registry_port "$shape")}"
    registry_name="${name}-registry"
    registry_ref="${registry_name}:0.0.0.0:${registry_port}"

    echo "[k3d] creating cluster '$name' ($shape)"
    echo "[k3d] registry: $registry_ref"

    create_args=(cluster create "$name" --agents "$agents" --registry-create "$registry_ref")

    if [[ "$shape" == "multi" ]]; then
      create_args+=("-p" "8080:80@loadbalancer")
    fi

    k3d "${create_args[@]}"

    verify_shape "$shape" "$name"
    echo "[k3d] done: cluster '$name' is ready"
    ;;

  verify)
    require_cmd k3d
    require_cmd kubectl
    verify_shape "$shape" "$name"
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
