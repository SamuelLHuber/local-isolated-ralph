# Critical Bug Fix: Resume Creates New Runs (v0.1.1)

## The Bug (Historical)

**Affected versions:** v0.1.0 and earlier

### Symptoms
```bash
# Resume appears to work...
$ fabrik run resume --id 113
[ralph-1] Resuming run 113...

# But starts from Task 1 instead of Task 16!
[00:00:00] → 1:impl (attempt 1, iteration 0)  # ← Wrong! Should be Task 16
```

### Root Cause

The original implementation used `smithers resume` command:

```typescript
// BUGGY CODE (old):
const smithersCmd = smithersRunId 
  ? `smithers resume ${workflowFile} --run-id ${smithersRunId}`  // ← Bug!
  : `smithers run ${workflowFile}`
```

**Why it failed:**
1. `smithers resume` treats `--run-id` as a **file path**, not an ID
2. Module loader tries to `require("/path/to/run-id")` → fails silently
3. Creates **new run entry** in `_smithers_runs` table instead of continuing
4. All previous progress (Tasks 1-15) is ignored
5. Workflow starts from Task 1, wasting hours of compute

## The Fix (v0.1.1+)

### New Implementation

```typescript
// FIXED CODE (new):
// 1. Analyze existing state
const state = await analyzeRunState(vmName, smithersDbPath, smithersRunId)

// 2. Reset only stuck tasks (preserve finished work)
await resetStuckTasks(vmName, smithersDbPath, smithersRunId)

// 3. Use 'smithers run' which reads from existing DB
const smithersCmd = `smithers run ${workflowFile}`  // ← Fixed!

// 4. Same database file = state preservation
export SMITHERS_DB_PATH="/same/path/to/run-113.db"
```

### Key Changes

| Aspect | Before (Bug) | After (Fix) |
|--------|--------------|-------------|
| Command | `smithers resume --run-id X` | `smithers run` |
| Run behavior | Creates new run entry | Continues existing run |
| Task preservation | Lost (starts from 1) | Preserved (continues from N) |
| State handling | Ignored | Resets stuck, keeps finished |
| Progress reporting | None | "Completed: 15/18 tasks" |

## Prevention (Tests Added)

### Test File: `src/fabrik/__tests__/resume.test.ts`

**33 comprehensive tests** covering:
- State analysis and stuck task detection
- Proper SQL reset (only `in-progress` → `pending`)
- Database truncation for `--fix` mode
- Full integration flow
- Critical bug prevention (regression tests)

### Critical Regression Tests

```typescript
it("NEVER uses 'smithers resume' command (the bug)", () => {
  const script = buildResumeScript(config, "existing-run", state)
  
  // CRITICAL: Must use 'smithers run' not 'smithers resume'
  expect(script).toInclude("smithers run workflow.tsx")
  expect(script).not.toInclude("smithers resume")  // ← Regression test
})

it("preserves task completion state (doesn't start from task 1)", () => {
  const state = { completedTasks: 15, totalTasks: 18, ... }
  const script = buildResumeScript(config, "existing-run", state)
  
  expect(script).toInclude("Completed: 15/18 tasks")
  expect(script).toInclude("Continuing from: 16:impl")  // ← Progress preserved
})
```

## Files Changed

| File | Change |
|------|--------|
| `src/fabrik/resume.ts` | **NEW** - Proper resume module with state preservation |
| `src/fabrik/__tests__/resume.test.ts` | **NEW** - 33 comprehensive tests |
| `src/fabrik/Cli.ts` | Uses new resume module, adds MAX_RESPONSE_SIZE fix |
| `docs/RESUME-BUG-FIX.md` | **NEW** - This documentation |

## Verification

### Check Your Version

```bash
$ fabrik --version
fabrik 0.1.1+  # Fixed version
```

### Test the Fix

```bash
# 1. Start a run
$ fabrik run --spec specs/test.md --vm ralph-1 --project ./test

# 2. Let it complete a few tasks, then stop it
# (Ctrl+C or wait for natural pause)

# 3. Resume and verify it continues (not restarts)
$ fabrik run resume --id <run-id>
[ralph-1] Progress: 3/10 tasks completed  # ← Shows progress!
[ralph-1] Continuing from: 4:impl        # ← Correct task!
```

### Database Verification

```bash
# Check that resume preserves state:
$ limactl shell ralph-1 -- python3 << 'PY'
import sqlite3
conn = sqlite3.connect('/home/ralph/work/.../.smithers/run-113.db')

# Count runs - should be 1 (not multiple)
cursor = conn.execute("SELECT COUNT(*) FROM _smithers_runs")
print(f"Total runs: {cursor.fetchone()[0]}")  # Should be 1

# Check completed tasks
cursor = conn.execute("""
  SELECT COUNT(*) FROM _smithers_nodes 
  WHERE state='finished' AND node_id LIKE '%:impl'
""")
print(f"Finished impl tasks: {cursor.fetchone()[0]}")

conn.close()
PY
```

## Manual Workaround (if stuck on old version)

```bash
# Direct VM execution with state preservation:
limactl shell ralph-1 -- bash << 'EOF'
export SMITHERS_DB_PATH="/home/ralph/work/ralph-1/.runs/.../.smithers/run-113.db"
cd /home/ralph/work/ralph-1/.../smithers-runner

# Reset stuck tasks only
python3 << 'PY'
import sqlite3, os
conn = sqlite3.connect(os.environ['SMITHERS_DB_PATH'])
conn.execute("UPDATE _smithers_nodes SET state='pending' WHERE state='in-progress'")
conn.commit()
conn.close()
PY

# Run (NOT resume) - reads existing state
smithers run workflow.tsx
EOF
```

## Related Issues

| Symptom | Cause | Solution |
|---------|-------|----------|
| "Starts from Task 1" | Resume bug | Update to v0.1.1+ |
| "Multiple runs in DB" | Resume bug | Use new resume module |
| "MAX_RESPONSE_SIZE error" | smithers 0.6.0 bug | Patch smithers or set env var |
| "Process dies after 120s" | CLI timeout | Use `fabrik run attach` |

## German Engineering Principles Applied

| Principle | Application |
|-----------|-------------|
| **Ordnung** | Proper state management, single run per workflow |
| **Gründlichkeit** | 33 tests covering all edge cases |
| **Sachlichkeit** | Data-driven resume (analyze → reset → continue) |
| **Gewissenhaftigkeit** | Regression tests prevent reintroduction |

---

**Fixed:** 2026-02-16  
**Tests:** 33 passing  
**Coverage:** Resume flow, state preservation, bug prevention
