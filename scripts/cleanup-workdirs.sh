#!/usr/bin/env bash
#
# Cleanup old Smithers workdirs for a VM (immutable runs)
# Usage: ./cleanup-workdirs.sh <vm-name> [--keep N] [--dry-run]
#
set -euo pipefail

VM_NAME="${1:?Usage: $0 <vm-name> [--keep N] [--dry-run]}"
KEEP_COUNT=5
DRY_RUN=false

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      KEEP_COUNT="${2:-5}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

DB_PATH="${RALPH_DB_PATH:-$HOME/.cache/ralph/ralph.db}"
DB_DIR="$(dirname "$DB_PATH")"
mkdir -p "$DB_DIR"
chmod 700 "$DB_DIR" 2>/dev/null || true
if [[ -e "$DB_PATH" ]]; then
  chmod 600 "$DB_PATH" 2>/dev/null || true
fi
if [[ ! -f "$DB_PATH" ]]; then
  echo "No DB found at $DB_PATH"
  exit 0
fi

WORKDIRS=$(
  python3 - "$DB_PATH" "$VM_NAME" "$KEEP_COUNT" <<'PY'
import sqlite3
import sys

db_path, vm, keep = sys.argv[1:4]
keep_n = int(keep)
conn = sqlite3.connect(db_path)
cur = conn.execute(
  "SELECT workdir FROM runs WHERE vm_name = ? ORDER BY started_at DESC",
  (vm,)
)
rows = [r[0] for r in cur.fetchall()]
conn.close()
for workdir in rows[keep_n:]:
  print(workdir)
PY
)

if [[ -z "$WORKDIRS" ]]; then
  echo "Nothing to clean for $VM_NAME (keeping $KEEP_COUNT)."
  exit 0
fi

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

echo "Cleaning workdirs for $VM_NAME (keeping $KEEP_COUNT):"
while IFS= read -r workdir; do
  [[ -z "$workdir" ]] && continue
  case "$workdir" in
    /home/ralph/work/"$VM_NAME"/*) ;;
    *)
      echo "Skipping unexpected path: $workdir"
      continue
      ;;
  esac

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] rm -rf $workdir"
  else
    echo "rm -rf $workdir"
    "${SSH_CMD[@]}" bash -c "rm -rf '$workdir'"
  fi
done <<< "$WORKDIRS"
