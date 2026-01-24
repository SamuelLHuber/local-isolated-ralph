#!/usr/bin/env bash
#
# Cleanup Ralph VMs
# Usage: ./cleanup-ralphs.sh [--all | <name>...]
#
# Examples:
#   ./cleanup-ralphs.sh ralph-1 ralph-2    # Delete specific VMs
#   ./cleanup-ralphs.sh --all              # Delete all Ralph VMs
#   ./cleanup-ralphs.sh --all --force      # Delete all without confirmation

set -euo pipefail

FORCE=false
DELETE_ALL=false
VMS_TO_DELETE=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      DELETE_ALL=true
      shift
      ;;
    --force|-f)
      FORCE=true
      shift
      ;;
    -*)
      echo "Unknown option: $1"
      exit 1
      ;;
    *)
      VMS_TO_DELETE+=("$1")
      shift
      ;;
  esac
done

# Detect OS
case "$(uname -s)" in
  Darwin)
    OS="macos"
    ;;
  Linux)
    OS="linux"
    ;;
  *)
    echo "Unsupported OS"
    exit 1
    ;;
esac

# Get list of VMs to delete
if [[ "$DELETE_ALL" == "true" ]]; then
  if [[ "$OS" == "macos" ]]; then
    mapfile -t VMS_TO_DELETE < <(colima list 2>/dev/null | tail -n +2 | awk '{print $1}')
  else
    mapfile -t VMS_TO_DELETE < <(virsh list --all --name 2>/dev/null | grep -v '^$')
  fi
fi

if [[ ${#VMS_TO_DELETE[@]} -eq 0 ]]; then
  echo "No VMs to delete."
  echo "Usage: $0 [--all | <name>...]"
  exit 0
fi

echo "VMs to delete:"
for vm in "${VMS_TO_DELETE[@]}"; do
  echo "  - $vm"
done
echo ""

# Confirmation
if [[ "$FORCE" != "true" ]]; then
  read -r -p "Delete these VMs? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# Delete VMs
for vm in "${VMS_TO_DELETE[@]}"; do
  echo "Deleting: $vm"

  if [[ "$OS" == "macos" ]]; then
    colima stop -p "$vm" 2>/dev/null || true
    colima delete -p "$vm" --force 2>/dev/null || true
  else
    virsh destroy "$vm" 2>/dev/null || true
    virsh undefine "$vm" --remove-all-storage 2>/dev/null || true
    # Clean up cloud-init files
    rm -rf "${HOME}/vms/wisp/${vm}-cloud-init" 2>/dev/null || true
    rm -f "${HOME}/vms/wisp/${vm}-cloud-init.iso" 2>/dev/null || true
  fi

  echo "  Deleted: $vm"
done

echo ""
echo "Cleanup complete. ${#VMS_TO_DELETE[@]} VM(s) deleted."
