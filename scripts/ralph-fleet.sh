#!/usr/bin/env bash
#
# Start multiple Ralphs and view them in tmux
# Usage: ./ralph-fleet.sh <tasks-dir>
#
# Expects tasks-dir structure:
#   tasks/
#     ralph-1/
#       PROMPT.md
#       (project files)
#     ralph-2/
#       PROMPT.md
#     ...
#
# Environment variables:
#   RALPH_AGENT - Which agent to use: claude, codex, opencode (default: claude)
#
set -euo pipefail

TASKS_DIR="${1:?Usage: $0 <tasks-dir>}"
TASKS_DIR=$(realpath "$TASKS_DIR")
RALPH_AGENT="${RALPH_AGENT:-claude}"

# Set the agent command based on RALPH_AGENT
case "$RALPH_AGENT" in
  claude)
    AGENT_CMD="claude --dangerously-skip-permissions"
    ;;
  codex)
    AGENT_CMD="codex exec --dangerously-bypass-approvals-and-sandbox"
    ;;
  opencode)
    AGENT_CMD="opencode"
    ;;
  *)
    echo "Error: Unknown agent '$RALPH_AGENT'. Use: claude, codex, or opencode"
    exit 1
    ;;
esac

TASKS=()
for dir in "$TASKS_DIR"/*/; do
  if [[ -f "${dir}PROMPT.md" ]]; then
    TASKS+=("$dir")
  fi
done

if [[ ${#TASKS[@]} -eq 0 ]]; then
  echo "No tasks found. Expected structure:"
  echo "  $TASKS_DIR/"
  echo "    task-1/"
  echo "      PROMPT.md"
  echo "    task-2/"
  echo "      PROMPT.md"
  exit 1
fi

echo "Found ${#TASKS[@]} tasks:"
for task in "${TASKS[@]}"; do
  echo "  - $(basename "$task")"
done
echo ""

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
esac

if [[ "$OS" == "macos" ]]; then
  VMS=($(limactl list --format '{{.Name}}' 2>/dev/null | grep -E '^ralph' || true))
else
  VMS=($(virsh list --all --name 2>/dev/null | grep -E '^ralph' || true))
fi

if [[ ${#VMS[@]} -eq 0 ]]; then
  echo "No Ralph VMs found. Create them first:"
  echo "  for i in 1 2 3 4; do ./scripts/create-ralph.sh ralph-\$i; done"
  exit 1
fi

echo "Available VMs: ${VMS[*]}"
echo ""

FLEET_SESSION="ralph-fleet"
tmux kill-session -t "$FLEET_SESSION" 2>/dev/null || true
tmux new-session -d -s "$FLEET_SESSION"

for i in "${!TASKS[@]}"; do
  if [[ $i -ge ${#VMS[@]} ]]; then
    echo "Warning: More tasks than VMs. Skipping: ${TASKS[$i]}"
    continue
  fi

  VM="${VMS[$i]}"
  TASK_DIR="${TASKS[$i]}"
  TASK_NAME=$(basename "$TASK_DIR")
  PROMPT_FILE="${TASK_DIR}PROMPT.md"

  echo "Assigning $TASK_NAME -> $VM"

  if [[ "$OS" == "macos" ]]; then
    SSH_CMD="limactl shell $VM sudo -u ralph -i --"
  else
    VM_IP=$(virsh domifaddr "$VM" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
    SSH_CMD="ssh ralph@$VM_IP"
  fi

  if [[ $i -eq 0 ]]; then
    tmux rename-window -t "$FLEET_SESSION" "$VM"
  else
    tmux new-window -t "$FLEET_SESSION" -n "$VM"
  fi

  tmux send-keys -t "$FLEET_SESSION:$VM" "
echo '=== $VM: $TASK_NAME (agent: $RALPH_AGENT) ==='
$SSH_CMD bash -c '
  cd \"$TASK_DIR\"
  export PATH=\"\$HOME/.bun/bin:\$PATH\"
  while true; do
    cat PROMPT.md | $AGENT_CMD
    echo \"\"
    echo \"--- Iteration complete ---\"
    sleep 2
  done
'
" Enter

done

echo ""
echo "=========================================="
echo "Fleet started in tmux session: $FLEET_SESSION"
echo "=========================================="
echo ""
echo "Commands:"
echo "  Attach:           tmux attach -t $FLEET_SESSION"
echo "  Switch window:    Ctrl+B, then 0-9 or N/P"
echo "  Detach:           Ctrl+B, then D"
echo "  Kill all:         tmux kill-session -t $FLEET_SESSION"
echo ""
echo "Or open in new terminal tabs:"
for i in "${!TASKS[@]}"; do
  if [[ $i -lt ${#VMS[@]} ]]; then
    echo "  tmux attach -t $FLEET_SESSION:${VMS[$i]}"
  fi
done
