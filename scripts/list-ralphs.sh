#!/usr/bin/env bash
#
# List all Ralph VMs and their status
# Usage: ./list-ralphs.sh

set -euo pipefail

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)
    echo "Unsupported OS"
    exit 1
    ;;
esac

echo "Ralph VM Fleet Status"
echo "====================="
echo ""

if [[ "$OS" == "macos" ]]; then
  if ! command -v limactl &>/dev/null; then
    echo "Lima not installed"
    exit 1
  fi

  printf "%-20s %-12s %-6s %-8s %-10s\n" "NAME" "STATUS" "CPU" "MEMORY" "DISK"
  printf "%-20s %-12s %-6s %-8s %-10s\n" "----" "------" "---" "------" "----"

  limactl list --format '{{.Name}} {{.Status}} {{.CPUs}} {{.Memory}} {{.Disk}}' 2>/dev/null | while read -r line; do
    NAME=$(echo "$line" | awk '{print $1}')
    STATUS=$(echo "$line" | awk '{print $2}')
    CPU=$(echo "$line" | awk '{print $3}')
    MEM=$(echo "$line" | awk '{print $4}')
    DISK=$(echo "$line" | awk '{print $5}')
    printf "%-20s %-12s %-6s %-8s %-10s\n" "$NAME" "$STATUS" "$CPU" "$MEM" "$DISK"
  done

else
  if ! command -v virsh &>/dev/null; then
    echo "libvirt not installed"
    exit 1
  fi

  printf "%-20s %-12s %-15s\n" "NAME" "STATUS" "IP"
  printf "%-20s %-12s %-15s\n" "----" "------" "--"

  virsh list --all 2>/dev/null | tail -n +3 | head -n -1 | while read -r line; do
    if [[ -z "$line" ]]; then continue; fi
    NAME=$(echo "$line" | awk '{print $2}')
    STATUS=$(echo "$line" | awk '{print $3}')

    IP="-"
    if [[ "$STATUS" == "running" ]]; then
      IP=$(virsh domifaddr "$NAME" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
      [[ -z "$IP" ]] && IP="pending..."
    fi

    printf "%-20s %-12s %-15s\n" "$NAME" "$STATUS" "$IP"
  done
fi

echo ""
