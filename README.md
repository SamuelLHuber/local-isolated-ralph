# Local Ralph/Wisp Development Environment

**Humans write specs. Agents ship features.**

Run a workforce of isolated coding agents locally. Write a specification, dispatch it to your Ralph fleet, get notified when it ships. Smithers is required.

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
│  ├── ralph-1 (VM) ──── Smithers workflow ── feat/auth           │
│  ├── ralph-2 (VM) ──── Smithers workflow ── feat/dashboard      │
│  ├── ralph-3 (VM) ──── Smithers workflow ── fix/api-error       │
│  │                                                               │
│  └── ralph-review (VM) ── reviews reports, sends feedback       │
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

### 2. Prepare a task (Spec + TODO)

```bash
# Validate the JSON spec/todo (fabrik auto-minifies on dispatch)
bun run scripts/validate-specs.ts
```

### 3. Launch Smithers

```bash
# Run a Smithers workflow (spec/todo JSON; minified on dispatch)
./dist/fabrik run --spec specs/010-weekly-summary.json --vm ralph-1

# With local project directory synced to VM
./dist/fabrik run --spec specs/010-weekly-summary.json --vm ralph-1 --project ~/projects/my-app

# With iteration limit (stops after 20 Smithers iterations)
./dist/fabrik run --spec specs/010-weekly-summary.json --vm ralph-1 --project ~/projects/my-app --iterations 20

# Or start multiple Ralphs on different specs (fleet)
./dist/fabrik fleet --specs-dir specs --vm-prefix ralph
```

### 4. Watch and wait

```bash
# Grafana for logs/traces
open http://localhost:3010

# Or attach to a VM session directly
# limactl shell <vm> or ssh ralph@<ip>

# Watch for blocked tasks and get desktop notifications
fabrik runs watch --vm ralph-1
```

When done, Smithers writes task outputs into its SQLite db (`.smithers/<spec>.db`) and exits when all tasks are done.

### Desktop notifications

`fabrik runs watch` will send notifications when blocked tasks appear.

Install a notifier:
- macOS: `brew install terminal-notifier`
- Linux: `sudo apt install libnotify-bin` (provides `notify-send`)

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
| [OBSERVABILITY.md](./OBSERVABILITY.md) | Telemetry, logging, tracing, and analytics setup |
| [SETUP-MACOS.md](./SETUP-MACOS.md) | macOS setup with Lima |
| [SETUP-LINUX.md](./SETUP-LINUX.md) | Linux setup with libvirt/QEMU |
| [CI-CD.md](./CI-CD.md) | CI/CD setup with self-hosted runners |
| [dtechvision/laos](https://github.com/dtechvision/laos) | Shared observability stack (external) |
| [specs/templates/](./specs/templates/) | Spec/TODO JSON templates |

## Scripts

| Script | Purpose |
|--------|---------|
| `create-ralph.sh` | Create a new Ralph VM |
| `setup-base-vm.sh` | Install tools inside VM (run once, snapshot) |
| `smithers-fleet.sh` | Dispatch multiple Smithers workflows |
| `smithers-spec-runner.tsx` | Default Smithers workflow for spec/todo |
| `smithers-reviewer.tsx` | Smithers reviewer workflow template |
| `cleanup-workdirs.sh` | Cleanup old immutable workdirs |
| `record-human-feedback.sh` | Record human review decision/notes |
| `list-ralphs.sh` | Show all VMs and status |
| `cleanup-ralphs.sh` | Delete VMs |

## CLI (Fabrik)

Build and run the single binary CLI:

```bash
bun install
bun run build
./dist/fabrik flow
```

### Standalone binary (embedded assets)

The `fabrik` binary embeds:
- default prompts + reviewer prompts
- default Smithers workflows
- helper scripts (dispatch/cleanup/fleet)
- docs (README/WORKFLOW/QUICKSTART/specs README)

If `LOCAL_RALPH_HOME` (or `~/git/local-isolated-ralph`) is missing, `fabrik` writes embedded assets
to `~/.cache/fabrik/embedded/<hash>/` and runs from there.

Common commands:

```bash
# Validate specs in current repo
fabrik spec validate
# Optional: generate minified copies (gitignored)
fabrik spec minify

# Dispatch a run (from another repo)
fabrik run --spec specs/feature.json --vm ralph-1

# Run with custom prompts
fabrik run --spec specs/feature.json --vm ralph-1 \
  --prompt ./prompts/PROMPT-implementer.md \
  --review-prompt ./prompts/PROMPT-reviewer.md

# Run with custom reviewer models + retry cap
fabrik run --spec specs/feature.json --vm ralph-1 \
  --review-max 3 \
  --review-models ./prompts/reviewer-models.json

# Record human feedback
fabrik feedback --vm ralph-1 --spec specs/feature.json --decision approve --notes "OK"

# Fleet
fabrik fleet --specs-dir specs --vm-prefix ralph

# Docs
fabrik docs --topic workflow

# Runs
fabrik runs list --limit 10
fabrik runs show --id 42  # includes failure_reason when available
fabrik runs feedback --id 42 --decision approve --notes "OK"

# Observability stack (LAOS)
fabrik laos up
fabrik laos status
fabrik laos logs --follow
fabrik laos down

# Credentials sync
fabrik credentials sync --vm ralph-1

# Dependency maintenance
fabrik deps check
fabrik deps update --bun
fabrik deps update --smithers
fabrik deps update --bun --smithers
```

Dependency policy:
- Direct deps are pinned (no `latest`/range drift).
- New direct deps require explicit approval.
- CI enforces policy with `bun run deps:policy`.
- Install the local pre-commit hook once: `bun run hooks:install`.

`fabrik laos` clones/pulls `https://github.com/dtechvision/laos` with **jj** (or `git` if jj is missing)
into `~/.cache/fabrik/laos` and runs `docker compose`.

### Use the CLI from another repo

From any repo (e.g. `~/git/<your-repo>`):

```bash
# Build once (in local-ralph)
cd ~/git/local-isolated-ralph
bun install
bun build src/fabrik/bin.ts --compile --outfile dist/fabrik

# Use from another repo
cd ~/git/<your-repo>
~/git/local-isolated-ralph/dist/fabrik spec validate
~/git/local-isolated-ralph/dist/fabrik spec minify
~/git/local-isolated-ralph/dist/fabrik run --spec specs/001-foo.json --vm ralph-1
```

### Binary Releases (GitHub)

The repo ships prebuilt `fabrik` binaries for:
- macOS ARM64 (`darwin-arm64`)
- Linux x64 (`linux-x64`)
- Linux ARM64 (`linux-arm64`)

Release process:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Or trigger the workflow manually with a tag (GitHub Actions UI).

If your local-ralph repo lives elsewhere, set:

```bash
export LOCAL_RALPH_HOME=/path/to/local-isolated-ralph
```

### Smithers (Required Orchestration + JJ)

Smithers is required. Fabrik dispatches minified spec/todo JSON for token efficiency and Smithers executes tasks with durable state. It always runs an agent reviewer and writes review outputs to the Smithers SQLite db (`review_report`, `review_summary`) along with a `human_gate` row for human approval. Version control is JJ (colocated Git backend).

Default models:
- Claude: `opus`
- Codex: `gpt-5.2-codex` (reasoning `medium`, sandbox `danger-full-access`)

PROMPT control:
- Pass `--prompt` to prepend a per-run `PROMPT.md` (implementation instructions).
- Pass `--review-prompt` to prepend reviewer instructions.
These files are prepended before the spec/todo content in Smithers.
Defaults live in `prompts/DEFAULT-IMPLEMENTER.md` and `prompts/DEFAULT-REVIEWER.md`.
Review pipeline (default):
- Security
- Code Quality
- Minimal Simplicity
- Test Coverage
- Maintainability

Reviewer prompts live in `prompts/reviewers/*.md` and are copied into each run.

Reviewer model config (optional):
Create `reviewer-models.json` to map reviewers to models:

```json
{
  "_default": "sonnet",
  "security": "sonnet",
  "code-quality": "sonnet",
  "simplicity": "sonnet",
  "test-coverage": "sonnet",
  "maintainability": "sonnet"
}
```

Backpressure:
- If any reviewer requests changes, Smithers generates follow-up review tasks in the workflow and records them in the SQLite db.
- The review pipeline reruns after review tasks.
- Only when all reviewers approve does the human gate row appear.

Run context audit:
- Each run writes `reports/run-context.json` with prompt contents + hashes.

```bash
# Install in VM if missing
# bun add -g github:evmts/smithers#ea5ece3b156ebd32990ec9c528f9435c601a0403

# Local workflow (uses scripts/smithers-spec-runner.tsx by default)
./dist/fabrik run --spec specs/000-base.json --vm ralph-1

# With custom prompts
./dist/fabrik run --spec specs/000-base.json --vm ralph-1 \
  --prompt ./prompts/PROMPT-implementer.md \
  --review-prompt ./prompts/PROMPT-reviewer.md

# Custom TODO and workflow
./dist/fabrik run --spec specs/010-weekly-summary.json --todo specs/010-weekly-summary.todo.json \
  --workflow scripts/smithers-spec-runner.tsx --model sonnet --vm ralph-1

# Review runs automatically after tasks; Smithers writes review outputs + human gate into the SQLite db.
```

### Smithers Workflow Diagram

```
spec.json + todo.json
   (minified on dispatch)
          │
          ▼
  Smithers workflow
  (Ralph loop in React)
          │
          ├─ task 1 → task_report row
          ├─ task 2 → task_report row
          └─ task N → task_report row
          │
          ▼
     DONE / BLOCKED / FAILED
```

### Reviewer Template (Standalone)

Use the built-in Smithers reviewer workflow:

```bash
./dist/fabrik run --spec specs/feature.json --vm ralph-review --workflow scripts/smithers-reviewer.tsx
```

### JJ Primer (Required VCS)

JJ uses a colocated Git backend. The repo still has `.git`, but you use `jj` commands.

```
Clone:              jj git clone <url> <dir>
Init in repo:       jj git init
Start change:       jj new master
Status:             jj status
Diff:               jj diff
Describe change:    jj describe
Push change:        jj git push --change @
```

Set your JJ identity (recommended):
```bash
jj config set --user user.name "Your Name"
jj config set --user user.email "you@company.com"
```

If JJ identity is missing, fabrik falls back to git identity (if set) or uses defaults.

### Changesets + JJ

Changesets stays the same; JJ only replaces Git commands locally:

```bash
# Create a changeset for your PR
bunx changeset

# Work in a new JJ change
jj new master

# Review + commit
jj status
jj diff
jj describe

# Push the change
jj git push --change @
```

### fabrik run Options

```bash
./dist/fabrik run --spec <path> --vm <vm-name> [--todo <path>] \
  [--project <dir>] [--repo <url>] [--ref <branch>] [--include-git] \
  [--workflow <path>] [--report-dir <path>] [--model <name>] \
  [--prompt <path>] [--review-prompt <path>] [--review-models <path>] [--review-max <n>] \
  [--iterations <n>] [--follow]

# Example with .git included (enables push from synced project)
RALPH_AGENT=pi ./dist/fabrik run --include-git --spec specs/000-base.json --vm ralph-1 --project ~/projects/app --iterations 20
```

- `--include-git` - Include `.git` in sync (otherwise agent must clone from repo URL)
- `--spec` - Spec JSON (minified on dispatch for Smithers mode)
- `--todo` - TODO JSON (minified on dispatch for Smithers mode)
- `--workflow` - Smithers workflow script (default: `scripts/smithers-spec-runner.tsx`)
- `--report-dir` - Report output directory inside VM (default: workdir/reports)
- `--model` - Model name for Smithers agent
- `--prompt` - PROMPT.md prepended to every task prompt
- `--review-prompt` - Reviewer PROMPT.md prepended to review prompt
- `--review-max` - Max review reruns before human gate (default: 2)
- `--review-models` - JSON map of reviewer_id -> model
- `RALPH_AGENT` - Agent to use: `pi` (default), `claude`, `codex`
- `MAX_ITERATIONS` - Max loops (default: 100, 0 = unlimited)

Each dispatch creates a timestamped work directory (`/home/ralph/work/<vm>/<project>-<timestamp>/`), enabling parallel dispatches to the same VM.

Failure reporting:
- `fabrik runs show --id <run-id>` prints `failure_reason` when a run fails (derived from `reports/smithers.log`).
- Stale or missing heartbeats are marked as `failure_reason: stale_process`.

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

Agent auth files are synced to VMs when you run `fabrik credentials sync` (or the bash equivalent).

Required by default (pi):
- `~/.pi/agent/auth.json` (created by `pi` then `/login`)

Optional (only if using `RALPH_AGENT=codex`):
- `~/.codex/auth.json` (created by `codex login`)

Optional (only if using `RALPH_AGENT=claude`):
- `~/.claude` or `~/.claude.json` (created by `claude login` / `claude setup-token`)

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
### Immutable Runs + Local DB

Each Smithers run gets a new workdir. Runs are tracked in a local SQLite DB:

```
~/.cache/ralph/ralph.db
```

Cleanup old runs:

```bash
./scripts/cleanup-workdirs.sh ralph-1 --keep 5
```

Record human feedback:

```bash
./scripts/record-human-feedback.sh --vm ralph-1 --spec specs/010-weekly-summary.json \
  --decision approve --notes "Looks good."
```
Spec is explicit:
- You choose the spec with `--spec`, not inside the prompt.

Context stack now:

```
[
  PROMPT.md (global instructions, if provided),
  spec.json-derived system prompt,
  task.do / task.verify,
  JJ instructions,
  report schema
]
```

Reviewer stack:

```
[
  REVIEW_PROMPT.md (if provided),
  reviewer-specific prompt (from prompts/reviewers/*.md),
  spec.json-derived system prompt,
  Smithers db task_report rows,
  review schema
]
```
