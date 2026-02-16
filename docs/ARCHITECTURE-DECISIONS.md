# Fabrik x Smithers Architecture Analysis & Proposal

## Current Architecture Problems

### 1. **Dual Database Problem** (Root Cause)

```
┌──────────────┐      ┌──────────────┐
│  Host DB     │      │   VM DB      │
│  (ralph.db)  │  ≠   │  (smithers)  │
│  status: done│      │ status:running│
└──────────────┘      └──────────────┘
       ↑                      ↑
       │                      │
   CLI reads              smithers writes
   (stale)                 (truth)
```

**The Issue**: Host database is a **cache** that becomes stale when:
- Heartbeat writer dies but main process continues
- Process crashes without updating host
- Network issues prevent reconciliation

### 2. **run.sh Version Pinning Problem**

```bash
# Generated ONCE at dispatch time
bun add smithers-orchestrator@github:evmts/smithers#ea5ece3  # STUCK AT OLD VERSION

# Even after global smithers is updated, run.sh installs old version!
```

### 3. **Heartbeat as Proxy for Health**

```python
# Current logic: heartbeat dead = process dead
# Reality: heartbeat can die, main process continues
# Result: false negatives in status detection
```

### 4. **No Event Stream**

- Can't subscribe to real-time updates
- Have to poll repeatedly
- No push notifications for blocked/failed tasks

---

## Proposed Solutions (In Order of Implementation)

### Solution 1: VM-as-Source-of-Truth (Immediate Fix)

**Principle**: All status queries go to VM, host DB is write-only metadata.

```typescript
// New approach for all read operations
async function getRunStatus(runId: string, vm: string): Promise<RunStatus> {
  // ALWAYS query VM database via limactl
  const vmStatus = await queryVmDatabase(vm, runId);
  
  // Host DB only for historical metadata (spec path, branch, etc.)
  const hostMetadata = await queryHostDb(runId);
  
  return {
    ...hostMetadata,
    // VM is authoritative for runtime state
    status: vmStatus.status,
    currentTask: vmStatus.currentTask,
    progress: vmStatus.progress,
    // Compute freshness from VM
    isStale: vmStatus.lastUpdateAge > 300_000, // 5 min
  };
}
```

**Benefits**:
- Single source of truth (VM)
- No stale data
- Simple mental model

**Tradeoffs**:
- Slower queries (VM round-trip)
- Requires VM to be running

---

### Solution 2: Continuous Sync Daemon (Better)

**Principle**: Background process keeps host DB in sync with VM.

```typescript
// sync-daemon.ts - runs on host
class RunSyncDaemon {
  private subscriptions = new Map<string, Subscription>();
  
  async subscribe(runId: string, vm: string) {
    // Watch VM database file for changes
    const watcher = watchVmDbFile(vm, runId);
    
    // Or poll every 10 seconds
    setInterval(async () => {
      const vmStatus = await queryVmStatus(vm, runId);
      await updateHostDb(runId, vmStatus);
      
      // Emit events for real-time updates
      if (vmStatus.currentTask !== previousTask) {
        this.emit('task_changed', { runId, task: vmStatus.currentTask });
      }
    }, 10_000);
  }
}
```

**Implementation Options**:

#### Option A: File Watching (Best for Lima)
```bash
# In VM: write to shared directory
# On Host: watch file changes with fs.watch()

# Or use sqlite WAL shipping
```

#### Option B: Polling (Simpler)
```typescript
// Every 10 seconds: query VM, update host
// Acceptable for CLI use (not real-time dashboard)
```

#### Option C: Event Stream from Smithers
```typescript
// Smithers writes to events.ndjson
// Host tails this file for live updates
```

---

### Solution 3: CLI-Only Mode (Radical Simplification)

**Principle**: Remove host database entirely. CLI is a thin wrapper over VM operations.

```typescript
// All commands query VM directly
const runsShowCommand = {
  handler: async ({ id }) => {
    // No host DB lookup
    const run = await fetchFromVm(id); // limactl query
    console.log(run);
  }
};

const runsListCommand = {
  handler: async () => {
    // Query all VMs for their runs
    const allRuns = await Promise.all(
      vms.map(vm => fetchRunsFromVm(vm))
    );
    console.table(allRuns.flat());
  }
};
```

**Benefits**:
- No sync issues ever
- Simpler codebase
- Always accurate

**Tradeoffs**:
- Slower (VM round-trip)
- Works only when VM is running
- No offline history

---

### Solution 4: Unified State Store (Ideal)

**Principle**: Single database, accessible from both host and VM.

```
┌─────────────────────────────────────┐
│         Shared Database             │
│  (SQLite on shared volume, or       │
│   PostgreSQL via network, or         │
   Litestream replication)            │
└─────────────────────────────────────┘
     ↑                    ↑
     │                    │
  Host CLI            Smithers VM
  (reads/writes)      (reads/writes)
```

**Implementation**: 
- SQLite on shared host-VM directory (Lima only)
- Or: litestream replication from VM to host
- Or: simple file sync every 10 seconds

---

## Recommended Implementation

### Phase 1: Fix Current Issues (Today)

1. **Update `runs show` to query VM directly**
   - Remove `--live` flag (make it default behavior)
   - Always get truth from VM
   - Show warning if VM unreachable

2. **Fix `run.sh` to use dynamic version**
   - Don't hardcode smithers version
   - Use `smithers --version` check
   - Or: copy host's smithers-runner at dispatch time

3. **Better stuck task detection**
   - Check process existence, not just heartbeat
   - Mark tasks as failed if process dead
   - Auto-retry on resume

### Phase 2: Sync Daemon (This Week)

```typescript
// New command: fabrik daemon start
// Background sync of all active runs
// Enables real-time `runs watch` without polling
```

### Phase 3: Event Stream (Next Sprint)

```typescript
// Smithers writes events to events.ndjson
// Host subscribes for real-time updates
// Enables web dashboard, notifications, etc.
```

---

## Key Decision: Should We Rely on CLI Only?

**Answer: Yes, but CLI should query VM directly.**

The current architecture has two databases that get out of sync. The fix is NOT to use `limactl` for everything (too manual), but to make **CLI automatically query VM** when needed.

### Proposed CLI Behavior

```typescript
// runs show - ALWAYS gets truth from VM
async function runsShow(runId: string) {
  const run = await findRunById(runId); // host metadata
  const vmStatus = await queryVmStatus(run.vm, runId); // VM truth
  
  return {
    ...run,
    status: vmStatus.status, // VM wins
    currentTask: vmStatus.currentTask,
    progress: vmStatus.progress,
    stale: vmStatus.age > 300_000,
  };
}

// runs list - aggregates from all VMs
async function runsList() {
  const hostRuns = await listRunsFromHost();
  
  // For each running/pending run, get fresh status
  const freshRuns = await Promise.all(
    hostRuns.map(async run => {
      if (run.status === 'running') {
        const vmStatus = await queryVmStatus(run.vm, run.id);
        return { ...run, ...vmStatus };
      }
      return run;
    })
  );
  
  return freshRuns;
}
```

---

## Concrete Next Steps

1. **Today**: Update `runs show` to always query VM (remove `--live`, make it default)
2. **Today**: Fix `run.sh` template to not hardcode smithers version
3. **This week**: Add `fabrik daemon` for background sync
4. **Next week**: Implement event stream from smithers

**The goal**: User never needs to know about `limactl`. CLI always shows truth from VM.
