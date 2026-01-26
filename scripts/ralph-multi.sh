#!/usr/bin/env bash
#
# Run multiple Ralphs in ONE VM using tmux panes
# Usage: ./ralph-multi.sh <vm-name> <task-dir-1> <task-dir-2> [task-dir-3] [task-dir-4]
#
# Each task-dir should contain a PROMPT.md and be completely independent
#
# Environment variables:
#   RALPH_AGENT - Which agent to use: claude, codex, opencode (default: claude)
#
set -euo pipefail

VM_NAME="${1:?Usage: $0 <vm-name> <task-dir-1> <task-dir-2> ...}"
shift
TASK_DIRS=("$@")
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

if [[ ${#TASK_DIRS[@]} -lt 1 ]]; then
  echo "Need at least one task directory"
  exit 1
fi

if [[ ${#TASK_DIRS[@]} -gt 4 ]]; then
  echo "Warning: More than 4 Ralphs per VM may cause resource contention"
fi

case "$(uname -s)" in
  Darwin)
    SSH_CMD="limactl shell $VM_NAME sudo -u ralph -i --"
    ;;
  Linux)
    VM_IP=$(virsh domifaddr "$VM_NAME" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
    SSH_CMD="ssh -t ralph@$VM_IP"
    ;;
esac

echo "Starting ${#TASK_DIRS[@]} Ralphs in VM: $VM_NAME (agent: $RALPH_AGENT)"

TMUX_SETUP="tmux new-session -d -s ralphs"

for i in "${!TASK_DIRS[@]}"; do
  TASK_DIR=$(realpath "${TASK_DIRS[$i]}")
  TASK_NAME=$(basename "$TASK_DIR")

  if [[ $i -eq 0 ]]; then
    TMUX_SETUP="$TMUX_SETUP -n '$TASK_NAME' 'export PATH=\"\$HOME/.bun/bin:\$PATH\" && cd $TASK_DIR && while true; do cat PROMPT.md | $AGENT_CMD; sleep 2; done'"
  else
    TMUX_SETUP="$TMUX_SETUP \\; split-window 'export PATH=\"\$HOME/.bun/bin:\$PATH\" && cd $TASK_DIR && while true; do cat PROMPT.md | $AGENT_CMD; sleep 2; done'"
  fi
done

TMUX_SETUP="$TMUX_SETUP \\; select-layout tiled"

echo "Connecting to VM and starting tmux session..."
$SSH_CMD bash -c "$TMUX_SETUP"

echo ""
echo "=========================================="
echo "${#TASK_DIRS[@]} Ralphs running in $VM_NAME"
echo "=========================================="
echo ""
echo "To view:"
echo "  $SSH_CMD -t tmux attach -t ralphs"
echo ""
echo "Pane navigation (inside tmux):"
echo "  Ctrl+B, arrow keys  - switch panes"
echo "  Ctrl+B, z           - zoom current pane"
echo "  Ctrl+B, d           - detach"
echo ""
