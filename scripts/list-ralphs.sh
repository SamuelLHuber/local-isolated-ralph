#!/usr/bin/env bash
#
# List all Ralph VMs and their status
# Usage: ./list-ralphs.sh

set -euo pipefail

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

echo "Ralph VM Fleet Status"
echo "====================="
echo ""

if [[ "$OS" == "macos" ]]; then
  # Colima - list all profiles
  if ! command -v colima &>/dev/null; then
    echo "Colima not installed"
    exit 1
  fi

  printf "%-20s %-12s %-6s %-8s %-10s\n" "NAME" "STATUS" "CPU" "MEMORY" "DISK"
  printf "%-20s %-12s %-6s %-8s %-10s\n" "----" "------" "---" "------" "----"

  colima list 2>/dev/null | tail -n +2 | while read -r line; do
    NAME=$(echo "$line" | awk '{print $1}')
    STATUS=$(echo "$line" | awk '{print $2}')
    CPU=$(echo "$line" | awk '{print $3}')
    MEM=$(echo "$line" | awk '{print $4}')
    DISK=$(echo "$line" | awk '{print $5}')
    printf "%-20s %-12s %-6s %-8s %-10s\n" "$NAME" "$STATUS" "$CPU" "$MEM" "$DISK"
  done

else
  # libvirt - list VMs
  if ! command -v virsh &>/dev/null; then
    echo "libvirt not installed"
    exit 1
  fi

  printf "%-20s %-12s %-10s\n" "NAME" "STATUS" "IP"
  printf "%-20s %-12s %-10s\n" "----" "------" "--"

  virsh list --all 2>/dev/null | tail -n +3 | head -n -1 | while read -r line; do
    if [[ -z "$line" ]]; then continue; fi
    ID=$(echo "$line" | awk '{print $1}')
    NAME=$(echo "$line" | awk '{print $2}')
    STATUS=$(echo "$line" | awk '{print $3}')

    # Get IP if running
    IP="-"
    if [[ "$STATUS" == "running" ]]; then
      IP=$(virsh domifaddr "$NAME" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
      [[ -z "$IP" ]] && IP="pending..."
    fi

    printf "%-20s %-12s %-10s\n" "$NAME" "$STATUS" "$IP"
  done
fi

echo ""
