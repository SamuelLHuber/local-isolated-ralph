#!/usr/bin/env bash
#
# Dispatch a task to a Ralph VM and run the loop
# Usage: ./dispatch.sh <vm-name> <prompt-file> [project-dir]
#
# Examples:
#   ./dispatch.sh ralph-1 ~/tasks/feature-a/PROMPT.md
#   ./dispatch.sh ralph-2 ~/tasks/feature-b/PROMPT.md ~/projects/my-app

set -euo pipefail

VM_NAME="${1:?Usage: $0 <vm-name> <prompt-file> [project-dir]}"
PROMPT_FILE="${2:?Usage: $0 <vm-name> <prompt-file> [project-dir]}"
PROJECT_DIR="${3:-}"

PROMPT_FILE=$(realpath "$PROMPT_FILE")

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Error: Prompt file not found: $PROMPT_FILE"
  exit 1
fi

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)
    echo "Unsupported OS"
    exit 1
    ;;
esac

echo "[$VM_NAME] Dispatching task from: $PROMPT_FILE"

if [[ "$OS" == "macos" ]]; then
  if ! limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -q "^$VM_NAME Running"; then
    echo "[$VM_NAME] Starting VM..."
    limactl start "$VM_NAME"
  fi

  VM_WORK_DIR="/home/ralph/work/${VM_NAME}"
  limactl shell "$VM_NAME" sudo -u ralph mkdir -p "$VM_WORK_DIR"

  cat "$PROMPT_FILE" | limactl shell "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/PROMPT.md" > /dev/null

  if [[ -n "$PROJECT_DIR" ]]; then
    echo "[$VM_NAME] Syncing project directory..."
    tar -C "$PROJECT_DIR" -cf - . | limactl shell "$VM_NAME" sudo -u ralph tar -C "${VM_WORK_DIR}/project" -xf -
    VM_PROJECT_DIR="${VM_WORK_DIR}/project"
  else
    VM_PROJECT_DIR="$VM_WORK_DIR"
  fi

  echo "[$VM_NAME] Starting Ralph loop..."
  limactl shell "$VM_NAME" sudo -u ralph -i bash -c "
    cd '$VM_PROJECT_DIR'
    echo '[$VM_NAME] Working in: \$(pwd)'
    echo '[$VM_NAME] Starting loop...'
    export PATH=\"\$HOME/.bun/bin:\$PATH\"
    while :; do
      cat '${VM_WORK_DIR}/PROMPT.md' | claude --dangerously-skip-permissions 2>&1
      EXIT_CODE=\$?
      if [[ \$EXIT_CODE -ne 0 ]]; then
        echo '[$VM_NAME] Claude exited with code \$EXIT_CODE'
      fi
      sleep 1
    done
  "

else
  VM_IP=$(virsh domifaddr "$VM_NAME" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)

  if [[ -z "$VM_IP" ]]; then
    echo "[$VM_NAME] VM not running or no IP. Starting..."
    virsh start "$VM_NAME" 2>/dev/null || true
    sleep 10
    VM_IP=$(virsh domifaddr "$VM_NAME" | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
  fi

  if [[ -z "$VM_IP" ]]; then
    echo "[$VM_NAME] Error: Could not get VM IP"
    exit 1
  fi

  echo "[$VM_NAME] VM IP: $VM_IP"

  VM_WORK_DIR="/home/ralph/work/${VM_NAME}"
  ssh "ralph@${VM_IP}" "mkdir -p '$VM_WORK_DIR'"
  scp "$PROMPT_FILE" "ralph@${VM_IP}:${VM_WORK_DIR}/PROMPT.md"

  if [[ -n "$PROJECT_DIR" ]]; then
    echo "[$VM_NAME] Syncing project directory..."
    rsync -az --delete "$PROJECT_DIR/" "ralph@${VM_IP}:${VM_WORK_DIR}/project/"
    VM_PROJECT_DIR="${VM_WORK_DIR}/project"
  else
    VM_PROJECT_DIR="$VM_WORK_DIR"
  fi

  echo "[$VM_NAME] Starting Ralph loop..."
  ssh "ralph@${VM_IP}" bash -c "'
    cd \"$VM_PROJECT_DIR\"
    echo \"[$VM_NAME] Working in: \$(pwd)\"
    echo \"[$VM_NAME] Starting loop...\"
    export PATH=\"\$HOME/.bun/bin:\$PATH\"
    while :; do
      cat \"${VM_WORK_DIR}/PROMPT.md\" | claude --dangerously-skip-permissions 2>&1
      EXIT_CODE=\$?
      if [[ \$EXIT_CODE -ne 0 ]]; then
        echo \"[$VM_NAME] Claude exited with code \$EXIT_CODE\"
      fi
      sleep 1
    done
  '"
fi
