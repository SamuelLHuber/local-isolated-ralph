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
