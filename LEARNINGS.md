# Fabrik Learnings

## Quick Reference

### Workflow Selection

| Flag | Workflow | Use Case |
|------|----------|----------|
| *(none)* | `workflow.tsx` | Small-to-medium specs (5-20 tasks) with clear milestones |
| `--dynamic` | `workflow-dynamic.tsx` | Large evolving projects (>20 tasks), discovers tickets at runtime |
| `--workflow <path>` | Custom | Your own workflow implementation |

### Usage

```bash
# Default: sequential implementation with full review loop
fabrik run --spec specs/feature.md --project ~/my-app --vm ralph-1

# Dynamic: runtime ticket discovery for large specs
fabrik run --spec specs/big-prd.md --project ~/my-app --vm ralph-1 --dynamic

# Custom workflow
fabrik run --spec specs/feature.md --project ~/my-app --vm ralph-1 --workflow ./my-workflow.tsx
```

---

## Credentials Setup (Critical)

### The `export` Keyword is Required

**Root cause of 401 errors**: Variables in `~/.config/ralph/ralph.env` must use `export` to be inherited by child processes.

```bash
# ❌ WRONG - variable set but not exported
FIREWORKS_API_KEY=fw_xxx

# ✅ CORRECT - variable exported to child processes
export FIREWORKS_API_KEY=fw_xxx
```

**Why it matters**: PiAgent spawns `pi` CLI as a child process. Without `export`, the child doesn't inherit the variables → "No API key found" → 401 error.

### Validate Your ralph.env

```bash
# Check if variables are exported
./scripts/validate-ralph-env.sh

# Manual check
source ~/.config/ralph/ralph.env
env | grep -E 'FIREWORKS|MOONSHOT|GITHUB'

# Should show variables. If empty, they're not exported.
```

### Required Credentials

| Variable | Purpose | Provider |
|----------|---------|----------|
| `export GITHUB_TOKEN=ghp_...` | Push to GitHub, create PRs | github.com/settings/tokens (scopes: `repo`, `workflow`) |
| `export FIREWORKS_API_KEY=fw_...` | Pi agent with Kimi | fireworks.ai |
| `export API_KEY_MOONSHOT=sk-...` | Pi agent alternative | platform.moonshot.cn |
| `export ANTHROPIC_API_KEY=...` | Claude agent | console.anthropic.com |

### Dispatch Sourcing

The dispatch script sources `ralph.env` with `set -a` which auto-exports:

```bash
set -a; source ~/.config/ralph/ralph.env; set +a
```

This ensures all variables are exported regardless of whether they have the `export` keyword.

---

## Architecture

### Three-Phase Flow (Both Workflows)

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: Task Implementation (Ralph Loop)                       │
│ Implement → Validate → LightReview → ReviewFix (if issues)     │
│     ↑__________________________________________↓                │
│ Loop until CODE-QUALITY + MAINTAINABILITY approve              │
└─────────────────────────────────────────────────────────────────┘
                              ↓ All tasks done
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: Full Review (Ralph Loop)                              │
│ All 8 Reviewers (parallel) → ReviewFix → Re-validate           │
│     ↑______________________________________________↓           │
│ Loop until ALL reviewers approve, then re-run to validate       │
└─────────────────────────────────────────────────────────────────┘
                              ↓ All reviews passed
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3: Human Gate (needsApproval)                            │
│ Human reviews → Approve (DONE) or Reject → Feedback → Phase 1   │
└─────────────────────────────────────────────────────────────────┘
```

### Difference: Default vs Dynamic

| Aspect | Default (`workflow.tsx`) | Dynamic (`workflow-dynamic.tsx`) |
|--------|--------------------------|--------------------------------|
| **Task discovery** | Upfront (Discover component) | Runtime batch discovery (3-5 at a time) |
| **Task count** | Best for 5-20 tasks | Best for 20+ tasks |
| **Scope evolution** | Fixed upfront | Adapts as codebase evolves |
| **Memory** | Keeps all tasks in context | Bounded (3-5 active at once) |

---

## Smithers Integration

### Critical Setup

1. **Import from local `smithers.ts`** — Never from `smithers-orchestrator` directly
2. **Import `Task`** — Workflow fails silently without it
3. **Return agent instances** — `new PiAgent()`, not config objects
4. **Pi uses env vars** — `API_KEY_MOONSHOT`, `FIREWORKS_API_KEY`, etc.
5. **JSON mode** — `mode: "json"` forces structured output

### Agent Factory Pattern

```typescript
function makeAgent(tier: "cheap" | "standard" | "powerful") {
  const kind = (process.env.RALPH_AGENT || "pi").toLowerCase();
  const cwd = process.env.SMITHERS_CWD || process.cwd();
  
  // Pi with Fireworks (preferred) or Moonshot
  const fw = process.env.FIREWORKS_API_KEY;
  const ms = process.env.API_KEY_MOONSHOT;
  return new PiAgent({
    cwd,
    model: fw ? "fireworks/kimi-k2p5" : "kimi-k2.5",
    provider: fw ? "fireworks" : "moonshot",
    mode: "json",
    noSession: true,
  });
}
```

### Model Mapping

| Tier | Fireworks | Moonshot |
|------|-----------|----------|
| cheap | `fireworks/kimi-k2p5` | `kimi-k2.5` |
| standard | `fireworks/kimi-k2p5` | `kimi-k2.5` |
| powerful | `fireworks/kimi-k2p5` | `kimi-k2.5` |

---

## VCS Integration (JJ)

### Every Commit Must Include

```
type(scope): brief description

Spec: <spec-id>
Task: <task-id>
Reasoning: <why this change was made>
Review-Feedback: <what issue was being addressed, if fix>
```

### Workflow

1. **JJ colocated with Git** — `.git` and `.jj` coexist
2. **Bookmark per spec** — `jj bookmark create <spec-id>`
3. **GitHub push** — `jj git push` to colocated remote
4. **Commit on every implement/fix** — Reasoning traces in history

---

## Reviewers

### Per-Task (Light Review)
- `CODE-QUALITY.md`
- `MAINTAINABILITY.md`

### Full Review (All 8 in Parallel)
- `CODE-QUALITY.md`
- `MAINTAINABILITY.md`
- `SECURITY.md`
- `SIMPLICITY.md`
- `TIGERSTYLE.md`
- `CORRECTNESS-GUARANTEES.md`
- `TEST-COVERAGE.md`
- `production-monitoring.md`

---

## Sync Operations

### What Changed

| Before | After |
|--------|-------|
| `limactl copy --exclude` (broken) | `rsync` with SSH control socket |
| `tar` pipes | `rsync -avz --delete` |

### Platform-Specific

**macOS + Lima:**
```bash
rsync -avz --delete -e "ssh -S ~/.lima/<vm>/ssh.sock" src/ ralph@127.0.0.1:dest/
```

**Linux + libvirt:**
```bash
rsync -avz --delete -e "ssh ..." src/ ralph@$IP:dest/
```

---

## Compound Engineering

### 80/20 Rule

- **80% Planning**: Spec interview → Todo generation → Validation
- **20% Execution**: Ralph loops handle implementation
- **Compound**: Each completed spec makes next faster (reusable patterns)

### Learnings Capture

After human approval, extract to `LEARNINGS.md`:

```markdown
## <spec-id> Learnings

**What We Learned:**

1. **<Category>**: <Pattern discovered>
   - Found by: <reviewer/implementer>
   - Justification: <from commit/report>
   - Codified: <how to reuse>
```

**Sources:**
- VCS commit messages (reasoning traces)
- Reviewer feedback (what was caught)
- Iteration counts (convergence patterns)
- Human feedback (judgment)

---

## Common Issues

### `desc.agent.generate is not a function`
- **Cause**: `makeAgent()` returns config object instead of `new PiAgent()`
- **Fix**: Return agent class instance

### `No API key found`
- **Cause**: Pi doesn't use `apiKey` option, reads from env
- **Fix**: Set `API_KEY_MOONSHOT` or `FIREWORKS_API_KEY` in `~/.config/ralph/ralph.env`

### Workflow exits immediately (exit code 0)
- **Cause**: `Task` not imported from `./smithers`
- **Fix**: `import { Task } from "./smithers"`

### Model not found
- **Cause**: Wrong format (e.g., `kimi-k2-5` vs `kimi-k2.5`)
- **Fix**: Use provider-specific format

---

## Future Improvements

1. **Bundle workflows** — Pre-compile `.tsx` → `.js` for faster startup
2. **Incremental sync** — `rsync --checksum` to skip unchanged files
3. **Learning synthesis** — Auto-extract patterns from commit history

## Sync Operations (Updated)

### macOS Project Sync Solution

**Problem**: `limactl copy` doesn't support `--exclude` and copies `node_modules`, filling VM disk (30GB limit).

**Solution**: Use `tar` with `--exclude` patterns piped through `limactl shell`:

```bash
tar -C "${projectDir}" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.next' \
  --exclude='.cache' \
  -cf - . | \
  limactl shell --workdir /home/ralph ${vm} bash -lc \
    'mkdir -p "${workdir}" && tar -C "${workdir}" -xf -'
```

**Excluded**: `node_modules`, `.git`, `.next`, `.cache`, build artifacts, logs, `._*`, `.DS_Store`

**Benefits**:
- No disk fill (excludes from the start)
- Single command (no post-copy cleanup needed)
- Faster (no copying of unnecessary files)

### Cross-Platform Sync Strategy

| Platform | Method | Notes |
|----------|--------|-------|
| **macOS + Lima** | tar pipe via limactl shell | Excludes handled at source |
| **Linux + libvirt** | rsync with SSH | Native --exclude support |

---

## When to Use limactl vs Fabrik CLI

### The Interplay Problem

There's a critical distinction between **Fabrik CLI commands** (host-side) and **direct VM access** via `limactl shell`:

```
┌─────────────────────────────────────────────────────────┐
│                    HOST (Your Machine)                  │
│  ┌─────────────┐     ┌─────────────┐     ┌───────────┐ │
│  │ fabrik CLI  │────→│   run.sh    │────→│  limactl  │ │
│  │  commands   │     │  (deployed) │     │  shell    │ │
│  └─────────────┘     └─────────────┘     └─────┬─────┘ │
│         │                    │                  │       │
│         └────────────────────┴──────────────────┘       │
│                           ↓                             │
│                    VM (ralph-1)                         │
│              ┌─────────────────────┐                    │
│              │  smithers workflow  │                    │
│              │  SQLite database    │                    │
│              └─────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

### Use **Fabrik CLI** When:

| Scenario | Command | Why |
|----------|---------|-----|
| Quick status check | `fabrik runs show --id 113` | One-liner, queries daemon cache |
| Watch progress | `fabrik runs watch --cluster dev-k3s` | Live updates via daemon |
| Stream logs | `fabrik run attach --id 113` | Real-time log tailing (kubectl exec) |
| Resume workflow | `fabrik run resume --id 113` | Proper environment setup |
| List runs | `fabrik runs list` | Human-readable table (all clusters) |
| TUI Dashboard | `fabrik dashboard` | k9s-style terminal interface |

### ⚠️ VM Support Deprecated

**The VM architecture (ralph-1, limactl, libvirt) is being sunset in favor of k3s-native execution.**

**Migration path:**
- Use `fabrik cluster init` to create k3s cluster
- Use `fabrik dashboard` instead of manual VM queries
- Daemon provides real-time sync (no more stale host DB)
- All observability is in-cluster (LAOS in k3s, not on host)

### Use **kubectl / fabrik daemon** When:

| Scenario | Example | Why Fabrik Can't Do It Directly |
|----------|---------|----------------------------------|
| **Direct DB query** | `kubectl exec pod-xyz -- sqlite3 ...` | Needs pod exec |
| **Fix stuck tasks** | `kubectl delete pod pod-xyz` | K8s-native recovery |
| **Check processes** | `kubectl top pod pod-xyz` | Needs metrics API |
| **Inspect annotations** | `kubectl get pod pod-xyz -o json` | Pod status access |
| **Manual PVC access** | `kubectl cp ...` | File copy to/from pod |
| **Check logs** | `kubectl logs pod-xyz -f` | Stream logs |
| **Debug smithers** | `kubectl describe job job-xyz` | K8s resource inspection |

### Critical Example: Stuck Task Detection (k3s-native)

**Fabrik CLI shows:**
```bash
$ fabrik runs show --id 01jk7v8x...
status: running
current_task: 16:impl
heartbeat_age: 2s
```

**Behind the scenes (daemon queries K8s):**
```bash
$ kubectl get pod -n fabrik-runs -l fabrik.dev/run-id=01jk7v8x...
NAME                    READY   STATUS    RESTARTS   AGE
fabrik-01jk7v8x...-abcd   1/1     Running   0          5m

$ kubectl get pod fabrik-01jk7v8x...-abcd -n fabrik-runs \
  -o jsonpath='{.metadata.annotations.fabrik.dev/status}'
{"phase":"implement","current_task":"16:impl","attempt":1,"progress":{"finished":150,"total":192}}
```

**With the daemon:**
- No dual database (host DB vs VM DB) — single source of truth in cluster
- No heartbeat fragility — K8s watches are reliable
- No SSH/exec overhead — persistent K8s API connection
- If stuck, `kubectl delete pod` lets Job restart with same PVC (Smithers resume)

### Rule of Thumb (k3s-native)

```
┌────────────────────────────────────────────────────────┐
│  START with:  fabrik dashboard                        │
│           (TUI shows all clusters live)               │
│                                                        │
│  Or: fabrik runs show --id 01jk7v8x...              │
│           (queries daemon cache, <10ms)               │
│                                                        │
│  If daemon not running:                               │
│     fabrik daemon start                               │
│                                                        │
│  Fallback: kubectl (standard K8s)                     │
│     kubectl get jobs -n fabrik-runs                   │
│     kubectl logs -n fabrik-runs job/...               │
└────────────────────────────────────────────────────────┘
```

### Common Commands Reference (k3s-native)

**Fabrik CLI:**
```bash
# Start daemon (auto-starts with dashboard)
fabrik daemon start

# TUI dashboard (k9s-style)
fabrik dashboard

# Status (queries daemon cache, fast)
fabrik runs show --id 01jk7v8x...

# Watch with progress
fabrik runs watch --cluster dev-k3s

# Resume after crash
fabrik run resume --id 01jk7v8x...
```

**kubectl (standard K8s, for power users):**
```bash
# List fabrik jobs
kubectl get jobs -n fabrik-runs -l app.kubernetes.io/managed-by=fabrik

# Stream logs
kubectl logs -n fabrik-runs -l fabrik.dev/run-id=01jk7v8x... -f

# Delete stuck pod (Job will recreate with resume)
kubectl delete pod -n fabrik-runs fabrik-01jk7v8x...-abcd

# Check pod status annotations
kubectl get pod -n fabrik-runs fabrik-01jk7v8x...-abcd -o yaml
```

### The Danger: run.sh Version Mismatch

**Critical finding**: `run.sh` is generated once at dispatch time and contains hardcoded smithers version:

```bash
# In VM's run.sh - generated Feb 15, NOT updated by fabrik fixes
bun add smithers-orchestrator@github:evmts/smithers#ea5ece3  # OLD
```

**Even after global smithers is fixed, attach/resume may use OLD version!**

**Fix via limactl:**
```bash
limactl shell ralph-1 -- sed -i \
  's|github:evmts/smithers#ea5ece3|github:SamuelLHuber/smithers#3e41cf48|g' \
  /home/ralph/work/ralph-1/.runs/.../run.sh
```

See full debugging guide: [docs/DEBUGGING-RUNS.md](./docs/DEBUGGING-RUNS.md)

---

## Resume System Bug & Fix (Critical Learning)

### The Bug

**Discovery:** 2026-02-16  
**Impact:** All runs before v0.1.1  
**Severity:** Critical - wasted compute, lost progress

**Symptom:**
```bash
$ fabrik run resume --id 113
[ralph-1] Resuming run 113...
[00:00:00] → 1:impl (attempt 1)  # ← BUG: Should continue from Task 16!
```

**Root Cause Analysis:**

1. **Wrong command used:** `smithers resume` instead of `smithers run`
2. **smithers CLI bug:** `--run-id` flag treated as file path, not ID
3. **Result:** New run created, all progress lost

### The Fix

**Implementation:** New `resume.ts` module with state preservation

```typescript
// OLD (buggy):
const smithersCmd = `smithers resume ${workflowFile} --run-id ${runId}`

// NEW (fixed):
const smithersCmd = `smithers run ${workflowFile}`  // Reads existing DB

// Plus: Reset stuck tasks before running
python3 << 'PY'
conn.execute("UPDATE _smithers_nodes SET state='pending' WHERE state='in-progress'")
PY
```

**Key Insight:**
- `smithers run` with same `SMITHERS_DB_PATH` = continues existing state
- `smithers resume` = broken, creates new runs

### Prevention

**33 regression tests** added:

```typescript
describe("Critical Bug Prevention", () => {
  it("NEVER uses 'smithers resume' command", () => {
    const script = buildResumeScript(config, runId, state)
    expect(script).not.toInclude("smithers resume")
    expect(script).toInclude("smithers run")
  })
  
  it("preserves task completion state", () => {
    const state = { completedTasks: 15, totalTasks: 18 }
    const script = buildResumeScript(config, runId, state)
    expect(script).toInclude("Completed: 15/18 tasks")
  })
})
```

### When Resume Works vs Doesn't

| Scenario | Expected | Bug Behavior | Fixed Behavior |
|----------|----------|--------------|----------------|
| Resume after crash | Continue from stuck task | Restart from Task 1 | ✅ Continue |
| Resume after timeout | Continue from stuck task | Restart from Task 1 | ✅ Continue |
| Resume with --fix | Fix DB, then continue | Restart from Task 1 | ✅ Fix & continue |
| Multiple resumes | Same run, more progress | New run each time | ✅ Same run |

### Testing Resume

```bash
# 1. Start run, let it complete some tasks
fabrik run --spec specs/test.md --vm ralph-1

# 2. Stop it (Ctrl+C)

# 3. Resume and verify continuation (not restart)
$ fabrik run resume --id <run-id>
[ralph-1] Progress: 5/10 tasks completed  # ← Shows progress!
[ralph-1] Continuing from: 6:impl        # ← Correct task!

# NOT: "→ 1:impl" (that would be the bug)
```

### Files

- **Fix:** `src/fabrik/resume.ts` - New module
- **Tests:** `src/fabrik/__tests__/resume.test.ts` - 33 tests
- **Integration:** `src/fabrik/Cli.ts` - Uses new module
- **Docs:** `docs/RESUME-BUG-FIX.md` - Detailed documentation

### Lesson Learned

> **Don't trust external CLI commands without testing.**
> 
> The `smithers resume` command *sounded* correct but was fundamentally broken.
> Only integration testing with real database state revealed the bug.
> 
> **Always verify:**
> 1. Command actually does what you expect
> 2. State is preserved (database entries not duplicated)
> 3. Progress continues (not restarts)

---

## Memory Requirements for L4+ Integration Tests (2026-02-16)

**Run:** ombruja-miniapp Task 16 - "L4: Add integration tests for complete user flows"  
**VM:** ralph-1 (5.8GB RAM)  
**Status:** ❌ Failed - OOM (Out of Memory)

### The Problem

L4 integration tests spawn a full application stack that exhausts 5.8GB RAM:
- Next.js application server
- Supabase local stack
- Vitest test runner
- Chromium headless browser
- Effect library runtime
- TypeScript compilation

**Peak memory:** ~5GB+ (3GB smithers + 2GB test infrastructure)

### Sequential Mode Test

Even running **single task** (Task 16 only) failed:
- Iteration 0: 16:impl ✓, 16:val ✓ (succeeded)
- Iteration 1: Process killed by OOM

**Memory didn't free between iterations** - Chromium processes (~180MB) and test runners accumulated.

### VM Memory Sizing Guide

| Workload Type | Minimum RAM | Recommended |
|---------------|-------------|-------------|
| L1-L2 (Unit tests) | 4GB | 6GB |
| L3 (API tests) | 6GB | 8GB |
| **L4-L5 (Integration/E2E)** | **8GB** | **12GB** |
| Multi-task parallel | 12GB | 16GB |

### The Solution

**Immediate:**
1. Increase VM memory to 8GB+ (`limactl` edit lima.yaml)
2. Or skip to Task 17 (milestone work, less memory intensive)

**Long-term:**
1. Add memory requirements to TODO spec format
2. Implement pre-flight memory check in workflow
3. Auto-scale VM memory based on task tier detection
4. Add swap space to base image (emergency overflow)

### Code Work Preserved

Task 16 core work committed to `feat/chinese-readings-n-art`:
```
ba55455 feat(test): L4 integration tests with Effect mocking and vitest scripts
487335e chore(config): exclude smithers-runner from TypeScript compilation
efd5cf5 feat: add Match.exhaustive for ChineseZodiacSign branded types
```

### Monitoring Memory

```bash
# Check for OOM conditions
limactl shell ralph-1 -- bash -c '
  free -h
  ps aux | grep -E "bun|smithers|chromium" | grep -v grep
  dmesg | grep -i "killed process" | tail -5
'
```

### Lesson Learned

> **Memory is a first-class resource constraint.**
>
> L4+ tasks need explicit memory requirements in specs.
> Sequential mode helps but can't overcome hardware limits.
> Always size VMs for peak memory, not average.

---

## Check for Uncommitted Work Before VM Shutdown (2026-02-16)

**Context:** Shutting down ralph-1 VM after run failures  
**Discovery:** 1,400+ lines of uncommitted work in failed run directory  
**Status:** ⚠️ Almost lost valuable code

### The Problem

After run failures on Task 17, assumed all work was committed. However:

```bash
# In VM work directory
git status --short | grep "^ M"
 M src/app/collection/app.tsx          # 376 lines changed
 M src/client/types/client.types.ts     # 245 lines changed  
 M src/server/lib/notification.ts     # 135 lines changed
 M src/server/services/alchemy/alchemy.service.ts  # 63 lines changed
 M tests/integration/user-flow.test.ts # 580 lines changed
```

**Total: ~1,400 lines of uncommitted work from failed iterations**

### Root Cause

Failed runs (OOM) leave modified files that:
- Never went through full Ralph loop (no VCS commit)
- Contain partial implementation from iteration attempts
- Are invisible to "git log" (not committed)

### The Solution

**Always run this before shutting down a VM:**

```bash
# Check for uncommitted work
limactl shell ralph-1 -- bash -c '
  cd /home/ralph/work/ralph-1/ombruja-miniapp-*/
  echo "Modified files: $(git status --short | grep "^ M" | wc -l)"
  echo "New files: $(git status --short | grep "^??" | wc -l)"
  
  # Show line counts for modified files
  git status --short | grep "^ M" | while read line; do
    file=$(echo "$line" | cut -c4-)
    changes=$(git diff --numstat "$file" | awk "{print \$1+\$2}")
    echo "  $file: $changes lines"
  done
'
```

### Recovery Options

**If uncommitted work found:**

1. **Copy to local for review:**
   ```bash
   # Archive modified files
   limactl shell ralph-1 -- tar -C /home/ralph/work/ralph-1/ombruja-miniapp-XXXX -czf - \
     $(git status --short | grep "^ M" | cut -c4-) \
     > ~/vm-uncommitted-work.tar.gz
   ```

2. **Stash on VM:**
   ```bash
   git stash push -m "WIP before shutdown $(date)"
   ```

3. **Quick commit:**
   ```bash
   git add -A
   git commit -m "WIP: Task X uncommitted work [ci skip]"
   git push origin feat/branch
   ```

### Checklist Before VM Shutdown

- [ ] `git status` - any modified files?
- [ ] `git diff --stat` - how many lines changed?
- [ ] `git stash list` - any stashes?
- [ ] `git log --oneline -3` - confirm expected commits present
- [ ] `jj status` (if using jujutsu) - any uncommitted changes?
- [ ] Check `.runs/` directories - any run logs worth saving?

### Lesson Learned

> **Failed runs != committed work.**
>
> Always verify git status before shutdown. The Ralph loop only commits on successful iterations. Failed iterations (OOM, crashes) leave modified files in working directory that are invisible to remote repo.

