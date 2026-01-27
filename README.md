# Local Ralph/Wisp Development Environment

**Humans write specs. Agents ship features.**

Run a workforce of isolated coding agents locally. Write a specification, dispatch it to your Ralph fleet, get notified when it ships.

## The Vision

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   Human writes spec ──► Ralphs implement ──► Ralphs review ──►     │
│                                │                  │                 │
│                                └──── iterate ─────┘                 │
│                                         │                           │
│                                         ▼                           │
│                              "Feature X shipped" ──► Human          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

You stay in the loop for:
- Writing specifications
- Answering questions when agents get stuck
- Receiving "shipped" notifications

Agents handle:
- Implementation
- Code review (agent-to-agent)
- Iteration on feedback
- PR creation

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Host Machine                                                    │
│  ├── LAOS (Grafana/Loki/Tempo/Prometheus/Sentry/PostHog) ◄──     │
│  │   all agents report here                                     │
│  ├── Message queue (filesystem) ◄── agents coordinate           │
│  │                                                               │
│  ├── ralph-1 (VM) ──── branch: feat/auth                        │
│  ├── ralph-2 (VM) ──── branch: feat/dashboard                   │
│  ├── ralph-3 (VM) ──── branch: fix/api-error                    │
│  │                                                               │
│  └── ralph-review (VM) ── reviews PRs, sends feedback           │
└──────────────────────────────────────────────────────────────────┘
```

Each VM has the repo cloned and works on its own branch. For advanced parallel work, use [Jujutsu (jj)](https://github.com/martinvonz/jj) which handles multiple changes natively.

## Quick Start

### 1. Setup infrastructure

```bash
# Start LAOS (shared host observability stack)
# Source of truth: https://github.com/dtechvision/laos
mkdir -p ~/git
if [[ -d ~/git/laos/.git ]]; then
  (cd ~/git/laos && git pull)
else
  git clone https://github.com/dtechvision/laos.git ~/git/laos
fi
cd ~/git/laos
docker compose up -d

# Optional: create a shared env file so LAOS endpoints get copied into VMs
cd /path/to/local-isolated-ralph
./scripts/create-ralph-env.sh
# Edit ~/.config/ralph/ralph.env and set:
# macOS (Lima):  LAOS_HOST=host.lima.internal
# Linux (libvirt): LAOS_HOST=192.168.122.1

# Create VMs (4 implementers + 1 reviewer)
for i in 1 2 3 4; do ./scripts/create-ralph.sh ralph-$i 2 4 20; done
./scripts/create-ralph.sh ralph-review 2 4 20

# Setup base image in one VM, then snapshot for cloning
./scripts/setup-base-vm.sh  # Run inside VM
```

### 2. Prepare a task

```bash
# Create a task directory with your spec
mkdir -p ~/tasks/my-feature
cat > ~/tasks/my-feature/PROMPT.md << 'EOF'
# Task: Add user authentication

## Specification
- Add login/logout endpoints
- Use JWT tokens
- Store users in PostgreSQL

## Instructions
1. Clone the repo and create a feature branch
2. Implement the feature
3. Write tests
4. Create a PR when done
EOF
```

### 3. Launch Ralph

```bash
# Start a single Ralph (defaults to 100 max iterations)
./scripts/dispatch.sh ralph-1 ~/tasks/my-feature/PROMPT.md

# With local project directory synced to VM
./scripts/dispatch.sh ralph-1 ~/tasks/my-feature/PROMPT.md ~/projects/my-app

# With iteration limit (stops after 20 loops or DONE/BLOCKED)
./scripts/dispatch.sh ralph-1 ~/tasks/my-feature/PROMPT.md ~/projects/my-app 20

# Or start multiple Ralphs on different tasks
./scripts/ralph-fleet.sh ~/tasks/

# View agents in tmux
tmux attach -t ralph-fleet
# Ctrl+B, N/P to switch between agents
```

### 4. Watch and wait

```bash
# Grafana for logs/traces
open http://localhost:3010

# Or attach to specific Ralph
tmux attach -t ralph-fleet:ralph-1
```

When done, agents output:
```json
{"status": "DONE", "summary": "Implemented auth with JWT", "pr": "feat/auth"}
```

## Workflows

| Pattern | Use Case | Setup |
|---------|----------|-------|
| **Single Ralph** | One feature at a time | 1 VM, feature branch |
| **Multi-Ralph Fleet** | Parallel features | N VMs, each on own branch |
| **Multi-Ralph per VM** | Resource constrained | 2-4 Ralphs in 1 VM |
| **Implementer + Reviewer** | Reduce human review | Agents review each other |

See **[WORKFLOW.md](./WORKFLOW.md)** for detailed patterns.

## Documentation

| Document | Description |
|----------|-------------|
| [QUICKSTART.md](./QUICKSTART.md) | End-to-end tutorial |
| [WORKFLOW.md](./WORKFLOW.md) | Workflow patterns, multi-agent coordination |
| [SETUP-MACOS.md](./SETUP-MACOS.md) | macOS setup with Colima |
| [SETUP-LINUX.md](./SETUP-LINUX.md) | Linux setup with libvirt/QEMU |
| [dtechvision/laos](https://github.com/dtechvision/laos) | Shared observability stack |
| [prompts/](./prompts/) | Prompt templates (implementer, reviewer) |

## Scripts

| Script | Purpose |
|--------|---------|
| `dispatch.sh` | Send task to VM and run loop (see options below) |
| `create-ralph.sh` | Create a new Ralph VM |
| `setup-base-vm.sh` | Install tools inside VM (run once, snapshot) |
| `ralph-loop.sh` | Core loop script with state tracking (runs inside VM) |
| `ralph-start.sh` | Start single Ralph in tmux |
| `ralph-fleet.sh` | Start fleet from tasks directory |
| `ralph-multi.sh` | Run multiple Ralphs in one VM |
| `list-ralphs.sh` | Show all VMs and status |
| `cleanup-ralphs.sh` | Delete VMs |

### dispatch.sh Options

```bash
./scripts/dispatch.sh [--include-git] <vm-name> <prompt-file> [project-dir] [max-iterations]

# Example with .git included (enables push from synced project)
RALPH_AGENT=codex ./scripts/dispatch.sh --include-git ralph-1 ~/tasks/PROMPT.md ~/projects/app 20
```

- `--include-git` - Include `.git` in sync (otherwise agent must clone from repo URL)
- `RALPH_AGENT` - Agent to use: `claude` (default), `codex`, `opencode`
- `MAX_ITERATIONS` - Max loops (default: 100, 0 = unlimited)

## Resource Planning

| Host RAM | Recommended Setup |
|----------|-------------------|
| 16GB | 4 light VMs (2 CPU, 4GB each) |
| 32GB | 8 light VMs or 4 medium VMs |
| 64GB+ | 8+ medium VMs, or density mode |

**Density mode:** Run 2-4 Ralphs per VM when working on separate directories.

## Credentials Setup

Agents need `GITHUB_TOKEN` to push code and create PRs.

1. Create token: https://github.com/settings/tokens/new (scopes: `repo`, `workflow`)
2. Add to `~/.config/ralph/ralph.env`:
   ```bash
   export GITHUB_TOKEN="ghp_your_token_here"
   ```
3. Run `./scripts/create-ralph-env.sh` to create the env file, or `./scripts/sync-credentials.sh <vm>` to update existing VMs

The token is used by both `git push/pull` (credential helper) and `gh` CLI (auto-detects env var).

## Prerequisites

```bash
# Docker (for LAOS)
docker --version

# SSH key (for VM access)
ls ~/.ssh/id_rsa.pub || ssh-keygen -t rsa -b 4096

# macOS: Colima 0.6+
brew install colima docker

# Linux: libvirt + KVM
sudo apt install qemu-kvm libvirt-daemon-system virtinst
```

## The Goal

```
Before:  Human writes code, human reviews code, human ships
After:   Human writes spec ──────────────────► Human gets "shipped" notification
                           (agents do the rest)
```

## Disk Usage

Disk usage to watch:
  - ~/.lima/ - VM disks (20GB+ per VM)
  - ~/.cache/ralph/ - Downloaded images (~6GB per
  architecture)
  - ~/vms/ralph/ - libvirt VM disks on Linux

For the cloud-hosted version of this, see [Sprites](https://sprites.dev) + [Wisp](https://github.com/thruflo/wisp).
