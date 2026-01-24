# macOS Setup Guide

This guide sets up isolated NixOS VMs using Lima for running Ralph agents. All tools are pre-installed via Nix.

## Prerequisites

- macOS 13+ (Ventura or later)
- Nix package manager with flakes enabled
- SSH key: `ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519`

**Resource requirements per VM:**

| Workload | CPU | RAM | Disk |
|----------|-----|-----|------|
| Light | 2 | 4GB | 20GB |
| Medium | 4 | 6GB | 30GB |
| Heavy | 6 | 8GB | 50GB |

## 1. Install Dependencies

```bash
# Install Nix (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install

# Install Lima
brew install lima

# Verify
nix --version
limactl --version
```

## 2. Set Up a Linux Builder

Building NixOS images on macOS requires a Linux builder VM. Without this, `nix build` cannot compile Linux packages.

### Option A: Use nix-darwin (Recommended if you use nix-darwin)

Add to your `darwin-configuration.nix`:

```nix
nix.linux-builder = {
  enable = true;
  ephemeral = true;
  maxJobs = 4;
  config = {
    virtualisation.cores = 4;
    virtualisation.memorySize = 8192;
  };
};
```

Then rebuild: `darwin-rebuild switch`

### Option B: Standalone Linux Builder VM

If you don't use nix-darwin, create a dedicated builder VM with Nix installed:

```bash
# Create a Linux VM (uses Ubuntu by default)
limactl create --name=nix-builder template://default --cpus=4 --memory=8
limactl start nix-builder

# Install Nix inside the VM
limactl shell nix-builder -- sh -c 'curl --proto "=https" --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install'

# The VM needs to be accessible via SSH. Get the port:
BUILDER_PORT=$(limactl list nix-builder --format '{{.SSHLocalPort}}')
echo "Builder SSH port: $BUILDER_PORT"

# Add builder to Nix config (replace PORT with actual port)
cat >> ~/.config/nix/nix.conf << EOF
builders = ssh://127.0.0.1:${BUILDER_PORT} aarch64-linux - 4 1 big-parallel
builders-use-substitutes = true
EOF

# Restart nix-daemon to pick up new config
sudo launchctl kickstart -k system/org.nixos.nix-daemon
```

### Option C: Use a Remote Linux Machine

If you have a Linux server available:

```bash
# Add to ~/.config/nix/nix.conf
cat >> ~/.config/nix/nix.conf << EOF
builders = ssh://user@linux-host aarch64-linux /path/to/ssh-key 4 1 big-parallel,kvm
builders-use-substitutes = true
EOF

# Restart nix-daemon
sudo launchctl kickstart -k system/org.nixos.nix-daemon
```

### Verify Builder Works

```bash
# Test that Linux builds work
nix build --system aarch64-linux nixpkgs#hello
```

## 3. Create Your First Ralph VM

The `create-ralph.sh` script builds a NixOS image (if needed) and creates a VM with all tools pre-installed.

```bash
# Create VM (builds NixOS image on first run - takes a few minutes)
./scripts/create-ralph.sh ralph-1

# With custom resources
./scripts/create-ralph.sh ralph-1 4 6 30  # 4 CPU, 6GB RAM, 30GB disk
```

The script will:
1. Build the NixOS QCOW2 image from `nix/flake.nix`
2. Create a Lima VM with the image
3. Copy credentials from host (~/.claude, ~/.ssh, ~/.gitconfig, ~/.config/gh)
4. Copy ralph-loop.sh to the VM

### Verify VM is running

```bash
limactl list                  # Shows all VMs
limactl info ralph-1          # Details of specific VM
```

## 4. Set Up Claude Authentication

On macOS, Claude stores credentials in the system keychain. These don't automatically transfer to VMs. You have two options:

### Option A: API Key (Recommended for VMs)

Set the `ANTHROPIC_API_KEY` environment variable in the VM:

```bash
# Get your API key from https://console.anthropic.com/
limactl shell ralph-1 sudo -u ralph -i

# Add to shell profile
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
```

### Option B: Long-lived Token

Generate a token that persists across sessions:

```bash
# On host (macOS), generate a token
claude setup-token

# This creates ~/.claude/.credentials.json
# Copy it to the VM
tar -C ~ -cf - .claude/.credentials.json | \
  limactl shell ralph-1 sudo -u ralph tar -C /home/ralph -xf -
```

### Verify auth works

```bash
limactl shell ralph-1 sudo -u ralph -i -- ~/ralph/verify.sh
```

## 5. Access the VM

```bash
# Shell into VM (as default user)
limactl shell ralph-1

# Run as ralph user
limactl shell ralph-1 sudo -u ralph -i

# Verify tools are installed
limactl shell ralph-1 sudo -u ralph -i -- claude --version
limactl shell ralph-1 sudo -u ralph -i -- jj version
```

### First-time setup

On first boot, agent CLIs are installed via systemd. Check status:

```bash
limactl shell ralph-1 sudo systemctl status ralph-install-agents
```

If needed, manually trigger installation:

```bash
limactl shell ralph-1 sudo -u ralph install-agent-clis
```

## 6. Verify Setup

Run the verification script inside the VM:

```bash
limactl shell ralph-1 sudo -u ralph ~/ralph/verify.sh
```

This checks:
- All tools installed (git, jj, claude, node, bun, etc.)
- Credentials copied (claude auth, git config, ssh keys)
- Ralph loop script present

## 7. Configure Networking (VM → Host)

Inside the VM, the host is reachable at `host.lima.internal`:

```bash
limactl shell ralph-1

# Test connectivity to host telemetry
curl http://host.lima.internal:3000/api/health   # Grafana
curl http://host.lima.internal:3100/ready        # Loki
```

Environment variables are pre-configured in the NixOS image.

## 8. Running Multiple Ralphs in Parallel

### Create a fleet of VMs

```bash
# Create 4 worker VMs
for i in 1 2 3 4; do
  ./scripts/create-ralph.sh ralph-$i 4 6 30
done

# List all VMs
./scripts/list-ralphs.sh
```

### Port mapping for multiple VMs

Each VM's Chrome DevTools needs a unique host port (configured by NixOS):

```bash
# Forward DevTools for each VM to different host ports
limactl shell ralph-1 -- -L 9222:localhost:9222 -N &
limactl shell ralph-2 -- -L 9223:localhost:9222 -N &
```

### Dispatch tasks to the fleet

```bash
./scripts/dispatch.sh ralph-1 ~/tasks/feature-a/PROMPT.md &
./scripts/dispatch.sh ralph-2 ~/tasks/feature-b/PROMPT.md &
wait
```

## 9. Cleanup & Teardown

### Stop VMs (preserves state)

```bash
limactl stop ralph-1

# Stop all Ralph VMs
limactl list | grep ralph | awk '{print $1}' | xargs -I{} limactl stop {}
```

### Delete VMs

```bash
limactl delete ralph-1

# Delete all Ralph VMs
./scripts/cleanup-ralphs.sh --all
```

## Quick Reference

| Task | Command |
|------|---------|
| Create VM | `./scripts/create-ralph.sh ralph-1` |
| Start VM | `limactl start ralph-1` |
| Stop VM | `limactl stop ralph-1` |
| Shell into VM | `limactl shell ralph-1` |
| Run as ralph | `limactl shell ralph-1 sudo -u ralph -i` |
| Delete VM | `limactl delete ralph-1` |
| List VMs | `limactl list` |
| Rebuild NixOS image | `cd nix && rm -f result && nix build .#qcow` |

## Troubleshooting

### NixOS image build fails

If you see errors like `required system 'aarch64-linux' not available`:

```bash
# You need a Linux builder - see Section 2
# Check if builder is configured
nix show-config | grep builders

# Test with a simple build
nix build --system aarch64-linux nixpkgs#hello
```

### VM won't start

```bash
# Check Lima logs
limactl logs ralph-1

# Try with QEMU instead of vz
limactl delete ralph-1
# Edit the generated lima config to use vmType: qemu
```

### Tools not installed

```bash
# Run the agent installer manually
limactl shell ralph-1 sudo -u ralph install-agent-clis

# Check systemd service
limactl shell ralph-1 sudo journalctl -u ralph-install-agents
```

### Credentials not copied

Re-run the create script credentials copy:

```bash
# Or manually copy
tar -C ~ -cf - .claude | limactl shell ralph-1 sudo -u ralph tar -C /home/ralph -xf -
```

### Rebuild NixOS image

```bash
cd nix
rm -f result
nix build .#qcow
```
