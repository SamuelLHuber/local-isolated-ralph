# macOS Setup Guide

This guide sets up isolated VMs using Colima for running Ralph agents safely. Supports running multiple VMs in parallel.

## Prerequisites

- macOS 13+ (Ventura or later) for `--vm-type vz`
- Homebrew installed
- Docker installed on host (for telemetry stack)
- SSH key: `ls ~/.ssh/id_rsa.pub || ssh-keygen -t rsa -b 4096`

**Resource requirements per VM:**

| Workload | CPU | RAM | Disk |
|----------|-----|-----|------|
| Light | 2 | 4GB | 20GB |
| Medium | 4 | 6GB | 30GB |
| Heavy | 6 | 8GB | 50GB |

## 1. Install Dependencies

```bash
# Install Colima and Docker CLI
brew install colima docker docker-compose

# Verify installation
colima version  # Should be 0.6.0+
docker --version
```

## 2. Create Your First Ralph VM

### Quick method (using script)

```bash
# From local-setup directory
./scripts/create-ralph.sh ralph-1

# With custom resources
./scripts/create-ralph.sh ralph-1 4 6 30  # 4 CPU, 6GB RAM, 30GB disk
```

### Manual method

```bash
# Create VM with profile name
colima start \
  --profile ralph-1 \
  --cpu 4 \
  --memory 6 \
  --disk 30 \
  --vm-type vz \
  --mount-type virtiofs \
  --network-address
```

**Options explained:**
- `--profile ralph-1`: Names this VM instance (allows multiple VMs)
- `--vm-type vz`: Apple Virtualization.framework (fast, efficient)
- `--mount-type virtiofs`: Fast file sharing
- `--network-address`: Stable IP for the VM

### Verify VM is running

```bash
colima list                  # Shows all VMs
colima status -p ralph-1     # Status of specific VM
```

## 3. Install Tools Inside the VM

```bash
# Enter the VM
colima ssh -p ralph-1

# Inside VM: Update and install packages
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y git curl wget jq docker.io

# Enable Docker
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker

# Install Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20

# Install Claude CLI
npm install -g @anthropic-ai/claude-code

# Install Playwright + Chromium
npm install -g playwright
npx playwright install --with-deps chromium

# Authenticate Claude (opens browser on host)
claude auth login

exit
```

## 4. Configure Networking (VM → Host)

Inside Colima VMs, reach the host at `host.lima.internal`:

```bash
colima ssh -p ralph-1

# Test connectivity to host telemetry
curl http://host.lima.internal:3000/api/health   # Grafana
curl http://host.lima.internal:3100/ready        # Loki
curl http://host.lima.internal:4317              # Tempo OTLP

# Set up environment variables
cat >> ~/.bashrc << 'EOF'

# Host telemetry endpoints
export HOST_ADDR="host.lima.internal"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://${HOST_ADDR}:4317"
export LOKI_URL="http://${HOST_ADDR}:3100"
export GRAFANA_URL="http://${HOST_ADDR}:3000"
EOF

source ~/.bashrc
exit
```

> **Note:** `host.docker.internal` works inside Docker containers running in the VM, but when SSH'd directly into the Lima VM, use `host.lima.internal`.

## 5. Chrome DevTools Setup

```bash
colima ssh -p ralph-1

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
colima ssh -p ralph-1 -- -L 9222:localhost:9222 -N &

# Access DevTools at: chrome://inspect or http://localhost:9222
```

## 6. Running Multiple Ralphs in Parallel

### Create a fleet of VMs

```bash
# Create 4 worker VMs (runs sequentially, ~30s each)
for i in 1 2 3 4; do
  ./scripts/create-ralph.sh ralph-$i 4 6 30
done

# List all VMs
./scripts/list-ralphs.sh
```

### Port mapping for multiple VMs

Each VM's Chrome DevTools needs a unique host port:

```bash
# Forward DevTools for each VM to different host ports
colima ssh -p ralph-1 -- -L 9222:localhost:9222 -N &
colima ssh -p ralph-2 -- -L 9223:localhost:9222 -N &
colima ssh -p ralph-3 -- -L 9224:localhost:9222 -N &
colima ssh -p ralph-4 -- -L 9225:localhost:9222 -N &
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
open "http://localhost:3000/explore?query={job=\"ralph\"}"

# Filter by specific VM
# Loki query: {job="ralph", vm="ralph-1"}
```

## 7. Create a Template VM (Fast Cloning)

Set up one VM completely, then clone it for faster scaling:

```bash
# 1. Create and fully configure a template VM
./scripts/create-ralph.sh ralph-template 4 6 30
# ... install all tools, authenticate Claude, etc.

# 2. Stop and snapshot the template
colima stop -p ralph-template
colima snapshot create -p ralph-template ready-to-use

# 3. Create workers from template (future improvement - currently need to create fresh)
# For now, use the create script which is fast enough (~30s per VM)
```

## 8. Cleanup & Teardown

### Stop VMs (preserves state)

```bash
# Stop one VM
colima stop -p ralph-1

# Stop all Ralph VMs
colima list | grep ralph | awk '{print $1}' | xargs -I{} colima stop -p {}
```

### Delete VMs (removes completely)

```bash
# Delete one VM
colima delete -p ralph-1

# Delete specific VMs
./scripts/cleanup-ralphs.sh ralph-1 ralph-2

# Delete all Ralph VMs
./scripts/cleanup-ralphs.sh --all

# Delete all without confirmation
./scripts/cleanup-ralphs.sh --all --force
```

### Full cleanup (nuclear)

```bash
# Delete ALL Colima VMs (including non-Ralph ones)
colima delete --force
rm -rf ~/.colima

# Stop telemetry stack
cd telemetry && docker compose down -v
```

## Quick Reference

### Single VM Commands

| Task | Command |
|------|---------|
| Create VM | `./scripts/create-ralph.sh ralph-1` |
| Start VM | `colima start -p ralph-1` |
| Stop VM | `colima stop -p ralph-1` |
| SSH into VM | `colima ssh -p ralph-1` |
| Delete VM | `colima delete -p ralph-1` |
| VM status | `colima status -p ralph-1` |

### Multi-VM Commands

| Task | Command |
|------|---------|
| List all VMs | `./scripts/list-ralphs.sh` |
| Create fleet | `for i in 1 2 3 4; do ./scripts/create-ralph.sh ralph-$i; done` |
| Stop all | `colima list \| grep ralph \| awk '{print $1}' \| xargs -I{} colima stop -p {}` |
| Delete all | `./scripts/cleanup-ralphs.sh --all` |

### Snapshots

| Task | Command |
|------|---------|
| Create snapshot | `colima stop -p ralph-1 && colima snapshot create -p ralph-1 NAME` |
| List snapshots | `colima snapshot list -p ralph-1` |
| Restore snapshot | `colima snapshot restore -p ralph-1 NAME` |

## Troubleshooting

### VM won't start with vz

```bash
# Fall back to QEMU (slower but more compatible)
colima start -p ralph-1 --vm-type qemu --cpu 4 --memory 6 --disk 30
```

### Can't reach host.lima.internal

```bash
# Inside VM, find the gateway IP
ip route | grep default | awk '{print $3}'

# Add to /etc/hosts if needed
echo "$(ip route | grep default | awk '{print $3}') host.lima.internal host.docker.internal" | sudo tee -a /etc/hosts
```

### Out of disk space

```bash
# Check disk usage inside VM
colima ssh -p ralph-1 -- df -h

# Recreate with larger disk
colima delete -p ralph-1
./scripts/create-ralph.sh ralph-1 4 6 50  # 50GB disk
```

### VM is slow

```bash
# Check host resources
top -l 1 | head -10

# Reduce parallel VMs or increase per-VM resources
colima stop -p ralph-1
colima start -p ralph-1 --cpu 6 --memory 8
```
