# Linux Setup Guide

This guide sets up isolated NixOS VMs using libvirt/QEMU for running Ralph agents. All tools are pre-installed via Nix.

## Prerequisites

- Linux with KVM support: `lscpu | grep Virtualization`
- Nix package manager with flakes enabled
- SSH key: `ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519`

**Resource requirements per VM:**

| Workload | CPU | RAM | Disk |
|----------|-----|-----|------|
| Light | 2 | 4GB | 20GB |
| Medium | 4 | 6GB | 30GB |
| Heavy | 6 | 8GB | 50GB |

## 1. Install Dependencies

### Install Nix

```bash
# Install Nix with flakes enabled
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
```

### Install libvirt/QEMU

#### Ubuntu/Debian

```bash
sudo apt-get update
sudo apt-get install -y \
  qemu-kvm \
  libvirt-daemon-system \
  libvirt-clients \
  virtinst \
  bridge-utils

sudo usermod -aG libvirt,kvm $USER
newgrp libvirt

sudo systemctl enable --now libvirtd
sudo virsh net-start default 2>/dev/null || true
sudo virsh net-autostart default
```

#### Fedora/RHEL

```bash
sudo dnf install -y @virtualization
sudo systemctl enable --now libvirtd
sudo usermod -aG libvirt $USER
newgrp libvirt
```

#### Arch Linux

```bash
sudo pacman -S qemu-full libvirt virt-install dnsmasq bridge-utils
sudo systemctl enable --now libvirtd
sudo usermod -aG libvirt $USER
newgrp libvirt
```

### Verify

```bash
nix --version
virsh list --all
```

## 2. Create Your First Ralph VM

The `create-ralph.sh` script builds a NixOS image (if needed) and creates a VM with all tools pre-installed.

```bash
# Create VM (builds NixOS image on first run - takes a few minutes)
./scripts/create-ralph.sh ralph-1

# With custom resources
./scripts/create-ralph.sh ralph-1 4 6 30  # 4 CPU, 6GB RAM, 30GB disk
```

The script will:
1. Build the NixOS QCOW2 image from `nix/flake.nix`
2. Create a libvirt VM with the image
3. Copy credentials from host (~/.codex/auth.json, ~/.local/share/opencode/auth.json, ~/.claude, ~/.claude.json, ~/.ssh, ~/.gitconfig, ~/.config/gh)
4. Copy ralph-loop.sh to the VM

### Get VM IP and connect

```bash
# Get IP
VM_IP=$(virsh domifaddr ralph-1 | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
echo "VM IP: $VM_IP"

# SSH in
ssh ralph@$VM_IP
```

## 3. Set Up Claude Authentication

Claude credentials from your host don't automatically transfer to VMs. You have two options:

### Option A: API Key (Recommended for VMs)

Set the `ANTHROPIC_API_KEY` environment variable in the VM:

```bash
# Get your API key from https://console.anthropic.com/
VM_IP=$(virsh domifaddr ralph-1 | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
ssh ralph@$VM_IP

# Add to shell profile
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
```

### Option B: Long-lived Token

Generate a token that persists across sessions:

```bash
# On host, generate a token
claude setup-token

# Optional: OpenCode auth (only if using opencode)
opencode auth login

# Put the token in ralph.env so it can be synced to VMs
./scripts/create-ralph-env.sh
# Edit ~/.config/ralph/ralph.env and set:
# export CLAUDE_CODE_OAUTH_TOKEN="..."

# Sync credentials to the VM
./scripts/sync-credentials.sh ralph-1
# Or via the CLI
fabrik credentials sync --vm ralph-1
```

### Verify auth works

```bash
ssh ralph@$VM_IP "~/ralph/verify.sh"
```

## 4. Access the VM

```bash
# Get VM IP
VM_IP=$(virsh domifaddr ralph-1 | grep ipv4 | awk '{print $4}' | cut -d/ -f1)

# SSH as ralph user
ssh ralph@$VM_IP

# Verify tools are installed
ssh ralph@$VM_IP "claude --version"
ssh ralph@$VM_IP "jj version"
```

### First-time setup

On first boot, agent CLIs are installed via systemd. Check status:

```bash
ssh ralph@$VM_IP "sudo systemctl status ralph-install-agents"
```

If needed, manually trigger installation:

```bash
ssh ralph@$VM_IP "install-agent-clis"
```

## 5. Verify Setup

Run the verification script inside the VM:

```bash
ssh ralph@$VM_IP "bash ~/scripts/setup-base-vm.sh"
```

This checks:
- All tools installed (git, jj, claude, node, bun, etc.)
- Credentials copied (claude auth, git config, ssh keys)
- Ralph loop script present

## 6. Configure Networking (VM → Host)

The host is reachable at `192.168.122.1` (default libvirt gateway):

```bash
ssh ralph@$VM_IP

# Test connectivity to LAOS on host
curl http://192.168.122.1:3010/api/health   # Grafana
curl http://192.168.122.1:3100/ready        # Loki
curl http://192.168.122.1:3200/ready        # Tempo
```

LAOS source of truth: https://github.com/dtechvision/laos

Set env vars in the VM or project to point to LAOS on the host (recommended: use `./scripts/create-ralph-env.sh` and re-sync credentials):

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://192.168.122.1:4317"
export LOKI_URL="http://192.168.122.1:3100"
export SENTRY_DSN="http://<key>@192.168.122.1:9000/1"
export POSTHOG_HOST="http://192.168.122.1:8001"
export POSTHOG_API_KEY="phc_xxx"
```

### If VMs can't reach host

```bash
# On host: Allow traffic from libvirt network
sudo ufw allow in on virbr0
# Or for iptables:
sudo iptables -I INPUT -i virbr0 -j ACCEPT
```

## 7. Running Multiple Ralphs in Parallel

### Create a fleet of VMs

```bash
# Create 4 worker VMs
for i in 1 2 3 4; do
  ./scripts/create-ralph.sh ralph-$i 4 6 30
done

# List all VMs
./scripts/list-ralphs.sh
# Or: virsh list --all
```

### Get IPs for all VMs

```bash
get_ralph_ip() {
  virsh domifaddr "$1" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1
}

for vm in ralph-1 ralph-2 ralph-3 ralph-4; do
  echo "$vm: $(get_ralph_ip $vm)"
done
```

### Dispatch tasks to the fleet

```bash
# Basic dispatch (100 max iterations by default)
./scripts/dispatch.sh ralph-1 ~/tasks/feature-a/PROMPT.md &
./scripts/dispatch.sh ralph-2 ~/tasks/feature-b/PROMPT.md &
wait

# With local project and iteration limit
./scripts/dispatch.sh ralph-1 ~/tasks/feature-a/PROMPT.md ~/projects/my-app 20
```

## 8. Create a Template VM (Fast Cloning)

Set up one VM completely, then clone it:

```bash
# 1. Create and configure template
./scripts/create-ralph.sh ralph-template 4 6 30

# 2. Shut down and create snapshot
virsh shutdown ralph-template
virsh snapshot-create-as ralph-template ready-to-use

# 3. Clone from template
clone_ralph() {
  local NAME=$1
  virt-clone --original ralph-template --name $NAME --auto-clone
  virsh start $NAME
}

for i in 1 2 3 4; do
  clone_ralph ralph-$i
done
```

## 9. Cleanup & Teardown

### Stop VMs

```bash
virsh shutdown ralph-1

# Stop all Ralph VMs
for vm in $(virsh list --name | grep ralph); do
  virsh shutdown $vm
done
```

### Delete VMs

```bash
virsh destroy ralph-1 2>/dev/null
virsh undefine ralph-1 --remove-all-storage

# Delete all Ralph VMs
./scripts/cleanup-ralphs.sh --all
```

## Quick Reference

| Task | Command |
|------|---------|
| Create VM | `./scripts/create-ralph.sh ralph-1` |
| Start VM | `virsh start ralph-1` |
| Stop VM | `virsh shutdown ralph-1` |
| Force stop | `virsh destroy ralph-1` |
| SSH into VM | `ssh ralph@$(virsh domifaddr ralph-1 \| grep ipv4 \| awk '{print $4}' \| cut -d/ -f1)` |
| Delete VM | `virsh undefine ralph-1 --remove-all-storage` |
| Get IP | `virsh domifaddr ralph-1` |
| List VMs | `virsh list --all` |
| Rebuild NixOS image | `cd nix && rm -f result && nix build .#qcow` |

## Troubleshooting

### VM won't start

```bash
journalctl -u libvirtd -f

# Verify default network is running
virsh net-list
virsh net-start default
```

### Can't get VM IP

```bash
# Wait longer (NixOS boot may take a moment)
sleep 30 && virsh domifaddr ralph-1

# Check DHCP leases
sudo cat /var/lib/libvirt/dnsmasq/default.leases
```

### Tools not installed

```bash
# Run the agent installer manually
ssh ralph@$VM_IP "install-agent-clis"

# Check systemd service
ssh ralph@$VM_IP "sudo journalctl -u ralph-install-agents"
```

### Rebuild NixOS image

```bash
cd nix
rm -f result
nix build .#qcow
```
