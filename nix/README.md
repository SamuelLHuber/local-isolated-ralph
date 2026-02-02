# Ralph NixOS Configuration

Reproducible, declarative Ralph agent environments that work everywhere.

## What's Included

Three coding agent CLIs, all installed via **Bun**:

| Agent | Package | Command | Description |
|-------|---------|---------|-------------|
| **Claude Code** | `@anthropic-ai/claude-code` | `claude` | Anthropic's CLI agent |
| **Codex** | `@openai/codex` | `codex` | OpenAI's CLI agent |
| **OpenCode** | `opencode-ai@latest` | `opencode` | Open-source agent |

Plus browser automation (Chromium + Playwright) for MCP tools.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│           modules/ralph.nix (single source of truth)            │
│                                                                 │
│  • Bun (package manager)                                        │
│  • Claude Code, Codex, OpenCode (agent CLIs)                    │
│  • Chromium + Playwright (browser automation)                   │
│  • Autonomous mode configs (bypass prompts)                     │
└─────────────────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   Lima VM (macOS)      Docker Image (k8s)      Bare Metal/Cloud
   local dev            agent swarm             NixOS clusters
```

## Security Model

Ralph runs coding agents with **full autonomous permissions** - they can execute any command, modify any file, and access the network without prompts. This is intentional for unattended operation.

### Why This Is Safe

```
┌─────────────────────────────────────────────────────────────────┐
│                         HOST MACHINE                             │
│  (your laptop/server - PROTECTED)                               │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │              ISOLATED VM / CONTAINER                     │   │
│   │  (Ralph sandbox - agents can do ANYTHING here)          │   │
│   │                                                         │   │
│   │   • Full filesystem access (inside VM only)             │   │
│   │   • Network access (can be restricted)                  │   │
│   │   • Root/sudo privileges                                │   │
│   │   • Docker-in-Docker                                    │   │
│   │                                                         │   │
│   │   Agents CANNOT:                                        │   │
│   │   • Access host filesystem                              │   │
│   │   • Access host network services (unless forwarded)     │   │
│   │   • Escape the VM/container boundary                    │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Isolation Guarantees

| Deployment | Isolation Tech | Boundary |
|------------|----------------|----------|
| Lima VM (macOS) | Apple Virtualization.framework | Hardware VM |
| Docker | Linux namespaces + cgroups | Container |
| Cloud VM | Hypervisor (KVM/Xen) | Hardware VM |
| Bare Metal | Physical machine | Air-gapped |

### What Agents CAN Do (inside sandbox)

- Execute arbitrary shell commands
- Read/write/delete any file
- Install packages via apt/bun/npm
- Run Docker containers
- Access the internet
- Use full CPU/RAM allocation

### What Agents CANNOT Do

- Access host filesystem (unless explicitly mounted)
- Affect other VMs/containers
- Survive VM deletion (ephemeral by design)
- Access host credentials (unless explicitly passed)

## Quick Start

### Prerequisites

```bash
# Install Nix (Determinate Systems installer recommended)
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh

# Or official installer
sh <(curl -L https://nixos.org/nix/install)

# Enable flakes (if not using Determinate installer)
mkdir -p ~/.config/nix
echo "experimental-features = nix-command flakes" >> ~/.config/nix/nix.conf
```

### Build a VM Image

```bash
cd nix

# Build QCOW2 image for Lima/QEMU (aarch64 for Apple Silicon)
nix build .#packages.aarch64-linux.qcow

# Or x86_64 for Intel/AMD
nix build .#packages.x86_64-linux.qcow

# Build Docker image for k8s
nix build .#packages.aarch64-linux.docker
```

### Run Locally with Lima

```bash
# Option 1: Use the Lima template
limactl start ./lima/ralph.yaml --name ralph-1

# Option 2: Use a pre-built image
nix build .#packages.aarch64-linux.qcow
limactl start ./result/nixos.qcow2 --name ralph-1 --vm-type vz

# SSH into the VM
limactl shell ralph-1

# Verify agents are installed
which claude codex opencode
```

### Deploy to Kubernetes

```bash
# Build Docker image
nix build .#packages.aarch64-linux.docker
docker load < result

# Tag and push
docker tag nixos-ralph:latest your-registry/ralph:latest
docker push your-registry/ralph:latest

# Deploy fleet
kubectl apply -f k8s/ralph-fleet.yaml
kubectl scale deployment ralph-agents --replicas=10
```

## Directory Structure

```
nix/
├── flake.nix              # Main flake - defines all build targets
├── flake.lock             # Pinned dependencies (reproducibility)
├── README.md              # This file
│
├── modules/
│   └── ralph.nix          # Core Ralph module - THE source of truth
│                          # Defines: bun, agent CLIs, browser, configs
│
├── hosts/
│   ├── vm.nix             # VM-specific (Lima, QEMU, libvirt)
│   ├── container.nix      # Container-specific (Docker, k8s pods)
│   └── cloud.nix          # Cloud VM (AWS, GCP, Azure)
│
├── lima/
│   └── ralph.yaml         # Lima VM definition for macOS
│
└── k8s/
    └── ralph-fleet.yaml   # Kubernetes deployment manifests
```

## Configuration Options

The Ralph module (`modules/ralph.nix`) exposes these options:

### Core Options

| Option | Default | Description |
|--------|---------|-------------|
| `services.ralph.enable` | `false` | Enable Ralph environment |
| `services.ralph.user` | `"ralph"` | User account for agent |
| `services.ralph.stateDir` | `/var/lib/ralph` | State directory |
| `services.ralph.autonomousMode` | `true` | Bypass permission prompts |

### Agent Selection

| Option | Default | Description |
|--------|---------|-------------|
| `services.ralph.agents.claude` | `true` | Install Claude Code |
| `services.ralph.agents.codex` | `true` | Install OpenAI Codex |
| `services.ralph.agents.opencode` | `true` | Install OpenCode AI |
| `services.ralph.agents.smithers` | `true` | Install Smithers orchestrator |

### Browser Support

| Option | Default | Description |
|--------|---------|-------------|
| `services.ralph.browser.enable` | `false` | Install Chromium/Playwright |
| `services.ralph.browser.remoteDebugging` | `false` | Chrome DevTools on :9222 |

### Telemetry

| Option | Default | Description |
|--------|---------|-------------|
| `services.ralph.telemetry.enable` | `false` | Send logs/traces |
| `services.ralph.telemetry.hostAddr` | `host.lima.internal` | Telemetry endpoint |

## Build Targets

| Target | Command | Output | Use Case |
|--------|---------|--------|----------|
| `qcow` | `nix build .#qcow` | QCOW2 disk image | Lima, QEMU, libvirt |
| `raw` | `nix build .#raw` | Raw disk image | Direct boot |
| `docker` | `nix build .#docker` | Docker image | Kubernetes, Docker |
| `iso` | `nix build .#iso` | Bootable ISO | Bare metal install |
| `amazon` | `nix build .#amazon` | EC2 AMI | AWS |
| `gce` | `nix build .#gce` | GCE image | Google Cloud |

## Autonomous Mode

When `autonomousMode = true` (default), agents run without permission prompts.

> **SAFETY**: This is only safe because agents run in **isolated VMs/containers** that cannot affect your host machine.

### Configuration Files (auto-generated)

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

**Codex** (`~/.codex/config.toml`):
```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

### CLI Flags (used by systemd services)

| Agent | CLI Flag | Alias |
|-------|----------|-------|
| **Claude Code** | `--dangerously-skip-permissions` | - |
| **Codex** | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |
| **OpenCode** | *(uses config file only)* | - |

### How It Works

The Ralph systemd services automatically select the correct flag:

```bash
# Set via environment variable
RALPH_AGENT=claude   # uses --dangerously-skip-permissions
RALPH_AGENT=codex    # uses --dangerously-bypass-approvals-and-sandbox
RALPH_AGENT=opencode # no flag needed (config-based)
```

### Manual Invocation

If running agents manually inside a Ralph VM:

```bash
# Claude Code
claude --dangerously-skip-permissions -p "$(cat PROMPT.md)"

# Codex (full flag)
codex --dangerously-bypass-approvals-and-sandbox -p "$(cat PROMPT.md)"

# Codex (short alias)
codex --yolo -p "$(cat PROMPT.md)"

# OpenCode (config file handles permissions)
opencode -p "$(cat PROMPT.md)"
```

## Customizing

### Add More Packages

```nix
# In your own configuration
{ config, pkgs, ... }:
{
  imports = [ ./modules/ralph.nix ];

  services.ralph = {
    enable = true;
    browser.enable = true;
  };

  # Add project-specific tools
  environment.systemPackages = with pkgs; [
    python3
    rustc
    cargo
    go
  ];
}
```

### Disable Specific Agents

```nix
services.ralph = {
  enable = true;
  agents = {
    claude = true;
    codex = false;   # Don't install Codex
    opencode = true;
  };
};
```

### Custom Telemetry

```nix
services.ralph.telemetry = {
  enable = true;
  hostAddr = "telemetry.your-domain.com";
};
```

## Scaling

### Local Development (1-4 agents)

```bash
# Start multiple Lima VMs
for i in 1 2 3 4; do
  limactl start ./lima/ralph.yaml --name ralph-$i &
done
wait

# List running VMs
limactl list
```

### Team/CI (10-50 agents)

```bash
# Kubernetes deployment
kubectl apply -f k8s/ralph-fleet.yaml
kubectl scale deployment ralph-agents --replicas=20

# Monitor
kubectl logs -f -l app=ralph -n ralph-system
```

### Enterprise (100+ agents)

Deploy NixOS to bare metal or cloud VMs:

```bash
# Each machine pulls and applies the same config
nixos-rebuild switch --flake github:your-org/ralph-infra#ralph

# Or use fleet management (colmena, deploy-rs, etc.)
colmena apply
```

## Updating

```bash
# Update flake inputs (nixpkgs, etc.)
nix flake update

# Update agent CLIs (inside a running VM)
bun update -g @anthropic-ai/claude-code @openai/codex opencode-ai

# Rebuild images
nix build .#qcow .#docker

# Update running VMs
limactl shell ralph-1 -- sudo nixos-rebuild switch
```

## Troubleshooting

### Agents not in PATH

```bash
# Ensure bun's bin is in PATH
echo $PATH | grep -q ".bun/bin" || export PATH="$HOME/.bun/bin:$PATH"

# Re-run installer if needed
install-agent-clis
```

### VM won't start on Apple Silicon

```bash
# Ensure you're building for aarch64
nix build .#packages.aarch64-linux.qcow

# Check Lima supports vz
limactl info | grep vmType
```

### Slow first boot

First boot installs agent CLIs from npm - this takes 1-2 minutes. Subsequent boots are instant.

### Check agent installation status

```bash
systemctl status ralph-install-agents
journalctl -u ralph-install-agents
```

## Why Bun?

- **Fast**: Installs packages 10-100x faster than npm
- **Compatible**: Works with npm registry and packages
- **Simple**: Single binary, no node_modules complexity for global installs
- **Runtime**: Can also run JS/TS directly if needed

## Related

- [Local Ralph Setup](../README.md) - Original shell-script based setup
- [Telemetry Stack](../telemetry/README.md) - Grafana/Loki/Tempo observability
- [Workflow Guide](../WORKFLOW.md) - Multi-agent coordination patterns
