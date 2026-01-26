#!/usr/bin/env bash
#
# Dispatch a task to a Ralph VM and run the loop
# Usage: ./dispatch.sh <vm-name> <prompt-file> [project-dir] [max-iterations]
#
# Examples:
#   ./dispatch.sh ralph-1 ~/tasks/feature-a/PROMPT.md
#   ./dispatch.sh ralph-2 ~/tasks/feature-b/PROMPT.md ~/projects/my-app
#   ./dispatch.sh ralph-3 ~/tasks/feature-c/PROMPT.md ~/projects/app 20
#
# Environment variables:
#   MAX_ITERATIONS - Max loops before stopping (default: 100, 0 = unlimited)
#   RALPH_AGENT    - Which agent to use: claude, codex, opencode (default: claude)

set -euo pipefail

VM_NAME="${1:?Usage: $0 <vm-name> <prompt-file> [project-dir] [max-iterations]}"
PROMPT_FILE="${2:?Usage: $0 <vm-name> <prompt-file> [project-dir] [max-iterations]}"
PROJECT_DIR="${3:-}"
MAX_ITERATIONS="${4:-${MAX_ITERATIONS:-100}}"
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
echo "[$VM_NAME] Agent: $RALPH_AGENT ($AGENT_CMD)"

if [[ "$OS" == "macos" ]]; then
  if ! limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -q "^$VM_NAME Running"; then
    echo "[$VM_NAME] Starting VM..."
    limactl start "$VM_NAME"
  fi

  VM_WORK_DIR="/home/ralph/work/${VM_NAME}"
  limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph mkdir -p "$VM_WORK_DIR" "$VM_WORK_DIR/project"

  cat "$PROMPT_FILE" | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/PROMPT.md" > /dev/null

  if [[ -n "$PROJECT_DIR" ]]; then
    echo "[$VM_NAME] Syncing project directory..."
    tar -C "$PROJECT_DIR" --no-xattrs --exclude='node_modules' --exclude='.git' -cf - . | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tar -C "${VM_WORK_DIR}/project" -xf -
    VM_PROJECT_DIR="${VM_WORK_DIR}/project"

    # Install dependencies if package.json exists
    if [[ -f "$PROJECT_DIR/package.json" ]]; then
      echo "[$VM_NAME] Installing dependencies (bun install)..."
      limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph bash -c "cd '${VM_PROJECT_DIR}' && export PATH=\"\$HOME/.bun/bin:\$PATH\" && bun install" 2>&1 | tail -5
    fi
  else
    VM_PROJECT_DIR="$VM_WORK_DIR"
  fi

  echo "[$VM_NAME] Starting Ralph loop (max iterations: $MAX_ITERATIONS)..."
  limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph bash <<EOF
    cd "${VM_PROJECT_DIR}"
    echo "[$VM_NAME] Working in: \$(pwd)"
    echo "[$VM_NAME] Starting loop..."
    export PATH="\$HOME/.bun/bin:\$PATH"
    export MAX_ITERATIONS=${MAX_ITERATIONS}
    export RALPH_AGENT=${RALPH_AGENT}

    # Use ralph-loop.sh if available, otherwise inline loop
    if [[ -x ~/ralph/loop.sh ]]; then
      ~/ralph/loop.sh "${VM_WORK_DIR}/PROMPT.md"
    else
      ITERATION=0
      while [[ ${MAX_ITERATIONS} -eq 0 ]] || [[ \$ITERATION -lt ${MAX_ITERATIONS} ]]; do
        ITERATION=\$((ITERATION + 1))
        echo ""
        echo "=== Iteration \$ITERATION / ${MAX_ITERATIONS} ==="
        cat "${VM_WORK_DIR}/PROMPT.md" | ${AGENT_CMD} 2>&1 | tee /tmp/ralph-output.txt
        EXIT_CODE=\${PIPESTATUS[1]}
        if [[ \$EXIT_CODE -ne 0 ]]; then
          echo "[$VM_NAME] Agent exited with code \$EXIT_CODE"
        fi
        # Check for DONE status
        if grep -q '"status":[[:space:]]*"DONE"' /tmp/ralph-output.txt 2>/dev/null; then
          echo "[$VM_NAME] Status: DONE - task complete!"
          exit 0
        fi
        # Check for BLOCKED status
        if grep -q '"status":[[:space:]]*"BLOCKED"' /tmp/ralph-output.txt 2>/dev/null; then
          echo "[$VM_NAME] Status: BLOCKED - needs human input"
          exit 0
        fi
        sleep 1
      done
      echo "[$VM_NAME] Max iterations (${MAX_ITERATIONS}) reached"
    fi
EOF

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
    rsync -az --delete --exclude='node_modules' --exclude='.git' "$PROJECT_DIR/" "ralph@${VM_IP}:${VM_WORK_DIR}/project/"
    VM_PROJECT_DIR="${VM_WORK_DIR}/project"

    # Install dependencies if package.json exists
    if [[ -f "$PROJECT_DIR/package.json" ]]; then
      echo "[$VM_NAME] Installing dependencies (bun install)..."
      ssh "ralph@${VM_IP}" "cd '${VM_PROJECT_DIR}' && export PATH=\"\$HOME/.bun/bin:\$PATH\" && bun install" 2>&1 | tail -5
    fi
  else
    VM_PROJECT_DIR="$VM_WORK_DIR"
  fi

  echo "[$VM_NAME] Starting Ralph loop (max iterations: $MAX_ITERATIONS)..."
  ssh "ralph@${VM_IP}" bash -c "'
    cd \"$VM_PROJECT_DIR\"
    echo \"[$VM_NAME] Working in: \$(pwd)\"
    echo \"[$VM_NAME] Starting loop...\"
    export PATH=\"\$HOME/.bun/bin:\$PATH\"
    export MAX_ITERATIONS=$MAX_ITERATIONS

    # Use ralph-loop.sh if available, otherwise inline loop
    if [[ -x ~/ralph/loop.sh ]]; then
      ~/ralph/loop.sh \"${VM_WORK_DIR}/PROMPT.md\"
    else
      ITERATION=0
      while [[ $MAX_ITERATIONS -eq 0 ]] || [[ \$ITERATION -lt $MAX_ITERATIONS ]]; do
        ITERATION=\$((ITERATION + 1))
        echo \"\"
        echo \"=== Iteration \$ITERATION / $MAX_ITERATIONS ===\"
        cat \"${VM_WORK_DIR}/PROMPT.md\" | $AGENT_CMD 2>&1 | tee /tmp/ralph-output.txt
        EXIT_CODE=\${PIPESTATUS[1]}
        if [[ \$EXIT_CODE -ne 0 ]]; then
          echo \"[$VM_NAME] Agent exited with code \$EXIT_CODE\"
        fi
        # Check for DONE status
        if grep -q \"\\\"status\\\":[[:space:]]*\\\"DONE\\\"\" /tmp/ralph-output.txt 2>/dev/null; then
          echo \"[$VM_NAME] Status: DONE - task complete!\"
          exit 0
        fi
        # Check for BLOCKED status
        if grep -q \"\\\"status\\\":[[:space:]]*\\\"BLOCKED\\\"\" /tmp/ralph-output.txt 2>/dev/null; then
          echo \"[$VM_NAME] Status: BLOCKED - needs human input\"
          exit 0
        fi
        sleep 1
      done
      echo \"[$VM_NAME] Max iterations ($MAX_ITERATIONS) reached\"
    fi
  '"
fi
