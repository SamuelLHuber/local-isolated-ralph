#!/usr/bin/env bash
#
# Create a new Ralph VM instance using NixOS
# Usage: ./create-ralph.sh <name> [cpu] [memory_gb] [disk_gb]
#
# Options:
#   --local-build    Build image locally instead of downloading
#
# Examples:
#   ./create-ralph.sh ralph-1              # Default: 4 CPU, 6GB RAM, 30GB disk
#   ./create-ralph.sh ralph-2 2 4 20       # Light: 2 CPU, 4GB RAM, 20GB disk
#   ./create-ralph.sh --local-build ralph-3 6 8 50  # Build locally
#
# Environment:
#   RALPH_REPO       GitHub repo for downloading images (owner/repo format)
#                    Auto-detected from git remote if not set
#   RALPH_CACHE_DIR  Where to cache downloaded images (default: ~/.cache/ralph)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NIX_DIR="$(dirname "$SCRIPT_DIR")/nix"
CACHE_DIR="${RALPH_CACHE_DIR:-$HOME/.cache/ralph}"

LOCAL_BUILD=false
if [[ "${1:-}" == "--local-build" ]]; then
  LOCAL_BUILD=true
  shift
fi

NAME="${1:?Usage: $0 [--local-build] <name> [cpu] [memory_gb] [disk_gb]}"
CPU="${2:-4}"
MEMORY="${3:-6}"
DISK="${4:-30}"

detect_arch() {
  local arch
  arch=$(uname -m)
  case "$arch" in
    arm64|aarch64) echo "aarch64-linux" ;;
    x86_64|amd64)  echo "x86_64-linux" ;;
    *)
      echo "Error: Unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac
}

detect_github_repo() {
  if [[ -n "${RALPH_REPO:-}" ]]; then
    echo "$RALPH_REPO"
    return
  fi

  local remote_url
  remote_url=$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || echo "")

  if [[ -z "$remote_url" ]]; then
    echo ""
    return
  fi

  # Extract owner/repo from various URL formats
  if [[ "$remote_url" =~ github\.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo ""
  fi
}

sha256_check() {
  if command -v sha256sum &>/dev/null; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

download_image() {
  local arch="$1"
  local repo="$2"
  local image_name="ralph-${arch}.qcow2"
  local compressed_name="${image_name}.zst"
  local cached_image="$CACHE_DIR/$image_name"
  local cached_compressed="$CACHE_DIR/$compressed_name"

  mkdir -p "$CACHE_DIR"

  local download_url="https://github.com/${repo}/releases/download/latest/${compressed_name}"
  local checksum_url="https://github.com/${repo}/releases/download/latest/${compressed_name}.sha256"

  echo ">>> Checking for cached image..." >&2
  if [[ -f "$cached_image" ]]; then
    echo "    Using cached image." >&2
    echo "$cached_image"
    return 0
  fi

  echo ">>> Downloading NixOS image from GitHub Releases..." >&2
  echo "    URL: $download_url" >&2

  if ! curl -fSL --progress-bar -o "$cached_compressed" "$download_url"; then
    echo "Error: Failed to download image from $download_url" >&2
    echo "" >&2
    echo "Possible causes:" >&2
    echo "  - Repository has no releases yet (push to main to trigger build)" >&2
    echo "  - Repository is private (set up authentication)" >&2
    echo "  - Network issue" >&2
    echo "" >&2
    echo "To build locally instead: $0 --local-build $NAME $CPU $MEMORY $DISK" >&2
    rm -f "$cached_compressed"
    exit 1
  fi

  echo ">>> Downloading checksum..." >&2
  if curl -fSL -o "${cached_compressed}.sha256" "$checksum_url" 2>/dev/null; then
    echo ">>> Verifying checksum..." >&2
    if ! (cd "$CACHE_DIR" && sha256_check -c "${compressed_name}.sha256" >&2); then
      echo "Error: Checksum verification failed!" >&2
      rm -f "$cached_compressed" "${cached_compressed}.sha256"
      exit 1
    fi
  else
    echo "    Warning: No checksum file available, skipping verification" >&2
  fi

  echo ">>> Decompressing image..." >&2
  if command -v zstd &>/dev/null; then
    zstd -d "$cached_compressed" -o "$cached_image" >&2
  elif command -v unzstd &>/dev/null; then
    unzstd "$cached_compressed" -o "$cached_image" >&2
  else
    echo "Error: zstd not installed. Install with: brew install zstd (macOS) or apt install zstd (Linux)" >&2
    exit 1
  fi
  rm -f "$cached_compressed" "${cached_compressed}.sha256"

  echo "$cached_image"
}

build_nixos_image() {
  local format="$1"
  local image_path="${NIX_DIR}/result"

  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo ">>> Checking for Linux builder (required for local builds on macOS)..." >&2
    if ! nix build --dry-run --expr '(import <nixpkgs> { system = "x86_64-linux"; }).hello' 2>/dev/null; then
      echo "Error: No Linux builder available for local builds on macOS." >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  1. Download pre-built image (remove --local-build flag)" >&2
      echo "  2. Set up a Linux builder: nix run nixpkgs#darwin.linux-builder" >&2
      echo "" >&2
      echo "See SETUP-MACOS.md for details." >&2
      exit 1
    fi
  fi

  if [[ ! -L "$image_path" ]] || [[ ! -e "$image_path" ]]; then
    echo ">>> Building NixOS image ($format for $SYSTEM)..." >&2
    echo "    This may take a few minutes on first run..." >&2
    (cd "$NIX_DIR" && nix build ".#packages.${SYSTEM}.${format}" -o result)
  else
    echo ">>> Using cached NixOS image at $image_path" >&2
  fi

  local qcow_file
  qcow_file=$(find "$image_path" -name "*.qcow2" 2>/dev/null | head -1)
  if [[ -z "$qcow_file" ]]; then
    qcow_file="$image_path/nixos.qcow2"
  fi

  if [[ ! -f "$qcow_file" ]]; then
    echo "Error: Could not find QCOW2 image in $image_path" >&2
    exit 1
  fi

  echo "$qcow_file"
}

get_image() {
  if [[ "$LOCAL_BUILD" == "true" ]]; then
    build_nixos_image "qcow"
    return
  fi

  local repo
  repo=$(detect_github_repo)

  if [[ -z "$repo" ]]; then
    echo ">>> No GitHub repository configured, falling back to local build..." >&2
    echo "    (Set RALPH_REPO=owner/repo or add a git remote to enable downloads)" >&2
    build_nixos_image "qcow"
    return
  fi

  download_image "$SYSTEM" "$repo"
}

wait_for_ssh() {
  local host="$1"
  local user="${2:-ralph}"
  local max_attempts="${3:-60}"
  local ssh_opts="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5"

  echo "Waiting for SSH to be ready..."
  for ((i=1; i<=max_attempts; i++)); do
    if ssh $ssh_opts "$user@$host" "echo 'SSH ready'" 2>/dev/null; then
      return 0
    fi
    printf "."
    sleep 2
  done
  echo ""
  echo "Warning: SSH not ready after $((max_attempts * 2)) seconds"
  return 1
}

copy_credentials() {
  local host="$1"
  local user="${2:-ralph}"
  local ssh_opts="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

  echo ""
  echo ">>> Copying credentials to VM..."

  if [[ -d ~/.claude ]]; then
    echo "    Copying ~/.claude..."
    scp $ssh_opts -r ~/.claude "$user@$host:~/" 2>/dev/null || echo "    Warning: Failed to copy ~/.claude"
  else
    echo "    Note: ~/.claude not found (run 'claude auth login' first)"
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
    ssh $ssh_opts "$user@$host" "mkdir -p ~/.config" 2>/dev/null || true
    scp $ssh_opts -r ~/.config/gh "$user@$host:~/.config/" 2>/dev/null || echo "    Warning: Failed to copy ~/.config/gh"
  fi

  echo "    Copying ralph scripts..."
  ssh $ssh_opts "$user@$host" "mkdir -p ~/ralph" 2>/dev/null || true
  if [[ -f "$SCRIPT_DIR/ralph-loop.sh" ]]; then
    scp $ssh_opts "$SCRIPT_DIR/ralph-loop.sh" "$user@$host:~/ralph/loop.sh" 2>/dev/null || echo "    Warning: Failed to copy ralph-loop.sh"
    ssh $ssh_opts "$user@$host" "chmod +x ~/ralph/loop.sh" 2>/dev/null || true
  fi
  if [[ -f "$SCRIPT_DIR/setup-base-vm.sh" ]]; then
    scp $ssh_opts "$SCRIPT_DIR/setup-base-vm.sh" "$user@$host:~/ralph/verify.sh" 2>/dev/null || echo "    Warning: Failed to copy setup-base-vm.sh"
    ssh $ssh_opts "$user@$host" "chmod +x ~/ralph/verify.sh" 2>/dev/null || true
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
    echo "    Note: ~/.claude not found (run 'claude auth login' first)"
  fi

  if [[ -f ~/.gitconfig ]]; then
    echo "    Copying ~/.gitconfig..."
    cat ~/.gitconfig | limactl shell "$vm_name" sudo -u "$user" tee "/home/$user/.gitconfig" > /dev/null 2>&1 || echo "    Warning: Failed to copy ~/.gitconfig"
  fi

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

  echo "    Copying ralph scripts..."
  limactl shell "$vm_name" sudo -u "$user" mkdir -p "/home/$user/ralph" 2>/dev/null || true
  if [[ -f "$SCRIPT_DIR/ralph-loop.sh" ]]; then
    cat "$SCRIPT_DIR/ralph-loop.sh" | limactl shell "$vm_name" sudo -u "$user" tee "/home/$user/ralph/loop.sh" > /dev/null 2>&1 || true
    limactl shell "$vm_name" sudo -u "$user" chmod +x "/home/$user/ralph/loop.sh" 2>/dev/null || true
  fi
  if [[ -f "$SCRIPT_DIR/setup-base-vm.sh" ]]; then
    cat "$SCRIPT_DIR/setup-base-vm.sh" | limactl shell "$vm_name" sudo -u "$user" tee "/home/$user/ralph/verify.sh" > /dev/null 2>&1 || true
    limactl shell "$vm_name" sudo -u "$user" chmod +x "/home/$user/ralph/verify.sh" 2>/dev/null || true
  fi

  echo "Credentials copied."
}

# Detect OS
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)
    echo "Unsupported OS: $(uname -s)"
    exit 1
    ;;
esac

SYSTEM=$(detect_arch)

echo "Creating Ralph VM: $NAME (CPU: $CPU, RAM: ${MEMORY}GB, Disk: ${DISK}GB)"
echo "Architecture: $SYSTEM"

QCOW_IMAGE=$(get_image)
echo ">>> Using NixOS image: $QCOW_IMAGE"

if [[ "$OS" == "macos" ]]; then
  if ! command -v limactl &>/dev/null; then
    echo "Error: Lima not installed. Install with: brew install lima"
    exit 1
  fi

  if limactl list 2>/dev/null | grep -q "^$NAME "; then
    echo "Error: VM '$NAME' already exists. Delete it first: limactl delete $NAME"
    exit 1
  fi

  LIMA_CONFIG=$(mktemp)
  cat > "$LIMA_CONFIG" << EOF
images:
  - location: "$QCOW_IMAGE"
    arch: "$(uname -m | sed 's/arm64/aarch64/')"

cpus: $CPU
memory: "${MEMORY}GiB"
disk: "${DISK}GiB"

vmType: "vz"
rosetta:
  enabled: true

mounts:
  - location: "~/tasks"
    mountPoint: "/mnt/tasks"
    writable: false
  - location: "~/ralph-workspaces"
    mountPoint: "/workspace"
    writable: true

portForwards:
  - guestPort: 9222
    hostPort: 9222
  - guestPort: 3000
    hostPort: 3000
  - guestPort: 8080
    hostPort: 8080

ssh:
  localPort: 0
  loadDotSSHPubKeys: true

user:
  name: ralph
  home: /home/ralph

containerd:
  system: false
  user: false
EOF

  echo ">>> Starting Lima VM..."
  mkdir -p ~/tasks ~/ralph-workspaces
  limactl start "$LIMA_CONFIG" --name "$NAME" --tty=false
  rm "$LIMA_CONFIG"

  echo ""
  echo "VM '$NAME' created successfully!"

  echo "Waiting for VM to be ready..."
  sleep 10

  copy_credentials_lima "$NAME"

  echo ""
  echo "Next steps:"
  echo "  1. Shell into VM:   limactl shell $NAME"
  echo "  2. Run as ralph:    limactl shell $NAME sudo -u ralph -i"
  echo "  3. Stop VM:         limactl stop $NAME"
  echo "  4. Start VM:        limactl start $NAME"
  echo "  5. Delete VM:       limactl delete $NAME"
  echo ""
  echo "Cleanup commands:"
  echo "  List all VMs:       limactl list"
  echo "  Delete this VM:     limactl delete $NAME"
  echo "  Delete all VMs:     limactl delete --all"
  echo "  Clear image cache:  rm -rf ~/.cache/ralph/"

else
  if ! command -v virsh &>/dev/null; then
    echo "Error: libvirt not installed. Install with: sudo apt install libvirt-daemon-system virtinst"
    exit 1
  fi

  if virsh list --all --name 2>/dev/null | grep -q "^${NAME}$"; then
    echo "Error: VM '$NAME' already exists. Delete it first:"
    echo "  virsh destroy $NAME 2>/dev/null; virsh undefine $NAME --remove-all-storage"
    exit 1
  fi

  VM_DIR="${HOME}/vms/ralph"
  mkdir -p "$VM_DIR"

  DISK_PATH="${VM_DIR}/${NAME}.qcow2"
  echo ">>> Creating disk from NixOS image..."
  cp "$QCOW_IMAGE" "$DISK_PATH"
  qemu-img resize "$DISK_PATH" "${DISK}G"

  echo ">>> Creating VM with libvirt..."
  virt-install \
    --name "$NAME" \
    --memory $((MEMORY * 1024)) \
    --vcpus "$CPU" \
    --disk "path=${DISK_PATH},format=qcow2" \
    --os-variant nixos-unstable \
    --network network=default \
    --graphics none \
    --console pty,target_type=serial \
    --import \
    --noautoconsole

  echo "Waiting for VM to boot and get IP address..."
  VM_IP=""
  for i in {1..60}; do
    VM_IP=$(virsh domifaddr "$NAME" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
    if [[ -n "$VM_IP" ]]; then
      break
    fi
    sleep 2
  done

  if [[ -z "$VM_IP" ]]; then
    echo "Warning: Could not get VM IP. Check: virsh domifaddr $NAME"
    echo ""
    echo "VM '$NAME' created but IP not detected."
    echo "Try: virsh console $NAME"
  else
    echo ""
    echo "VM '$NAME' created successfully!"
    echo "IP Address: $VM_IP"

    if wait_for_ssh "$VM_IP"; then
      copy_credentials "$VM_IP"
    fi

    echo ""
    echo "Next steps:"
    echo "  1. SSH into VM:     ssh ralph@$VM_IP"
    echo "  2. Stop VM:         virsh shutdown $NAME"
    echo "  3. Start VM:        virsh start $NAME"
    echo "  4. Delete VM:       virsh destroy $NAME; virsh undefine $NAME --remove-all-storage"
    echo ""
    echo "Cleanup commands:"
    echo "  List all VMs:       virsh list --all"
    echo "  Delete this VM:     virsh destroy $NAME 2>/dev/null; virsh undefine $NAME --remove-all-storage"
    echo "  Clear image cache:  rm -rf ~/.cache/ralph/"
  fi
fi
