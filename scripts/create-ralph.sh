#!/usr/bin/env bash
#
# Create a new Ralph VM instance
# Usage: ./create-ralph.sh <name> [cpu] [memory_gb] [disk_gb]
#
# Examples:
#   ./create-ralph.sh ralph-1              # Default: 4 CPU, 6GB RAM, 30GB disk
#   ./create-ralph.sh ralph-2 2 4 20       # Light: 2 CPU, 4GB RAM, 20GB disk
#   ./create-ralph.sh ralph-3 6 8 50       # Heavy: 6 CPU, 8GB RAM, 50GB disk
#
# After VM creation, this script will copy to the VM:
#   - ~/.claude, ~/.codex (agent auth)
#   - ~/.gitconfig, ~/.ssh, ~/.config/gh (git/GitHub credentials)
#   - ralph-loop.sh to ~/ralph/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAME="${1:?Usage: $0 <name> [cpu] [memory_gb] [disk_gb]}"
CPU="${2:-4}"
MEMORY="${3:-6}"
DISK="${4:-30}"

# Function to copy auth folders and scripts to VM (Linux/libvirt)
copy_auth_to_vm_linux() {
  local vm_ip="$1"
  local ssh_opts="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

  echo ""
  echo ">>> Copying auth folders and scripts to VM..."

  echo "Waiting for SSH to be ready..."
  for i in {1..30}; do
    if ssh $ssh_opts "dev@$vm_ip" "echo 'SSH ready'" 2>/dev/null; then
      break
    fi
    sleep 2
  done

  if [[ -d ~/.claude ]]; then
    echo "Copying ~/.claude..."
    scp $ssh_opts -r ~/.claude "dev@$vm_ip:~/" 2>/dev/null || echo "Warning: Failed to copy ~/.claude"
  else
    echo "Note: ~/.claude not found on host (run 'claude auth login' first)"
  fi

  if [[ -d ~/.codex ]]; then
    echo "Copying ~/.codex..."
    scp $ssh_opts -r ~/.codex "dev@$vm_ip:~/" 2>/dev/null || echo "Warning: Failed to copy ~/.codex"
  fi

  if [[ -f ~/.gitconfig ]]; then
    echo "Copying ~/.gitconfig..."
    scp $ssh_opts ~/.gitconfig "dev@$vm_ip:~/" 2>/dev/null || echo "Warning: Failed to copy ~/.gitconfig"
  else
    echo "Note: ~/.gitconfig not found - git identity will need manual configuration"
  fi

  local has_keys=false
  for keyfile in ~/.ssh/id_ed25519 ~/.ssh/id_rsa; do
    if [[ -f "$keyfile" ]]; then
      has_keys=true
      echo "Copying SSH key: $(basename "$keyfile")..."
      ssh $ssh_opts "dev@$vm_ip" "mkdir -p ~/.ssh && chmod 700 ~/.ssh" 2>/dev/null || true
      scp $ssh_opts "$keyfile" "$keyfile.pub" "dev@$vm_ip:~/.ssh/" 2>/dev/null || echo "Warning: Failed to copy $keyfile"
      ssh $ssh_opts "dev@$vm_ip" "chmod 600 ~/.ssh/id_* 2>/dev/null" || true
    fi
  done
  if [[ "$has_keys" == "false" ]]; then
    echo "Note: No SSH keys found - GitHub SSH access will need manual configuration"
  fi

  if [[ -d ~/.config/gh ]]; then
    echo "Copying ~/.config/gh..."
    ssh $ssh_opts "dev@$vm_ip" "mkdir -p ~/.config" 2>/dev/null || true
    scp $ssh_opts -r ~/.config/gh "dev@$vm_ip:~/.config/" 2>/dev/null || echo "Warning: Failed to copy ~/.config/gh"
  else
    echo "Note: ~/.config/gh not found - run 'gh auth login' for GitHub CLI access"
  fi

  ssh $ssh_opts "dev@$vm_ip" "mkdir -p ~/ralph" 2>/dev/null || true
  if [[ -f "$SCRIPT_DIR/ralph-loop.sh" ]]; then
    echo "Copying ralph-loop.sh..."
    scp $ssh_opts "$SCRIPT_DIR/ralph-loop.sh" "dev@$vm_ip:~/ralph/loop.sh" 2>/dev/null || echo "Warning: Failed to copy ralph-loop.sh"
    ssh $ssh_opts "dev@$vm_ip" "chmod +x ~/ralph/loop.sh" 2>/dev/null || true
  fi

  echo "Auth and scripts copied successfully!"
}

# Function to copy auth folders to Colima VM (macOS)
copy_auth_to_vm_colima() {
  local profile="$1"

  echo ""
  echo ">>> Copying auth folders and scripts to VM..."

  echo "Waiting for VM to be ready..."
  sleep 5

  if [[ -d ~/.claude ]]; then
    echo "Copying ~/.claude..."
    tar -C ~ -cf - .claude | colima ssh -p "$profile" -- tar -C ~ -xf - 2>/dev/null || echo "Warning: Failed to copy ~/.claude"
  else
    echo "Note: ~/.claude not found on host (run 'claude auth login' first)"
  fi

  if [[ -d ~/.codex ]]; then
    echo "Copying ~/.codex..."
    tar -C ~ -cf - .codex | colima ssh -p "$profile" -- tar -C ~ -xf - 2>/dev/null || echo "Warning: Failed to copy ~/.codex"
  fi

  if [[ -f ~/.gitconfig ]]; then
    echo "Copying ~/.gitconfig..."
    tar -C ~ -cf - .gitconfig | colima ssh -p "$profile" -- tar -C ~ -xf - 2>/dev/null || echo "Warning: Failed to copy ~/.gitconfig"
  else
    echo "Note: ~/.gitconfig not found - git identity will need manual configuration"
  fi

  local has_keys=false
  for keyfile in ~/.ssh/id_ed25519 ~/.ssh/id_rsa; do
    if [[ -f "$keyfile" ]]; then
      has_keys=true
      local keyname=$(basename "$keyfile")
      echo "Copying SSH key: $keyname..."
      colima ssh -p "$profile" -- "mkdir -p ~/.ssh && chmod 700 ~/.ssh" 2>/dev/null || true
      cat "$keyfile" | colima ssh -p "$profile" -- "cat > ~/.ssh/$keyname && chmod 600 ~/.ssh/$keyname" 2>/dev/null || echo "Warning: Failed to copy $keyname"
      cat "$keyfile.pub" | colima ssh -p "$profile" -- "cat > ~/.ssh/$keyname.pub" 2>/dev/null || true
    fi
  done
  if [[ "$has_keys" == "false" ]]; then
    echo "Note: No SSH keys found - GitHub SSH access will need manual configuration"
  fi

  if [[ -d ~/.config/gh ]]; then
    echo "Copying ~/.config/gh..."
    colima ssh -p "$profile" -- "mkdir -p ~/.config" 2>/dev/null || true
    tar -C ~/.config -cf - gh | colima ssh -p "$profile" -- tar -C ~/.config -xf - 2>/dev/null || echo "Warning: Failed to copy ~/.config/gh"
  else
    echo "Note: ~/.config/gh not found - run 'gh auth login' for GitHub CLI access"
  fi

  colima ssh -p "$profile" -- "mkdir -p ~/ralph" 2>/dev/null || true
  if [[ -f "$SCRIPT_DIR/ralph-loop.sh" ]]; then
    echo "Copying ralph-loop.sh..."
    cat "$SCRIPT_DIR/ralph-loop.sh" | colima ssh -p "$profile" -- "cat > ~/ralph/loop.sh && chmod +x ~/ralph/loop.sh" 2>/dev/null || echo "Warning: Failed to copy ralph-loop.sh"
  fi

  echo "Auth and scripts copied successfully!"
}

# Detect OS
case "$(uname -s)" in
  Darwin)
    OS="macos"
    ;;
  Linux)
    OS="linux"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)"
    exit 1
    ;;
esac

echo "Creating Ralph VM: $NAME (CPU: $CPU, RAM: ${MEMORY}GB, Disk: ${DISK}GB)"

if [[ "$OS" == "macos" ]]; then
  #############################################################################
  # macOS: Use Colima with profiles
  #############################################################################

  # Check if already exists
  if colima list 2>/dev/null | grep -q "^$NAME "; then
    echo "Error: VM '$NAME' already exists. Delete it first: colima delete $NAME"
    exit 1
  fi

  # Create VM with profile name
  colima start \
    --profile "$NAME" \
    --cpu "$CPU" \
    --memory "$MEMORY" \
    --disk "$DISK" \
    --vm-type vz \
    --mount-type virtiofs \
    --network-address

  echo ""
  echo "VM '$NAME' created successfully!"

  # Copy auth folders to VM
  copy_auth_to_vm_colima "$NAME"

  echo ""
  echo "Next steps:"
  echo "  1. SSH into VM:     colima ssh -p $NAME"
  echo "  2. Install tools:   Run setup-base-vm.sh inside the VM"
  echo "  3. Stop VM:         colima stop -p $NAME"
  echo "  4. Delete VM:       colima delete -p $NAME"

else
  #############################################################################
  # Linux: Use libvirt/QEMU
  #############################################################################

  VM_DIR="${HOME}/vms/wisp"
  BASE_IMAGE="${VM_DIR}/noble-server-cloudimg-amd64.img"

  # Check if already exists
  if virsh list --all --name 2>/dev/null | grep -q "^${NAME}$"; then
    echo "Error: VM '$NAME' already exists. Delete it first:"
    echo "  virsh destroy $NAME 2>/dev/null; virsh undefine $NAME --remove-all-storage"
    exit 1
  fi

  # Ensure base image exists
  if [[ ! -f "$BASE_IMAGE" ]]; then
    echo "Base image not found. Downloading Ubuntu 24.04 cloud image..."
    mkdir -p "$VM_DIR"
    wget -O "$BASE_IMAGE" \
      https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  fi

  # Create disk from base image
  DISK_PATH="${VM_DIR}/${NAME}.qcow2"
  qemu-img create -f qcow2 -F qcow2 -b "$BASE_IMAGE" "$DISK_PATH" "${DISK}G"

  # Create cloud-init config
  CLOUD_INIT_DIR="${VM_DIR}/${NAME}-cloud-init"
  mkdir -p "$CLOUD_INIT_DIR"

  # Get SSH public key
  SSH_KEY=""
  for keyfile in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub; do
    if [[ -f "$keyfile" ]]; then
      SSH_KEY=$(cat "$keyfile")
      break
    fi
  done

  if [[ -z "$SSH_KEY" ]]; then
    echo "Error: No SSH public key found. Run: ssh-keygen -t ed25519"
    exit 1
  fi

  # Create user-data
  cat > "${CLOUD_INIT_DIR}/user-data" << EOF
#cloud-config
hostname: ${NAME}
users:
  - name: dev
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ${SSH_KEY}

package_update: true
packages:
  - git
  - curl
  - wget
  - jq
  - docker.io
  - docker-compose

runcmd:
  - systemctl enable --now docker
  - usermod -aG docker dev
  # Add host.docker.internal alias for compatibility with macOS
  - echo "192.168.122.1 host.docker.internal host.lima.internal" >> /etc/hosts
EOF

  # Create meta-data
  cat > "${CLOUD_INIT_DIR}/meta-data" << EOF
instance-id: ${NAME}
local-hostname: ${NAME}
EOF

  # Create cloud-init ISO
  CLOUD_INIT_ISO="${VM_DIR}/${NAME}-cloud-init.iso"
  cloud-localds "$CLOUD_INIT_ISO" \
    "${CLOUD_INIT_DIR}/user-data" \
    "${CLOUD_INIT_DIR}/meta-data"

  # Create VM
  virt-install \
    --name "$NAME" \
    --memory $((MEMORY * 1024)) \
    --vcpus "$CPU" \
    --disk "path=${DISK_PATH},format=qcow2" \
    --disk "path=${CLOUD_INIT_ISO},device=cdrom" \
    --os-variant ubuntu22.04 \
    --network network=default \
    --graphics none \
    --console pty,target_type=serial \
    --import \
    --noautoconsole

  # Wait for VM to get IP
  echo "Waiting for VM to boot and get IP address..."
  for i in {1..30}; do
    VM_IP=$(virsh domifaddr "$NAME" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
    if [[ -n "$VM_IP" ]]; then
      break
    fi
    sleep 2
  done

  if [[ -z "$VM_IP" ]]; then
    echo "Warning: Could not get VM IP. Check: virsh domifaddr $NAME"
  else
    echo ""
    echo "VM '$NAME' created successfully!"
    echo "IP Address: $VM_IP"

    # Copy auth folders to VM
    copy_auth_to_vm_linux "$VM_IP"

    echo ""
    echo "Next steps:"
    echo "  1. SSH into VM:     ssh dev@$VM_IP"
    echo "  2. Install tools:   Run setup-base-vm.sh inside the VM"
    echo "  3. Stop VM:         virsh shutdown $NAME"
    echo "  4. Delete VM:       virsh destroy $NAME; virsh undefine $NAME --remove-all-storage"
  fi
fi
