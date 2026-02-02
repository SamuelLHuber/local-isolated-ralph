#!/usr/bin/env bash
#
# Dispatch a task to a Ralph VM and run the Smithers workflow
# Usage: ./dispatch.sh [options] <vm-name> <spec-file> [project-dir] [max-iterations]
#
# Options:
#   --include-git    Include .git directory in sync (enables commit/push from VM)
#   --spec <path>    Spec JSON (minified recommended) for Smithers mode
#   --todo <path>    TODO JSON (minified recommended) for Smithers mode
#   --workflow <path> Smithers workflow script (default: scripts/smithers-spec-runner.tsx)
#   --report-dir <path> Report output directory inside VM (default: <workdir>/reports)
#   --model <name>   Model name for Smithers agent
#   --prompt <path>  Global PROMPT.md prepended to task prompt
#   --review-prompt <path> Reviewer PROMPT.md prepended to review prompt
#   --review-max <n> Max review reruns before human gate (default: 2)
#   --review-models <path> JSON map of reviewer_id -> model (optional)
#
# Examples:
#   ./dispatch.sh --spec specs/010-weekly-summary.min.json ralph-1 specs/010-weekly-summary.min.json
#   ./dispatch.sh --spec specs/010-weekly-summary.min.json ralph-2 specs/010-weekly-summary.min.json ~/projects/my-app
#
# Environment variables:
#   MAX_ITERATIONS - Max loops before stopping (default: 100, 0 = unlimited)
#   RALPH_AGENT    - Which agent to use: claude, codex, opencode (default: claude)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse options
INCLUDE_GIT=false
RESUME=false
SMITHERS_SPEC_PATH=""
SMITHERS_TODO_PATH=""
SMITHERS_WORKFLOW=""
SMITHERS_REPORT_DIR=""
SMITHERS_MODEL=""
SMITHERS_PROMPT_PATH=""
SMITHERS_REVIEW_PROMPT_PATH=""
SMITHERS_REVIEWERS_DIR_SRC=""
SMITHERS_REVIEW_MAX=""
SMITHERS_REVIEW_MODELS_FILE=""
while [[ $# -gt 0 && "$1" == --* ]]; do
  case "$1" in
    --include-git)
      INCLUDE_GIT=true
      shift
      ;;
    --spec)
      SMITHERS_SPEC_PATH="${2:-}"
      shift 2
      ;;
    --todo)
      SMITHERS_TODO_PATH="${2:-}"
      shift 2
      ;;
    --workflow)
      SMITHERS_WORKFLOW="${2:-}"
      shift 2
      ;;
    --report-dir)
      SMITHERS_REPORT_DIR="${2:-}"
      shift 2
      ;;
    --model)
      SMITHERS_MODEL="${2:-}"
      shift 2
      ;;
    --prompt)
      SMITHERS_PROMPT_PATH="${2:-}"
      shift 2
      ;;
    --review-prompt)
      SMITHERS_REVIEW_PROMPT_PATH="${2:-}"
      shift 2
      ;;
    --review-max)
      SMITHERS_REVIEW_MAX="${2:-}"
      shift 2
      ;;
    --review-models)
      SMITHERS_REVIEW_MODELS_FILE="${2:-}"
      shift 2
      ;;
    --resume)
      RESUME=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

VM_NAME="${1:?Usage: $0 [--include-git] <vm-name> <spec-file> [project-dir] [max-iterations]}"
PROMPT_FILE="${2:?Usage: $0 [--include-git] <vm-name> <spec-file> [project-dir] [max-iterations]}"
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

if [[ -z "$SMITHERS_SPEC_PATH" ]]; then
  SMITHERS_SPEC_PATH="$PROMPT_FILE"
fi
if [[ -z "$SMITHERS_TODO_PATH" ]]; then
  if [[ "$SMITHERS_SPEC_PATH" == *.todo.min.json ]]; then
    SMITHERS_TODO_PATH="$SMITHERS_SPEC_PATH"
  else
    SMITHERS_TODO_PATH="${SMITHERS_SPEC_PATH%.min.json}.todo.min.json"
    if [[ "$SMITHERS_TODO_PATH" == "$SMITHERS_SPEC_PATH" ]]; then
      SMITHERS_TODO_PATH="${SMITHERS_SPEC_PATH%.json}.todo.json"
    fi
  fi
fi

SMITHERS_SPEC_PATH=$(realpath "$SMITHERS_SPEC_PATH")
SMITHERS_TODO_PATH=$(realpath "$SMITHERS_TODO_PATH")

if [[ ! -f "$SMITHERS_SPEC_PATH" ]]; then
  echo "Error: Spec file not found: $SMITHERS_SPEC_PATH"
  exit 1
fi
if [[ ! -f "$SMITHERS_TODO_PATH" ]]; then
  echo "Error: TODO file not found: $SMITHERS_TODO_PATH"
  exit 1
fi

if [[ -z "$SMITHERS_WORKFLOW" ]]; then
  SMITHERS_WORKFLOW="scripts/smithers-spec-runner.tsx"
fi
SMITHERS_WORKFLOW=$(realpath "$SMITHERS_WORKFLOW")
if [[ ! -f "$SMITHERS_WORKFLOW" ]]; then
  echo "Error: Smithers workflow not found: $SMITHERS_WORKFLOW"
  exit 1
fi

if [[ -z "$SMITHERS_PROMPT_PATH" && -f "$SCRIPT_DIR/../prompts/DEFAULT-IMPLEMENTER.md" ]]; then
  SMITHERS_PROMPT_PATH="$SCRIPT_DIR/../prompts/DEFAULT-IMPLEMENTER.md"
fi
if [[ -n "$SMITHERS_PROMPT_PATH" ]]; then
  SMITHERS_PROMPT_PATH=$(realpath "$SMITHERS_PROMPT_PATH")
  if [[ ! -f "$SMITHERS_PROMPT_PATH" ]]; then
    echo "Error: Prompt file not found: $SMITHERS_PROMPT_PATH"
    exit 1
  fi
fi

if [[ -z "$SMITHERS_REVIEW_PROMPT_PATH" && -f "$SCRIPT_DIR/../prompts/DEFAULT-REVIEWER.md" ]]; then
  SMITHERS_REVIEW_PROMPT_PATH="$SCRIPT_DIR/../prompts/DEFAULT-REVIEWER.md"
fi
if [[ -n "$SMITHERS_REVIEW_PROMPT_PATH" ]]; then
  SMITHERS_REVIEW_PROMPT_PATH=$(realpath "$SMITHERS_REVIEW_PROMPT_PATH")
  if [[ ! -f "$SMITHERS_REVIEW_PROMPT_PATH" ]]; then
    echo "Error: Review prompt file not found: $SMITHERS_REVIEW_PROMPT_PATH"
    exit 1
  fi
fi

if [[ -n "$SMITHERS_REVIEW_MODELS_FILE" ]]; then
  SMITHERS_REVIEW_MODELS_FILE=$(realpath "$SMITHERS_REVIEW_MODELS_FILE")
  if [[ ! -f "$SMITHERS_REVIEW_MODELS_FILE" ]]; then
    echo "Error: Review models file not found: $SMITHERS_REVIEW_MODELS_FILE"
    exit 1
  fi
fi

if [[ -d "$SCRIPT_DIR/../prompts/reviewers" ]]; then
  SMITHERS_REVIEWERS_DIR_SRC="$SCRIPT_DIR/../prompts/reviewers"
fi

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)
    echo "Unsupported OS"
    exit 1
    ;;
esac

# Generate unique work directory with timestamp
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
if [[ -n "$PROJECT_DIR" ]]; then
  PROJECT_BASENAME=$(basename "$PROJECT_DIR")
else
  PROJECT_BASENAME="task"
fi
WORK_SUBDIR="${PROJECT_BASENAME}-${TIMESTAMP}"

DB_DIR="$HOME/.cache/ralph"
DB_PATH="${RALPH_DB_PATH:-$DB_DIR/ralph.db}"
mkdir -p "$DB_DIR"

echo "[$VM_NAME] Dispatching spec: $SMITHERS_SPEC_PATH"
echo "[$VM_NAME] Agent: $RALPH_AGENT ($AGENT_CMD)"
echo "[$VM_NAME] Include .git: $INCLUDE_GIT"
echo "[$VM_NAME] Work dir: /home/ralph/work/${VM_NAME}/${WORK_SUBDIR}"
echo "[$VM_NAME] Orchestrator: Smithers"
echo "[$VM_NAME] Spec: $SMITHERS_SPEC_PATH"
echo "[$VM_NAME] TODO: $SMITHERS_TODO_PATH"
echo "[$VM_NAME] Workflow: $SMITHERS_WORKFLOW"

RUN_ID=$(
  python3 - "$DB_PATH" "$VM_NAME" "/home/ralph/work/${VM_NAME}/${WORK_SUBDIR}" "$SMITHERS_SPEC_PATH" "$SMITHERS_TODO_PATH" <<'PY'
import sqlite3
import sys
from datetime import datetime, timezone

db_path, vm, workdir, spec, todo = sys.argv[1:6]
conn = sqlite3.connect(db_path)
conn.execute("""
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_name TEXT NOT NULL,
  workdir TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  todo_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER
)
""")
conn.execute("CREATE INDEX IF NOT EXISTS runs_vm_started ON runs(vm_name, started_at)")
started_at = datetime.now(timezone.utc).isoformat()
cur = conn.execute(
  "INSERT INTO runs (vm_name, workdir, spec_path, todo_path, started_at, status) VALUES (?, ?, ?, ?, ?, ?)",
  (vm, workdir, spec, todo, started_at, "running")
)
conn.commit()
print(cur.lastrowid)
conn.close()
PY
)

if [[ "$OS" == "macos" ]]; then
  if ! limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -q "^$VM_NAME Running"; then
    echo "[$VM_NAME] Starting VM..."
    limactl start "$VM_NAME"
  fi

  VM_WORK_DIR="/home/ralph/work/${VM_NAME}/${WORK_SUBDIR}"
  limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph mkdir -p "$VM_WORK_DIR"

  cat "$PROMPT_FILE" | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/SPEC.md" > /dev/null
  limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph mkdir -p "${VM_WORK_DIR}/specs" "${VM_WORK_DIR}/reports"
  cat "$SMITHERS_SPEC_PATH" | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/specs/spec.min.json" > /dev/null
  cat "$SMITHERS_TODO_PATH" | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/specs/todo.min.json" > /dev/null
  cat "$SMITHERS_WORKFLOW" | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/smithers-workflow.tsx" > /dev/null
  if [[ -n "$SMITHERS_PROMPT_PATH" ]]; then
    cat "$SMITHERS_PROMPT_PATH" | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/PROMPT.md" > /dev/null
  fi
  if [[ -n "$SMITHERS_REVIEW_PROMPT_PATH" ]]; then
    cat "$SMITHERS_REVIEW_PROMPT_PATH" | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/REVIEW_PROMPT.md" > /dev/null
  fi
  if [[ -n "$SMITHERS_REVIEW_MODELS_FILE" ]]; then
    cat "$SMITHERS_REVIEW_MODELS_FILE" | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/reviewer-models.json" > /dev/null
  fi
  if [[ -n "$SMITHERS_REVIEWERS_DIR_SRC" ]]; then
    limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph mkdir -p "${VM_WORK_DIR}/reviewers"
    tar -C "$SMITHERS_REVIEWERS_DIR_SRC" -cf - . | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tar -C "${VM_WORK_DIR}/reviewers" -xf -
  fi

  # Record run context (prompts + hashes) for audit
  python3 - "$SMITHERS_SPEC_PATH" "$SMITHERS_TODO_PATH" "$SMITHERS_PROMPT_PATH" "$SMITHERS_REVIEW_PROMPT_PATH" "$SMITHERS_REVIEWERS_DIR_SRC" "$SMITHERS_REVIEW_MODELS_FILE" "$VM_NAME" "$RUN_ID" <<'PY' \
    | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tee "${VM_WORK_DIR}/reports/run-context.json" > /dev/null
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

def read_text(path: str) -> str:
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""

def sha256(path: str) -> str:
    if not path or not os.path.exists(path):
        return ""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()

spec_path, todo_path, prompt_path, review_prompt_path, reviewers_dir, review_models_path, vm, run_id = sys.argv[1:9]

reviewers = []
if reviewers_dir and os.path.isdir(reviewers_dir):
    for name in sorted(os.listdir(reviewers_dir)):
        if not name.lower().endswith(".md"):
            continue
        path = os.path.join(reviewers_dir, name)
        reviewers.append({
            "file": name,
            "path": path,
            "sha256": sha256(path)
        })
payload = {
    "v": 1,
    "run_id": int(run_id),
    "vm": vm,
    "created_at": datetime.now(timezone.utc).isoformat(),
    "spec_path": spec_path,
    "todo_path": todo_path,
    "prompt_path": prompt_path or None,
    "review_prompt_path": review_prompt_path or None,
    "spec_sha256": sha256(spec_path),
    "todo_sha256": sha256(todo_path),
    "prompt_sha256": sha256(prompt_path),
    "review_prompt_sha256": sha256(review_prompt_path),
    "review_models_path": review_models_path or None,
    "review_models_sha256": sha256(review_models_path),
    "prompt_text": read_text(prompt_path).strip(),
    "review_prompt_text": read_text(review_prompt_path).strip(),
    "review_models_text": read_text(review_models_path).strip(),
    "reviewers": reviewers
}
print(json.dumps(payload, indent=2))
PY

  if [[ -n "$PROJECT_DIR" ]]; then
    echo "[$VM_NAME] Syncing project directory..."

    # Build tar exclude options (exclude node_modules and macOS extended attribute files)
    TAR_EXCLUDES="--exclude='node_modules' --exclude='._*' --exclude='.DS_Store'"
    if [[ "$INCLUDE_GIT" == "false" ]]; then
      TAR_EXCLUDES="$TAR_EXCLUDES --exclude='.git'"
    fi

    COPYFILE_DISABLE=1 eval "tar -C '$PROJECT_DIR' --no-xattrs $TAR_EXCLUDES -cf - ." | limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph tar -C "${VM_WORK_DIR}" -xf -
    VM_PROJECT_DIR="${VM_WORK_DIR}"

    # If .git was included, verify git remote works and init jj
    if [[ "$INCLUDE_GIT" == "true" && -d "$PROJECT_DIR/.git" ]]; then
      echo "[$VM_NAME] Verifying git remote access and initializing jj..."
      limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph bash -c "
        cd '${VM_PROJECT_DIR}'

        # Source ralph.env for GITHUB_TOKEN
        if [[ -f ~/.config/ralph/ralph.env ]]; then
          set -a
          source ~/.config/ralph/ralph.env
          set +a
        fi

        # Configure git to use GITHUB_TOKEN for GitHub HTTPS URLs
        if [[ -n \"\${GITHUB_TOKEN:-}\" ]]; then
          git config --global url.\"https://oauth:\${GITHUB_TOKEN}@github.com/\".insteadOf \"https://github.com/\"
        fi

        # Show current remote (redact tokens)
        REMOTE_URL=\$(git remote get-url origin 2>/dev/null || echo 'none')
        REMOTE_URL_SAFE=\$(echo \"\$REMOTE_URL\" | sed -E 's|://[^:]+:[^@]+@|://***@|')
        echo '[$VM_NAME] Git remote: '\$REMOTE_URL_SAFE

        # Configure git user if not set
        git config user.email >/dev/null 2>&1 || git config user.email 'ralph@local'
        git config user.name >/dev/null 2>&1 || git config user.name 'Ralph Agent'

        # Test that we can fetch (verifies credentials work)
        if git ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
          echo '[$VM_NAME] Git remote access: OK'
        else
          echo '[$VM_NAME] WARNING: Cannot access git remote. Push may fail.'
          echo '[$VM_NAME] Ensure GITHUB_TOKEN is set in ~/.config/ralph/ralph.env'
        fi

        # Initialize jj (colocated) if needed
        if [[ ! -d .jj ]]; then
          jj git init >/dev/null 2>&1 || true
        fi
        echo '[$VM_NAME] JJ: '\$(jj status -s 2>/dev/null | head -1 || echo 'ready')
      "
    fi

    # Install dependencies if package.json exists
    if [[ -f "$PROJECT_DIR/package.json" ]]; then
      echo "[$VM_NAME] Installing dependencies (bun install)..."
      limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph bash -c "cd '${VM_PROJECT_DIR}' && export PATH=\"\$HOME/.bun/bin:\$PATH\" && bun install" 2>&1 | tail -5
    fi
  else
    VM_PROJECT_DIR="$VM_WORK_DIR"
  fi

  echo "[$VM_NAME] Starting Smithers workflow (max iterations: $MAX_ITERATIONS)..."
  limactl shell --workdir /home/ralph "$VM_NAME" sudo -u ralph bash <<EOF
    cd "${VM_PROJECT_DIR}"
    echo "[$VM_NAME] Working in: \$(pwd)"
    echo "[$VM_NAME] Starting loop..."
    export PATH="\$HOME/.bun/bin:\$PATH"
    export MAX_ITERATIONS=${MAX_ITERATIONS}
    export RALPH_AGENT=${RALPH_AGENT}

    export SMITHERS_SPEC_PATH="${VM_WORK_DIR}/specs/spec.min.json"
    export SMITHERS_TODO_PATH="${VM_WORK_DIR}/specs/todo.min.json"
    export SMITHERS_REPORT_DIR="${SMITHERS_REPORT_DIR:-${VM_WORK_DIR}/reports}"
    export SMITHERS_AGENT="${RALPH_AGENT}"
    if [[ -n "${SMITHERS_MODEL}" ]]; then
      export SMITHERS_MODEL="${SMITHERS_MODEL}"
    fi
    if [[ -d "${VM_WORK_DIR}/reviewers" ]]; then
      export SMITHERS_REVIEWERS_DIR="${VM_WORK_DIR}/reviewers"
    fi
    if [[ -f "${VM_WORK_DIR}/PROMPT.md" ]]; then
      export SMITHERS_PROMPT_PATH="${VM_WORK_DIR}/PROMPT.md"
    fi
    if [[ -f "${VM_WORK_DIR}/REVIEW_PROMPT.md" ]]; then
      export SMITHERS_REVIEW_PROMPT_PATH="${VM_WORK_DIR}/REVIEW_PROMPT.md"
    fi
    if [[ -n "${SMITHERS_REVIEW_MAX}" ]]; then
      export SMITHERS_REVIEW_MAX="${SMITHERS_REVIEW_MAX}"
    fi
    if [[ -f "${VM_WORK_DIR}/reviewer-models.json" ]]; then
      export SMITHERS_REVIEW_MODELS_FILE="${VM_WORK_DIR}/reviewer-models.json"
    fi
    export SMITHERS_MAX_ITERATIONS="${MAX_ITERATIONS}"
    smithers "${VM_WORK_DIR}/smithers-workflow.tsx"
    exit \$?
EOF
  EXIT_CODE=$?
  python3 - "$DB_PATH" "$RUN_ID" "$EXIT_CODE" <<'PY'
import sqlite3
import sys

db_path, run_id, exit_code = sys.argv[1:4]
status = "success" if exit_code == "0" else "failed"
conn = sqlite3.connect(db_path)
conn.execute("UPDATE runs SET status = ?, exit_code = ? WHERE id = ?", (status, int(exit_code), int(run_id)))
conn.commit()
conn.close()
PY

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

  VM_WORK_DIR="/home/ralph/work/${VM_NAME}/${WORK_SUBDIR}"
  ssh "ralph@${VM_IP}" "mkdir -p '$VM_WORK_DIR'"
  scp "$PROMPT_FILE" "ralph@${VM_IP}:${VM_WORK_DIR}/SPEC.md"
  ssh "ralph@${VM_IP}" "mkdir -p '${VM_WORK_DIR}/specs' '${VM_WORK_DIR}/reports'"
  scp "$SMITHERS_SPEC_PATH" "ralph@${VM_IP}:${VM_WORK_DIR}/specs/spec.min.json"
  scp "$SMITHERS_TODO_PATH" "ralph@${VM_IP}:${VM_WORK_DIR}/specs/todo.min.json"
  scp "$SMITHERS_WORKFLOW" "ralph@${VM_IP}:${VM_WORK_DIR}/smithers-workflow.tsx"
  if [[ -n "$SMITHERS_PROMPT_PATH" ]]; then
    scp "$SMITHERS_PROMPT_PATH" "ralph@${VM_IP}:${VM_WORK_DIR}/PROMPT.md"
  fi
  if [[ -n "$SMITHERS_REVIEW_PROMPT_PATH" ]]; then
    scp "$SMITHERS_REVIEW_PROMPT_PATH" "ralph@${VM_IP}:${VM_WORK_DIR}/REVIEW_PROMPT.md"
  fi
  if [[ -n "$SMITHERS_REVIEW_MODELS_FILE" ]]; then
    scp "$SMITHERS_REVIEW_MODELS_FILE" "ralph@${VM_IP}:${VM_WORK_DIR}/reviewer-models.json"
  fi
  if [[ -n "$SMITHERS_REVIEWERS_DIR_SRC" ]]; then
    ssh "ralph@${VM_IP}" "mkdir -p '${VM_WORK_DIR}/reviewers'"
    scp -r "$SMITHERS_REVIEWERS_DIR_SRC/." "ralph@${VM_IP}:${VM_WORK_DIR}/reviewers/"
  fi
  python3 - "$SMITHERS_SPEC_PATH" "$SMITHERS_TODO_PATH" "$SMITHERS_PROMPT_PATH" "$SMITHERS_REVIEW_PROMPT_PATH" "$SMITHERS_REVIEWERS_DIR_SRC" "$SMITHERS_REVIEW_MODELS_FILE" "$VM_NAME" "$RUN_ID" <<'PY' > /tmp/ralph-run-context.json
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

def read_text(path: str) -> str:
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""

def sha256(path: str) -> str:
    if not path or not os.path.exists(path):
        return ""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()

spec_path, todo_path, prompt_path, review_prompt_path, reviewers_dir, review_models_path, vm, run_id = sys.argv[1:9]

reviewers = []
if reviewers_dir and os.path.isdir(reviewers_dir):
    for name in sorted(os.listdir(reviewers_dir)):
        if not name.lower().endswith(".md"):
            continue
        path = os.path.join(reviewers_dir, name)
        reviewers.append({
            "file": name,
            "path": path,
            "sha256": sha256(path)
        })
payload = {
    "v": 1,
    "run_id": int(run_id),
    "vm": vm,
    "created_at": datetime.now(timezone.utc).isoformat(),
    "spec_path": spec_path,
    "todo_path": todo_path,
    "prompt_path": prompt_path or None,
    "review_prompt_path": review_prompt_path or None,
    "spec_sha256": sha256(spec_path),
    "todo_sha256": sha256(todo_path),
    "prompt_sha256": sha256(prompt_path),
    "review_prompt_sha256": sha256(review_prompt_path),
    "review_models_path": review_models_path or None,
    "review_models_sha256": sha256(review_models_path),
    "prompt_text": read_text(prompt_path).strip(),
    "review_prompt_text": read_text(review_prompt_path).strip(),
    "review_models_text": read_text(review_models_path).strip(),
    "reviewers": reviewers
}
print(json.dumps(payload, indent=2))
PY
  scp /tmp/ralph-run-context.json "ralph@${VM_IP}:${VM_WORK_DIR}/reports/run-context.json"
  rm -f /tmp/ralph-run-context.json

  if [[ -n "$PROJECT_DIR" ]]; then
    echo "[$VM_NAME] Syncing project directory..."

    # Build rsync exclude options
    RSYNC_EXCLUDES="--exclude='node_modules'"
    if [[ "$INCLUDE_GIT" == "false" ]]; then
      RSYNC_EXCLUDES="$RSYNC_EXCLUDES --exclude='.git'"
    fi

    eval "rsync -az --delete $RSYNC_EXCLUDES '$PROJECT_DIR/' 'ralph@${VM_IP}:${VM_WORK_DIR}/'"
    VM_PROJECT_DIR="${VM_WORK_DIR}"

    # If .git was included, verify git remote works and init jj
    if [[ "$INCLUDE_GIT" == "true" && -d "$PROJECT_DIR/.git" ]]; then
      echo "[$VM_NAME] Verifying git remote access and initializing jj..."
      ssh "ralph@${VM_IP}" bash -c "'
        cd \"$VM_PROJECT_DIR\"

        # Source ralph.env for GITHUB_TOKEN
        if [[ -f ~/.config/ralph/ralph.env ]]; then
          set -a
          source ~/.config/ralph/ralph.env
          set +a
        fi

        # Configure git to use GITHUB_TOKEN for GitHub HTTPS URLs
        if [[ -n \"\${GITHUB_TOKEN:-}\" ]]; then
          git config --global url.\"https://oauth:\${GITHUB_TOKEN}@github.com/\".insteadOf \"https://github.com/\"
        fi

        # Show current remote (redact tokens)
        REMOTE_URL=\$(git remote get-url origin 2>/dev/null || echo \"none\")
        REMOTE_URL_SAFE=\$(echo \"\$REMOTE_URL\" | sed -E 's|://[^:]+:[^@]+@|://***@|')
        echo \"[$VM_NAME] Git remote: \$REMOTE_URL_SAFE\"

        # Configure git user if not set
        git config user.email >/dev/null 2>&1 || git config user.email \"ralph@local\"
        git config user.name >/dev/null 2>&1 || git config user.name \"Ralph Agent\"

        # Test that we can fetch (verifies credentials work)
        if git ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
          echo \"[$VM_NAME] Git remote access: OK\"
        else
          echo \"[$VM_NAME] WARNING: Cannot access git remote. Push may fail.\"
          echo \"[$VM_NAME] Ensure GITHUB_TOKEN is set in ~/.config/ralph/ralph.env\"
        fi

        # Initialize jj (colocated) if needed
        if [[ ! -d .jj ]]; then
          jj git init >/dev/null 2>&1 || true
        fi
        echo \"[$VM_NAME] JJ: \$(jj status -s 2>/dev/null | head -1 || echo 'ready')\"
      '"
    fi

    # Install dependencies if package.json exists
    if [[ -f "$PROJECT_DIR/package.json" ]]; then
      echo "[$VM_NAME] Installing dependencies (bun install)..."
      ssh "ralph@${VM_IP}" "cd '${VM_PROJECT_DIR}' && export PATH=\"\$HOME/.bun/bin:\$PATH\" && bun install" 2>&1 | tail -5
    fi
  else
    VM_PROJECT_DIR="$VM_WORK_DIR"
  fi

  echo "[$VM_NAME] Starting Smithers workflow (max iterations: $MAX_ITERATIONS)..."
  ssh "ralph@${VM_IP}" bash -c "'
    cd \"$VM_PROJECT_DIR\"
    echo \"[$VM_NAME] Working in: \$(pwd)\"
    echo \"[$VM_NAME] Starting loop...\"
    export PATH=\"\$HOME/.bun/bin:\$PATH\"
    export MAX_ITERATIONS=$MAX_ITERATIONS
    export RALPH_AGENT=$RALPH_AGENT

    export SMITHERS_SPEC_PATH=\"${VM_WORK_DIR}/specs/spec.min.json\"
    export SMITHERS_TODO_PATH=\"${VM_WORK_DIR}/specs/todo.min.json\"
    export SMITHERS_REPORT_DIR=\"${SMITHERS_REPORT_DIR:-${VM_WORK_DIR}/reports}\"
    export SMITHERS_AGENT=\"${RALPH_AGENT}\"
    if [[ -n \"${SMITHERS_MODEL}\" ]]; then
      export SMITHERS_MODEL=\"${SMITHERS_MODEL}\"
    fi
    if [[ -d \"${VM_WORK_DIR}/reviewers\" ]]; then
      export SMITHERS_REVIEWERS_DIR=\"${VM_WORK_DIR}/reviewers\"
    fi
    if [[ -f \"${VM_WORK_DIR}/PROMPT.md\" ]]; then
      export SMITHERS_PROMPT_PATH=\"${VM_WORK_DIR}/PROMPT.md\"
    fi
    if [[ -f \"${VM_WORK_DIR}/REVIEW_PROMPT.md\" ]]; then
      export SMITHERS_REVIEW_PROMPT_PATH=\"${VM_WORK_DIR}/REVIEW_PROMPT.md\"
    fi
    if [[ -n \"${SMITHERS_REVIEW_MAX}\" ]]; then
      export SMITHERS_REVIEW_MAX=\"${SMITHERS_REVIEW_MAX}\"
    fi
    if [[ -f \"${VM_WORK_DIR}/reviewer-models.json\" ]]; then
      export SMITHERS_REVIEW_MODELS_FILE=\"${VM_WORK_DIR}/reviewer-models.json\"
    fi
    export SMITHERS_MAX_ITERATIONS=\"${MAX_ITERATIONS}\"
    smithers \"${VM_WORK_DIR}/smithers-workflow.tsx\"
    exit \$?
  '"
  EXIT_CODE=$?
  python3 - "$DB_PATH" "$RUN_ID" "$EXIT_CODE" <<'PY'
import sqlite3
import sys

db_path, run_id, exit_code = sys.argv[1:4]
status = "success" if exit_code == "0" else "failed"
conn = sqlite3.connect(db_path)
conn.execute("UPDATE runs SET status = ?, exit_code = ? WHERE id = ?", (status, int(exit_code), int(run_id)))
conn.commit()
conn.close()
PY
fi
