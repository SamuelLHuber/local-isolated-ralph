#!/usr/bin/env bash
#
# Start a Ralph loop in a visible tmux session
# Usage: ./ralph-start.sh <vm-name> <prompt-file> [project-dir]
#
# Environment variables:
#   RALPH_AGENT - Which agent to use: claude, codex, opencode (default: claude)
#
set -euo pipefail

VM_NAME="${1:?Usage: $0 <vm-name> <prompt-file> [project-dir]}"
PROMPT_FILE="${2:?Usage: $0 <vm-name> <prompt-file> [project-dir]}"
PROJECT_DIR="${3:-$(dirname "$PROMPT_FILE")}"
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

PROMPT_FILE=$(realpath "$PROMPT_FILE")
PROJECT_DIR=$(realpath "$PROJECT_DIR")

case "$(uname -s)" in
  Darwin)
    SSH_CMD="limactl shell $VM_NAME sudo -u ralph -i --"
    ;;
  Linux)
    VM_IP=$(virsh domifaddr "$VM_NAME" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
    SSH_CMD="ssh ralph@$VM_IP"
    ;;
esac

echo "[$VM_NAME] Starting Ralph..."
echo "[$VM_NAME] Agent: $RALPH_AGENT"
echo "[$VM_NAME] Project: $PROJECT_DIR"
echo "[$VM_NAME] Prompt: $PROMPT_FILE"

tmux new-session -d -s "$VM_NAME" "
  echo 'Connecting to $VM_NAME...'
  $SSH_CMD bash -c '
    cd \"$PROJECT_DIR\"
    echo \"Working in: \$(pwd)\"
    echo \"Agent: $RALPH_AGENT\"
    echo \"Starting Ralph loop...\"
    echo \"\"
    export PATH=\"\$HOME/.bun/bin:\$PATH\"
    while true; do
      cat \"$PROMPT_FILE\" | $AGENT_CMD
      echo \"\"
      echo \"--- Iteration complete, continuing in 2s (Ctrl+C to stop) ---\"
      echo \"\"
      sleep 2
    done
  '
  echo 'Ralph stopped. Press enter to close.'
  read
"

echo ""
echo "[$VM_NAME] Ralph started in tmux session"
echo ""
echo "  View:    tmux attach -t $VM_NAME"
echo "  Detach:  Ctrl+B, then D"
echo "  Stop:    tmux kill-session -t $VM_NAME"
echo ""
