#!/usr/bin/env bash
#
# Record human feedback for a spec run
# Usage: ./record-human-feedback.sh --vm <vm> --spec <spec-path> --decision <approve|reject> --notes "<text>"
#
set -euo pipefail

VM_NAME=""
SPEC_PATH=""
DECISION=""
NOTES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)
      VM_NAME="${2:-}"
      shift 2
      ;;
    --spec)
      SPEC_PATH="${2:-}"
      shift 2
      ;;
    --decision)
      DECISION="${2:-}"
      shift 2
      ;;
    --notes)
      NOTES="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$VM_NAME" || -z "$SPEC_PATH" || -z "$DECISION" ]]; then
  echo "Usage: $0 --vm <vm> --spec <spec-path> --decision <approve|reject> --notes \"...\""
  exit 1
fi

SPEC_PATH=$(realpath "$SPEC_PATH")
DB_PATH="${RALPH_DB_PATH:-$HOME/.cache/ralph/ralph.db}"
DB_DIR="$(dirname "$DB_PATH")"
mkdir -p "$DB_DIR"
chmod 700 "$DB_DIR" 2>/dev/null || true
if [[ -e "$DB_PATH" ]]; then
  chmod 600 "$DB_PATH" 2>/dev/null || true
fi

RUN_INFO=$(
  python3 - "$DB_PATH" "$VM_NAME" "$SPEC_PATH" <<'PY'
import sqlite3
import sys

db_path, vm, spec = sys.argv[1:4]
conn = sqlite3.connect(db_path)
conn.execute("""
CREATE TABLE IF NOT EXISTS human_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  vm_name TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  decision TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL
)
""")
cur = conn.execute(
  "SELECT id, workdir FROM runs WHERE vm_name = ? AND spec_path = ? ORDER BY started_at DESC LIMIT 1",
  (vm, spec)
)
row = cur.fetchone()
if not row:
  print("")
  conn.close()
  sys.exit(0)
run_id, workdir = row
print(f"{run_id}|{workdir}")
conn.close()
PY
)

if [[ -z "$RUN_INFO" ]]; then
  echo "No run found for vm=$VM_NAME spec=$SPEC_PATH"
  exit 1
fi

RUN_ID="${RUN_INFO%%|*}"
WORKDIR="${RUN_INFO#*|}"

python3 - "$DB_PATH" "$RUN_ID" "$VM_NAME" "$SPEC_PATH" "$DECISION" "$NOTES" <<'PY'
import sqlite3
import sys
from datetime import datetime, timezone

db_path, run_id, vm, spec, decision, notes = sys.argv[1:7]
conn = sqlite3.connect(db_path)
conn.execute(
  "INSERT INTO human_feedback (run_id, vm_name, spec_path, decision, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  (int(run_id), vm, spec, decision, notes, datetime.now(timezone.utc).isoformat())
)
conn.commit()
conn.close()
PY

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)
    echo "Unsupported OS"
    exit 1
    ;;
esac

if [[ "$OS" == "macos" ]]; then
  SSH_CMD=(limactl shell "$VM_NAME" sudo -u ralph -i --)
else
  VM_IP=$(virsh domifaddr "$VM_NAME" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
  if [[ -z "$VM_IP" ]]; then
    echo "Error: Could not get VM IP"
    exit 1
  fi
  SSH_CMD=(ssh "ralph@${VM_IP}")
fi

JSON=$(python3 - "$DECISION" "$NOTES" <<'PY'
import json
import sys

decision, notes = sys.argv[1:3]
print(json.dumps({"v": 1, "decision": decision, "notes": notes}, indent=2))
PY
)

"${SSH_CMD[@]}" bash -c "mkdir -p '$WORKDIR/reports' && cat > '$WORKDIR/reports/human-feedback.json' <<'EOF'
$JSON
EOF"

echo "Recorded human feedback for run $RUN_ID."
