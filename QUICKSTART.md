# Compound Engineering: Quickstart

**Prerequisite**: Complete platform-specific setup first (SETUP-MACOS.md or SETUP-LINUX.md).

**Implicit Assumption**: All commands run from `local-isolated-ralph` directory unless specified otherwise.

---

## 1. Pre-flight Check

```bash
# Agent authentication
pi --version        # Must be installed
pi /login           # Run once, creates ~/.pi/agent/auth.json

# GitHub Token (for push/PR)
export GITHUB_TOKEN="ghp_..."   # Or in ~/.config/ralph/ralph.env

# Optional: Alternative agents
# codex login        # Only if RALPH_AGENT=codex
# claude auth login  # Only if RALPH_AGENT=claude
```

**Implicit Assumption**: Without `GITHUB_TOKEN`, the agent cannot push branches. Workflow will block.

---

## 2. Start LAOS (Observability)

```bash
fabrik laos up
fabrik laos status   # Must show "healthy"
```

**Implicit Assumption**: LAOS runs on localhost:3010 (Grafana). Agent sends logs there.

---

## 3. Create VM

```bash
fabrik laos up                              # 1. Observability
./scripts/create-ralph.sh ralph-1 4 8 30    # 2. VM (4 CPU, 8GB RAM, 30GB disk)
./scripts/setup-base-vm.sh                  # 3. Setup (run INSIDE the VM)
```

**Implicit Assumption**: `setup-base-vm.sh` must run INSIDE the VM, not on the host.

**macOS**: `colima ssh -p ralph-1`
**Linux**: `ssh ralph@$(virsh domifaddr ralph-1 | grep ipv4 | awk '{print $4}' | cut -d/ -f1)`

---

## 4. Compound Engineering Workflow

**Principle**: 80% Planning, 20% Execution

### Phase 1: Create Spec (40%)

```bash
# Output interview guide (self-contained, no external files needed)
./dist/fabrik spec interview | tee /tmp/interview-prompt.txt

# Run with agent, Output: specs/feature.json
cat /tmp/interview-prompt.txt | claude-code

# Validate
./dist/fabrik spec validate
```

**Critical**: Spec must exist before Todo. Order is binding.

### Phase 2: Generate Todo (40%)

```bash
# Output todo guide
./dist/fabrik todo generate | tee /tmp/todo-prompt.txt

# Run with agent, Input: specs/feature.json, Output: specs/feature.todo.json
cat /tmp/todo-prompt.txt | claude-code

# Validate
./dist/fabrik spec validate
```

**Implicit Assumption**: Todo without Spec is invalid. Link via identical `id`.

### Phase 3: Dispatch Workflow (20%)

```bash
# Single run
./dist/fabrik run \
  --spec specs/feature.json \
  --todo specs/feature.todo.json \
  --vm ralph-1 \
  --project /path/to/target/repo    # Optional: target repo outside VM
```

**Implicit Assumption**: `--project` copies repo into VM. Agent works there, not on host.

---

## 5. Monitoring

```bash
# Terminal 1: Watch
./dist/fabrik runs watch --vm ralph-1

# Browser: Grafana
open http://localhost:3010

# Check status
./dist/fabrik runs list --vm ralph-1
./dist/fabrik runs show --id <run-id>
```

**Implicit Assumption**: `runs watch` requires `terminal-notifier` (macOS) or `libnotify-bin` (Linux) for desktop notifications.

---

## 6. Human Gate (Review)

After 8 reviewers (automatic) → Human Gate:

```bash
# Approve or reject
./dist/fabrik feedback \
  --vm ralph-1 \
  --spec specs/feature.json \
  --decision approve \
  --notes "Implementation correct, tests pass"
```

**Implicit Assumption**: Without explicit feedback, run stays `blocked`. No automatic timeout.

---

## Summary: The Compound Cycle

```
┌────────────────────────────────────────────────────────────────┐
│  80% PLANNING                                                  │
│  ├── fabrik spec interview  → specs/feature.json              │
│  └── fabrik todo generate     → specs/feature.todo.json       │
├────────────────────────────────────────────────────────────────┤
│  20% EXECUTION                                                 │
│  └── fabrik run --spec ... --todo ... --vm ralph-1             │
│      └── 8 Reviewers → Human Gate → Done                       │
└────────────────────────────────────────────────────────────────┘
```

**Compound Effect**: Each completed cycle makes the next faster (reusable patterns, established reviewers).

---

## Troubleshooting

| Symptom | Cause | Solution |
|---------|-------|----------|
| "token in default is invalid" | GITHUB_TOKEN missing/invalid | `export GITHUB_TOKEN=...` or in `ralph.env` |
| "blocked" forever | Human Gate waiting | `fabrik feedback --decision approve ...` |
| "stale_process" | VM heartbeat timeout | Check VM: `fabrik runs show --id <id>` |
| Reviewers find nothing | Prompt missing | Check reviewer prompts in `prompts/reviewers/` |

---

## Command Reference

| Command | Purpose |
|---------|---------|
| `fabrik spec interview` | 10-question interview guide (self-contained) |
| `fabrik todo generate` | Todo generation guide (self-contained) |
| `fabrik spec validate` | Validate Spec/Todo JSON |
| `fabrik run --spec X --todo Y --vm Z` | Workflow dispatch |
| `fabrik runs watch --vm Z` | Desktop notifications on block |
| `fabrik feedback --vm Z --spec X --decision approve` | Release Human Gate |
| `fabrik laos up/status/down` | Observability stack |

---

## Implicit Assumptions (Critical)

1. **Agent-Auth**: `~/.pi/agent/auth.json` exists (created via `pi /login`)
2. **GitHub Token**: `GITHUB_TOKEN` is set (for push/PR)
3. **LAOS**: Running on localhost:3010 (logs/metrics)
4. **VM**: `ralph-1` exists and is reachable
5. **Network**: VMs can reach GitHub (for clone/push)
6. **Disk**: VM has sufficient space for repo + dependencies
7. **Order**: Spec → Todo → Run (binding)
8. **Human Gate**: Must explicitly confirm (no auto-approve)
