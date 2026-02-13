#!/usr/bin/env bash
# Sync host credentials into an existing Ralph VM
# Usage: ./sync-credentials.sh <vm-name>

set -euo pipefail

VM_NAME="${1:-}"
if [[ -z "$VM_NAME" ]]; then
  echo "Usage: $0 <vm-name>" >&2
  exit 1
fi

copy_credentials_ssh() {
  local host="$1"
  local user="${2:-ralph}"
  local ssh_opts="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

  echo ""
  echo ">>> Copying credentials to VM..."

  if [[ -d ~/.claude ]]; then
    echo "    Copying ~/.claude..."
    scp $ssh_opts -r ~/.claude "$user@$host:~/" 2>/dev/null || echo "    Warning: Failed to copy ~/.claude"
  else
    echo "    Note: ~/.claude not found (run 'claude setup-token' or set ANTHROPIC_API_KEY)"
  fi

  if [[ -f ~/.gitconfig ]]; then
    echo "    Copying ~/.gitconfig..."
    scp $ssh_opts ~/.gitconfig "$user@$host:~/" 2>/dev/null || echo "    Warning: Failed to copy ~/.gitconfig"
  fi

  local has_keys=false
  for keyfile in ~/.ssh/id_ed25519 ~/.ssh/id_rsa; do
    if [[ -f "$keyfile" ]]; then
      has_keys=true
      echo "    Copying SSH key: $(basename "$keyfile")..."
      ssh $ssh_opts "$user@$host" "mkdir -p ~/.ssh && chmod 700 ~/.ssh" 2>/dev/null || true
      scp $ssh_opts "$keyfile" "$keyfile.pub" "$user@$host:~/.ssh/" 2>/dev/null || echo "    Warning: Failed to copy $keyfile"
      ssh $ssh_opts "$user@$host" "chmod 600 ~/.ssh/id_* 2>/dev/null" || true
    fi
  done
  if [[ "$has_keys" == "false" ]]; then
    echo "    Note: No SSH keys found"
  fi

  if [[ -d ~/.config/gh ]]; then
    echo "    Copying ~/.config/gh..."
    ssh $ssh_opts "$user@$host" "mkdir -p ~/.config && chmod 700 ~/.config" 2>/dev/null || true
    scp $ssh_opts -r ~/.config/gh "$user@$host:~/.config/" 2>/dev/null || echo "    Warning: Failed to copy ~/.config/gh"
  fi

  if [[ -d ~/.pi/agent ]]; then
    echo "    Copying ~/.pi/agent..."
    ssh $ssh_opts "$user@$host" "mkdir -p ~/.pi && chmod 700 ~/.pi" 2>/dev/null || true
    scp $ssh_opts -r ~/.pi/agent "$user@$host:~/.pi/" 2>/dev/null || echo "    Warning: Failed to copy ~/.pi/agent"
  else
    echo "    Note: ~/.pi/agent not found (pi will need login in VM)"
    ssh $ssh_opts "$user@$host" "mkdir -p ~/.pi/agent && chmod 700 ~/.pi && chmod 700 ~/.pi/agent" 2>/dev/null || true
  fi

  if [[ -f ~/.codex/auth.json ]]; then
    echo "    Copying ~/.codex/auth.json..."
    ssh $ssh_opts "$user@$host" "mkdir -p ~/.codex && chmod 700 ~/.codex" 2>/dev/null || true
    scp $ssh_opts ~/.codex/auth.json "$user@$host:~/.codex/" 2>/dev/null || echo "    Warning: Failed to copy ~/.codex/auth.json"
    ssh $ssh_opts "$user@$host" "chmod 600 ~/.codex/auth.json" 2>/dev/null || true
  fi

  if [[ -f ~/.config/ralph/ralph.env ]]; then
    echo "    Copying ~/.config/ralph/ralph.env..."
    ssh $ssh_opts "$user@$host" "mkdir -p ~/.config/ralph && chmod 700 ~/.config && chmod 700 ~/.config/ralph" 2>/dev/null || true
    scp $ssh_opts ~/.config/ralph/ralph.env "$user@$host:~/.config/ralph/" 2>/dev/null || echo "    Warning: Failed to copy ralph.env"
    ssh $ssh_opts "$user@$host" "chmod 600 ~/.config/ralph/ralph.env" 2>/dev/null || true
  else
    echo "    Note: ~/.config/ralph/ralph.env not found (Claude Code may require manual auth)"
  fi

  echo "Credentials copied."
}

copy_credentials_lima() {
  local vm_name="$1"
  local user="ralph"

  echo ""
  echo ">>> Copying credentials to VM..."

  if [[ -d ~/.claude ]]; then
    echo "    Copying ~/.claude..."
    tar -C ~ -cf - .claude 2>/dev/null | limactl shell "$vm_name" tar -C "/home/$user" -xf - 2>/dev/null || echo "    Warning: Failed to copy ~/.claude"
    limactl shell "$vm_name" chown -R "$user:users" "/home/$user/.claude" 2>/dev/null || true
  else
    echo "    Note: ~/.claude not found (run 'claude setup-token' or set ANTHROPIC_API_KEY)"
  fi

  if [[ -f ~/.gitconfig ]]; then
    echo "    Copying ~/.gitconfig..."
    cat ~/.gitconfig | limactl shell "$vm_name" sudo -u "$user" tee "/home/$user/.gitconfig" > /dev/null 2>&1 || echo "    Warning: Failed to copy ~/.gitconfig"
  fi

  limactl shell "$vm_name" sudo mkdir -p "/home/$user/.config" 2>/dev/null || true
  limactl shell "$vm_name" sudo chown -R "$user:users" "/home/$user/.config" 2>/dev/null || true
  limactl shell "$vm_name" sudo -u "$user" chmod 700 "/home/$user/.config" 2>/dev/null || true

  local has_keys=false
  for keyfile in ~/.ssh/id_ed25519 ~/.ssh/id_rsa; do
    if [[ -f "$keyfile" ]]; then
      has_keys=true
      local keyname
      keyname=$(basename "$keyfile")
      echo "    Copying SSH key: $keyname..."
      limactl shell "$vm_name" sudo -u "$user" mkdir -p "/home/$user/.ssh" 2>/dev/null || true
      limactl shell "$vm_name" sudo -u "$user" chmod 700 "/home/$user/.ssh" 2>/dev/null || true
      cat "$keyfile" | limactl shell "$vm_name" sudo -u "$user" tee "/home/$user/.ssh/$keyname" > /dev/null 2>&1 || true
      cat "$keyfile.pub" | limactl shell "$vm_name" sudo -u "$user" tee "/home/$user/.ssh/$keyname.pub" > /dev/null 2>&1 || true
      limactl shell "$vm_name" sudo -u "$user" chmod 600 "/home/$user/.ssh/$keyname" 2>/dev/null || true
    fi
  done
  if [[ "$has_keys" == "false" ]]; then
    echo "    Note: No SSH keys found"
  fi

  if [[ -d ~/.config/gh ]]; then
    echo "    Copying ~/.config/gh..."
    limactl shell "$vm_name" sudo -u "$user" mkdir -p "/home/$user/.config" 2>/dev/null || true
    tar -C ~/.config -cf - gh 2>/dev/null | limactl shell "$vm_name" sudo -u "$user" tar -C "/home/$user/.config" -xf - 2>/dev/null || echo "    Warning: Failed to copy ~/.config/gh"
  fi

  if [[ -d ~/.pi/agent ]]; then
    echo "    Copying ~/.pi/agent..."
    limactl shell "$vm_name" sudo -u "$user" mkdir -p "/home/$user/.pi" 2>/dev/null || true
    tar -C ~/.pi -cf - agent 2>/dev/null | limactl shell "$vm_name" sudo -u "$user" tar -C "/home/$user/.pi" -xf - 2>/dev/null || echo "    Warning: Failed to copy ~/.pi/agent"
  else
    echo "    Note: ~/.pi/agent not found (pi will need login in VM)"
    limactl shell "$vm_name" sudo -u "$user" mkdir -p "/home/$user/.pi/agent" 2>/dev/null || true
    limactl shell "$vm_name" sudo -u "$user" chmod 700 "/home/$user/.pi" "/home/$user/.pi/agent" 2>/dev/null || true
  fi

  if [[ -f ~/.codex/auth.json ]]; then
    echo "    Copying ~/.codex/auth.json..."
    limactl shell "$vm_name" sudo -u "$user" mkdir -p "/home/$user/.codex" 2>/dev/null || true
    limactl shell "$vm_name" sudo -u "$user" chmod 700 "/home/$user/.codex" 2>/dev/null || true
    cat ~/.codex/auth.json | limactl shell "$vm_name" sudo -u "$user" tee "/home/$user/.codex/auth.json" > /dev/null 2>&1 || echo "    Warning: Failed to copy ~/.codex/auth.json"
    limactl shell "$vm_name" sudo -u "$user" chmod 600 "/home/$user/.codex/auth.json" 2>/dev/null || true
  fi

  if [[ -f ~/.config/ralph/ralph.env ]]; then
    echo "    Copying ~/.config/ralph/ralph.env..."
    limactl shell "$vm_name" sudo -u "$user" mkdir -p "/home/$user/.config/ralph" 2>/dev/null || true
    limactl shell "$vm_name" sudo -u "$user" chmod 700 "/home/$user/.config/ralph" 2>/dev/null || true
    cat ~/.config/ralph/ralph.env | limactl shell "$vm_name" sudo -u "$user" tee "/home/$user/.config/ralph/ralph.env" > /dev/null 2>&1 || echo "    Warning: Failed to copy ralph.env"
    limactl shell "$vm_name" sudo -u "$user" chmod 600 "/home/$user/.config/ralph/ralph.env" 2>/dev/null || true
  else
    echo "    Note: ~/.config/ralph/ralph.env not found (Claude Code may require manual auth)"
  fi

  echo "Credentials copied."
}

case "$(uname -s)" in
  Darwin)
    copy_credentials_lima "$VM_NAME"
    ;;
  Linux)
    VM_IP=$(virsh domifaddr "$VM_NAME" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
    if [[ -z "$VM_IP" ]]; then
      echo "Error: Could not determine IP for VM '$VM_NAME'. Is it running?" >&2
      exit 1
    fi
    copy_credentials_ssh "$VM_IP"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac
