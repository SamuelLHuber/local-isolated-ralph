#!/usr/bin/env bash
#
# Start multiple Smithers workflows (one per VM)
# Usage: ./smithers-fleet.sh <specs-dir> <vm-prefix>
#
# Expects specs-dir structure:
#   specs/
#     001-foo.min.json
#     001-foo.todo.min.json
#     002-bar.min.json
#     002-bar.todo.min.json
#
# Example:
#   ./scripts/smithers-fleet.sh specs ralph
#
set -euo pipefail

SPECS_DIR="${1:?Usage: $0 <specs-dir> <vm-prefix>}"
VM_PREFIX="${2:?Usage: $0 <specs-dir> <vm-prefix>}"
SPECS_DIR=$(realpath "$SPECS_DIR")

SPECS=()
for spec in "$SPECS_DIR"/*.min.json; do
  if [[ "$spec" == *.todo.min.json ]]; then
    continue
  fi
  base="${spec%.min.json}"
  todo="${base}.todo.min.json"
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
  ./scripts/dispatch.sh --spec "$SPEC" "$VM" "$SPEC"
done
