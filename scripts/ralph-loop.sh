#!/usr/bin/env bash
#
# Ralph Loop - runs an agent in a continuous loop until DONE or BLOCKED
# Usage: ./ralph-loop.sh [prompt-file] [state-dir]
#
# Examples:
#   ./ralph-loop.sh                           # Uses ./PROMPT.md, ./state/
#   ./ralph-loop.sh ~/tasks/auth/PROMPT.md    # Custom prompt file
#   ./ralph-loop.sh ./PROMPT.md ./my-state    # Custom state directory
#
# Environment variables:
#   MAX_ITERATIONS  - Max loops before stopping (default: 100)
#   RALPH_STATE_DIR - Default state directory (default: ./state)
#   RALPH_AGENT     - Which agent to use: claude, codex, opencode (default: claude)
#
set -euo pipefail

PROMPT_FILE="${1:-./PROMPT.md}"
STATE_DIR="${2:-${RALPH_STATE_DIR:-./state}}"
MAX_ITERATIONS="${MAX_ITERATIONS:-100}"
RALPH_AGENT="${RALPH_AGENT:-claude}"
TOKEN_ENV_FILE="${HOME}/.config/ralph/ralph.env"

if [[ -f "$TOKEN_ENV_FILE" ]]; then
  # Make token available for non-interactive runs.
  set -a
  # shellcheck disable=SC1090
  source "$TOKEN_ENV_FILE"
  set +a
fi

# Configure git to use GITHUB_TOKEN for GitHub HTTPS URLs
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  git config --global url."https://oauth:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

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

mkdir -p "$STATE_DIR"

# State files
ITERATION_FILE="$STATE_DIR/iteration"
STATUS_FILE="$STATE_DIR/status"
OUTPUT_FILE="$STATE_DIR/last-output.txt"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Initialize or continue iteration count
if [[ -f "$ITERATION_FILE" ]]; then
  ITERATION=$(cat "$ITERATION_FILE")
else
  ITERATION=0
  echo "0" > "$ITERATION_FILE"
fi

log "=== Ralph Loop Starting ==="
log "Agent:  $RALPH_AGENT ($AGENT_CMD)"
log "Prompt: $PROMPT_FILE"
log "State:  $STATE_DIR"
log "Starting at iteration: $ITERATION"

# Check prompt exists
if [[ ! -f "$PROMPT_FILE" ]]; then
  log "Error: Prompt file not found: $PROMPT_FILE"
  exit 1
fi

# Main loop
while [[ $ITERATION -lt $MAX_ITERATIONS ]]; do
  ITERATION=$((ITERATION + 1))
  echo "$ITERATION" > "$ITERATION_FILE"

  log ""
  log "=========================================="
  log "Iteration $ITERATION / $MAX_ITERATIONS"
  log "=========================================="

  # Run agent with the prompt
  set +e
  cat "$PROMPT_FILE" | $AGENT_CMD 2>&1 | tee "$OUTPUT_FILE"
  EXIT_CODE=${PIPESTATUS[1]}
  set -e

  if [[ $EXIT_CODE -ne 0 ]]; then
    log "Agent exited with code $EXIT_CODE"
    echo "ERROR" > "$STATUS_FILE"
    sleep 5
    continue
  fi

  # Check for status signals in output (look at last 50 lines)
  if grep -q '"status":\s*"DONE"' "$OUTPUT_FILE" 2>/dev/null; then
    log "Status: DONE - task complete!"
    echo "DONE" > "$STATUS_FILE"
    exit 0
  fi

  if grep -q '"status":\s*"BLOCKED"' "$OUTPUT_FILE" 2>/dev/null; then
    log "Status: BLOCKED - needs human input"
    echo "BLOCKED" > "$STATUS_FILE"
    # Wait for prompt file to be updated, or timeout after 60s
    if command -v inotifywait &>/dev/null; then
      log "Waiting for prompt update (inotifywait)..."
      inotifywait -e modify -t 60 "$PROMPT_FILE" 2>/dev/null || true
    else
      log "Waiting 30s for prompt update..."
      sleep 30
    fi
    continue
  fi

  if grep -q '"status":\s*"NEEDS_INPUT"' "$OUTPUT_FILE" 2>/dev/null; then
    log "Status: NEEDS_INPUT - waiting for human response"
    echo "NEEDS_INPUT" > "$STATUS_FILE"
    if command -v inotifywait &>/dev/null; then
      log "Waiting for prompt update (inotifywait)..."
      inotifywait -e modify -t 60 "$PROMPT_FILE" 2>/dev/null || true
    else
      log "Waiting 30s for prompt update..."
      sleep 30
    fi
    continue
  fi

  # No terminal status found, continue looping
  log "Status: CONTINUE"
  echo "CONTINUE" > "$STATUS_FILE"
  sleep 2
done

log "Max iterations ($MAX_ITERATIONS) reached"
echo "MAX_ITERATIONS" > "$STATUS_FILE"
exit 1
