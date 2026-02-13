#!/usr/bin/env bash
#
# Start multiple Smithers workflows (one per VM)
# Usage: ./smithers-fleet.sh <specs-dir> <vm-prefix>
#
# Expects specs-dir structure:
#   specs/
#     001-foo.json
#     001-foo.todo.json
#     002-bar.json
#     002-bar.todo.json
#
# Example:
#   ./scripts/smithers-fleet.sh specs ralph
#
set -euo pipefail

SPECS_DIR="${1:?Usage: $0 <specs-dir> <vm-prefix>}"
VM_PREFIX="${2:?Usage: $0 <specs-dir> <vm-prefix>}"
SPECS_DIR=$(realpath "$SPECS_DIR")

PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"

SPECS=()
for spec in "$SPECS_DIR"/*.json; do
  if [[ "$spec" == *.todo.json ]] || [[ "$spec" == *.min.json ]]; then
    continue
  fi
  base="${spec%.json}"
  todo="${base}.todo.json"
  if [[ -f "$todo" ]]; then
    SPECS+=("$spec")
  fi
done

if [[ ${#SPECS[@]} -eq 0 ]]; then
  echo "No spec/todo pairs found in $SPECS_DIR"
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

if [[ "$OS" == "macos" ]]; then
  VMS=($(limactl list --format '{{.Name}}' 2>/dev/null | grep -E "^${VM_PREFIX}" || true))
else
  VMS=($(virsh list --all --name 2>/dev/null | grep -E "^${VM_PREFIX}" || true))
fi

if [[ ${#VMS[@]} -eq 0 ]]; then
  echo "No VMs found with prefix '$VM_PREFIX'."
  exit 1
fi

echo "Found ${#SPECS[@]} specs and ${#VMS[@]} VMs."
echo ""

for i in "${!SPECS[@]}"; do
  if [[ $i -ge ${#VMS[@]} ]]; then
    echo "Warning: More specs than VMs. Skipping: ${SPECS[$i]}"
    continue
  fi

  VM="${VMS[$i]}"
  SPEC="${SPECS[$i]}"
  echo "Dispatching $(basename "$SPEC") -> $VM"
  ./dist/fabrik run --spec "$SPEC" --vm "$VM" --project "$PROJECT_DIR"
done
