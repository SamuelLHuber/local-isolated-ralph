# Linux Setup Guide

This guide sets up isolated VMs using libvirt/QEMU for running Ralph agents safely. Supports running multiple VMs in parallel.

## Prerequisites

- Linux with KVM support: `lscpu | grep Virtualization`
- Docker installed on host (for telemetry stack)
- SSH key: `ls ~/.ssh/id_rsa.pub || ssh-keygen -t rsa -b 4096`
- Ubuntu 22.04+, Fedora 38+, or Arch Linux

**Resource requirements per VM:**

| Workload | CPU | RAM | Disk |
|----------|-----|-----|------|
| Light | 2 | 4GB | 20GB |
| Medium | 4 | 6GB | 30GB |
| Heavy | 6 | 8GB | 50GB |

## 1. Install Dependencies

### Ubuntu/Debian

```bash
sudo apt-get update
sudo apt-get install -y \
  qemu-kvm \
  libvirt-daemon-system \
  libvirt-clients \
  virtinst \
  bridge-utils \
  cloud-image-utils

# Add user to groups
sudo usermod -aG libvirt,kvm $USER
newgrp libvirt

# Start libvirtd and default network
sudo systemctl enable --now libvirtd
sudo virsh net-start default 2>/dev/null || true
sudo virsh net-autostart default

# Verify
virsh list --all
```

### Fedora/RHEL

```bash
sudo dnf install -y @virtualization cloud-utils
sudo systemctl enable --now libvirtd
sudo usermod -aG libvirt $USER
newgrp libvirt
```

### Arch Linux

```bash
sudo pacman -S qemu-full libvirt virt-install dnsmasq bridge-utils
sudo systemctl enable --now libvirtd
sudo usermod -aG libvirt $USER
newgrp libvirt
```

## 2. Download Base Image (One Time)

```bash
mkdir -p ~/vms/wisp
cd ~/vms/wisp

# Download Ubuntu 24.04 cloud image
wget -c https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img

# Verify
ls -lh noble-server-cloudimg-amd64.img
```

## 3. Create Your First Ralph VM

### Quick method (using script)

```bash
# From local-setup directory
./scripts/create-ralph.sh ralph-1

# With custom resources
./scripts/create-ralph.sh ralph-1 4 6 30  # 4 CPU, 6GB RAM, 30GB disk
```

### Manual method

```bash
VM_NAME="ralph-1"
CPU=4
MEMORY=6  # GB
DISK=30   # GB

cd ~/vms/wisp

# Create disk from base image
qemu-img create -f qcow2 -F qcow2 \
  -b noble-server-cloudimg-amd64.img \
  ${VM_NAME}.qcow2 ${DISK}G

# Create cloud-init config
mkdir -p ${VM_NAME}-cloud-init
cat > ${VM_NAME}-cloud-init/user-data << EOF
#cloud-config
hostname: ${VM_NAME}
users:
  - name: dev
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat ~/.ssh/id_rsa.pub 2>/dev/null || cat ~/.ssh/id_ed25519.pub)

packages:
  - git
  - curl
  - wget
  - jq
  - docker.io

runcmd:
  - systemctl enable --now docker
  - usermod -aG docker dev
  - echo "192.168.122.1 host.docker.internal host.lima.internal" >> /etc/hosts
EOF

cat > ${VM_NAME}-cloud-init/meta-data << EOF
instance-id: ${VM_NAME}
local-hostname: ${VM_NAME}
EOF

# Create cloud-init ISO
cloud-localds ${VM_NAME}-cloud-init.iso \
  ${VM_NAME}-cloud-init/user-data \
  ${VM_NAME}-cloud-init/meta-data

# Create VM
virt-install \
  --name ${VM_NAME} \
  --memory $((MEMORY * 1024)) \
  --vcpus ${CPU} \
  --disk path=${VM_NAME}.qcow2,format=qcow2 \
  --disk path=${VM_NAME}-cloud-init.iso,device=cdrom \
  --os-variant ubuntu22.04 \
  --network network=default \
  --graphics none \
  --console pty,target_type=serial \
  --import \
  --noautoconsole

# Wait for IP
echo "Waiting for VM to boot..."
sleep 20
virsh domifaddr ${VM_NAME}
```

### Get VM IP and connect

```bash
# Get IP
VM_IP=$(virsh domifaddr ralph-1 | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
echo "VM IP: $VM_IP"

# SSH in
ssh dev@$VM_IP
```

## 4. Install Tools Inside the VM

```bash
VM_IP=$(virsh domifaddr ralph-1 | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
ssh dev@$VM_IP

# Inside VM: Install Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20

# Install Claude CLI
npm install -g @anthropic-ai/claude-code

# Install Playwright + Chromium
npm install -g playwright
npx playwright install --with-deps chromium

# Authenticate Claude (opens browser - may need to copy URL)
claude auth login

exit
```

## 5. Configure Networking (VM → Host)

The host is reachable at `192.168.122.1` (default libvirt gateway):

```bash
ssh dev@$VM_IP

# Test connectivity
curl http://192.168.122.1:3000/api/health   # Grafana
curl http://192.168.122.1:3100/ready        # Loki

# host.docker.internal was added by cloud-init, verify:
ping -c1 host.docker.internal

# Set up environment variables
cat >> ~/.bashrc << 'EOF'

# Host telemetry endpoints
export HOST_ADDR="192.168.122.1"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://${HOST_ADDR}:4317"
export LOKI_URL="http://${HOST_ADDR}:3100"
export GRAFANA_URL="http://${HOST_ADDR}:3000"
EOF

source ~/.bashrc
exit
```

### If VMs can't reach host

```bash
# On host: Allow traffic from libvirt network
sudo ufw allow in on virbr0
# Or for iptables:
sudo iptables -I INPUT -i virbr0 -j ACCEPT
```

## 6. Chrome DevTools Setup

```bash
ssh dev@$VM_IP

# Create launcher script
cat > ~/start-chrome-debug.sh << 'EOF'
#!/bin/bash
chromium-browser \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  --headless=new \
  "$@"
EOF
chmod +x ~/start-chrome-debug.sh

exit
```

### Forward DevTools port to host

```bash
# Forward port 9222 from ralph-1 to localhost:9222
VM_IP=$(virsh domifaddr ralph-1 | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
ssh -L 9222:localhost:9222 dev@$VM_IP -N &

# Access DevTools at: chrome://inspect or http://localhost:9222
```

## 7. Running Multiple Ralphs in Parallel

### Create a fleet of VMs

```bash
# Create 4 worker VMs (runs sequentially, ~30s each)
for i in 1 2 3 4; do
  ./scripts/create-ralph.sh ralph-$i 4 6 30
done

# List all VMs
./scripts/list-ralphs.sh
# Or: virsh list --all
```

### Get IPs for all VMs

```bash
# Helper function
get_ralph_ip() {
  virsh domifaddr "$1" 2>/dev/null | grep ipv4 | awk '{print $4}' | cut -d/ -f1
}

# Get all IPs
for vm in ralph-1 ralph-2 ralph-3 ralph-4; do
  echo "$vm: $(get_ralph_ip $vm)"
done
```

### Port mapping for multiple VMs

Each VM's Chrome DevTools needs a unique host port:

```bash
# Forward DevTools for each VM to different host ports
for i in 1 2 3 4; do
  VM_IP=$(get_ralph_ip ralph-$i)
  LOCAL_PORT=$((9221 + i))  # 9222, 9223, 9224, 9225
  ssh -L ${LOCAL_PORT}:localhost:9222 dev@${VM_IP} -N &
  echo "ralph-$i DevTools: localhost:${LOCAL_PORT}"
done
```

### Dispatch tasks to the fleet

```bash
# Run tasks in parallel (each in background)
./scripts/dispatch.sh ralph-1 ~/tasks/feature-a/PROMPT.md &
./scripts/dispatch.sh ralph-2 ~/tasks/feature-b/PROMPT.md &
./scripts/dispatch.sh ralph-3 ~/tasks/bugfix-c/PROMPT.md &
./scripts/dispatch.sh ralph-4 ~/tasks/refactor-d/PROMPT.md &

# Wait for all to complete
wait
```

### Monitor all Ralphs

```bash
# View logs from all Ralphs in Grafana
xdg-open "http://localhost:3000/explore?query={job=\"ralph\"}"

# Filter by specific VM in Loki:
# {job="ralph", vm="ralph-1"}
```

## 8. Create a Template VM (Fast Cloning)

Set up one VM completely, then clone it:

```bash
# 1. Create and configure template
./scripts/create-ralph.sh ralph-template 4 6 30
# ... install all tools, authenticate Claude ...

# 2. Shut down and create snapshot
virsh shutdown ralph-template
virsh snapshot-create-as ralph-template ready-to-use

# 3. Clone from template (fast - uses copy-on-write)
clone_ralph() {
  local NAME=$1
  local TEMPLATE="ralph-template"

  virt-clone \
    --original $TEMPLATE \
    --name $NAME \
    --auto-clone

  # Update hostname in the clone
  virsh start $NAME
  sleep 10
  VM_IP=$(virsh domifaddr $NAME | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
  ssh dev@$VM_IP "sudo hostnamectl set-hostname $NAME"
}

# Create workers from template (~5s each vs ~30s)
for i in 1 2 3 4; do
  clone_ralph ralph-$i
done
```

## 9. Cleanup & Teardown

### Stop VMs (preserves state)

```bash
# Stop one VM
virsh shutdown ralph-1

# Stop all Ralph VMs
for vm in $(virsh list --name | grep ralph); do
  virsh shutdown $vm
done
```

### Delete VMs (removes completely)

```bash
# Delete one VM
virsh destroy ralph-1 2>/dev/null  # Force stop if running
virsh undefine ralph-1 --remove-all-storage

# Delete specific VMs
./scripts/cleanup-ralphs.sh ralph-1 ralph-2

# Delete all Ralph VMs
./scripts/cleanup-ralphs.sh --all

# Delete all without confirmation
./scripts/cleanup-ralphs.sh --all --force
```

### Full cleanup (nuclear)

```bash
# Delete ALL Ralph VMs
for vm in $(virsh list --all --name | grep ralph); do
  virsh destroy $vm 2>/dev/null
  virsh undefine $vm --remove-all-storage
done

# Remove VM directory
rm -rf ~/vms/wisp

# Stop telemetry stack
cd telemetry && docker compose down -v
```

## Quick Reference

### Single VM Commands

| Task | Command |
|------|---------|
| Create VM | `./scripts/create-ralph.sh ralph-1` |
| Start VM | `virsh start ralph-1` |
| Stop VM | `virsh shutdown ralph-1` |
| Force stop | `virsh destroy ralph-1` |
| SSH into VM | `ssh dev@$(virsh domifaddr ralph-1 \| grep ipv4 \| awk '{print $4}' \| cut -d/ -f1)` |
| Delete VM | `virsh undefine ralph-1 --remove-all-storage` |
| Get IP | `virsh domifaddr ralph-1` |

### Multi-VM Commands

| Task | Command |
|------|---------|
| List all VMs | `./scripts/list-ralphs.sh` or `virsh list --all` |
| Create fleet | `for i in 1 2 3 4; do ./scripts/create-ralph.sh ralph-$i; done` |
| Stop all | `for vm in $(virsh list --name \| grep ralph); do virsh shutdown $vm; done` |
| Delete all | `./scripts/cleanup-ralphs.sh --all` |

### Snapshots

| Task | Command |
|------|---------|
| Create snapshot | `virsh snapshot-create-as ralph-1 NAME` |
| List snapshots | `virsh snapshot-list ralph-1` |
| Restore snapshot | `virsh snapshot-revert ralph-1 NAME` |
| Delete snapshot | `virsh snapshot-delete ralph-1 NAME` |

## Troubleshooting

### VM won't start

```bash
# Check libvirt logs
journalctl -u libvirtd -f

# Verify default network is running
virsh net-list
virsh net-start default
```

### Can't get VM IP

```bash
# Check VM is running
virsh list

# Wait longer (cloud-init may be slow)
sleep 30 && virsh domifaddr ralph-1

# Check DHCP leases
sudo cat /var/lib/libvirt/dnsmasq/default.leases
```

### VMs can't reach host telemetry

```bash
# Check host firewall
sudo ufw status
sudo iptables -L -n | grep virbr0

# Allow libvirt network
sudo ufw allow in on virbr0

# Verify telemetry is listening on all interfaces
ss -tlnp | grep -E '3000|3100|9090'
```

### Out of disk space

```bash
# Check disk usage
df -h ~/vms/wisp

# Check VM disk sizes
ls -lh ~/vms/wisp/*.qcow2

# Compact a qcow2 image (after deleting files inside VM)
qemu-img convert -O qcow2 ralph-1.qcow2 ralph-1-compact.qcow2
mv ralph-1-compact.qcow2 ralph-1.qcow2
```

### Slow parallel VM creation

```bash
# Use template cloning (see section 8) for faster scaling
# Or pre-download and cache cloud-init packages in the base image
```
