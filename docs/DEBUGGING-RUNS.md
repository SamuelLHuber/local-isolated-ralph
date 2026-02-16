# Debugging Smithers Runs

This guide explains how to diagnose and fix issues with Smithers workflow runs, including when to use `fabrik` CLI commands vs direct VM access via `limactl shell`.

## Quick Diagnosis Flowchart

```
Run not behaving as expected?
        ↓
┌─────────────────┐
│ fabrik runs     │
│ show --id 113   │
│ --live          │
└────────┬────────┘
         ↓
┌─────────────────────────┐
│ Status looks wrong?     │
│ (e.g., "done" but VM    │
│  shows "running")         │
└────────┬────────────────┘
         ↓ YES
┌─────────────────────────┐
│ Use limactl shell       │
│ for direct DB query     │
└────────┬────────────────┘
         ↓
┌─────────────────────────┐
│ Find root cause         │
│ (stuck task, crashed    │
│ process, etc.)          │
└────────┬────────────────┘
         ↓
┌─────────────────────────┐
│ Fix with limactl OR     │
│ fabrik run resume       │
│ (depending on issue)    │
└─────────────────────────┘
```

## When to Use Fabrik CLI vs limactl Shell

### Use **Fabrik CLI** For:

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `fabrik runs show --id 113` | Check current status (queries VM by default) | Quick status check, detect stale records |
| `fabrik runs show --id 113 --no-live` | Check cached host status only | Fast check when VM is down |
| `fabrik runs watch --vm ralph-1 --run-id 113` | Watch live progress | Monitor active workflow progress |
| `fabrik run attach --id 113` | Stream logs | Watch real-time log output |
| `fabrik run resume --id 113` | Resume failed/stopped run | After fixing stuck tasks or crashes |
| `fabrik runs list` | List all runs | Find run IDs, check multiple runs |

### Use **limactl shell** For:

| Task | Example Command | When Needed |
|------|-----------------|-------------|
| Direct database queries | Query SQLite to find stuck tasks | Fabrik shows inconsistent status |
| Fix stuck tasks | Reset task state in DB | Task marked "in-progress" but no process running |
| Check actual processes | `ps aux \| grep smithers` | Verify if workflow process exists |
| Inspect heartbeat file | `cat heartbeat.json` | Check if heartbeat writer is working |
| Manual database fixes | Update/DELETE SQL operations | Data inconsistency needs manual repair |
| Check log files | `tail -100 smithers.log` | Debug specific errors |

## Common Issues and Solutions

### Issue 1: Host Shows "done" but VM Shows "running"

**Symptoms:**
```bash
$ fabrik runs show --id 113
status: done
exit_code: 0

# But workflow is actually still running!
```

**Diagnosis:**
```bash
# Check status (now queries VM by default)
$ fabrik runs show --id 113
status: done ⚠️  (VM shows: running)
effective_status: running

=== VM Status (Source of Truth) ===
vm_status: running
current_task: 15:impl
progress: 142/184 (77%)
heartbeat_age: 45 minutes  # <-- STALE

# Or query directly if needed
$ limactl shell ralph-1 -- python3 << 'EOF'
import sqlite3
conn = sqlite3.connect('/home/ralph/work/ralph-1/.runs/.../.smithers/run-113.db')
c = conn.cursor()
c.execute("SELECT node_id, state FROM _smithers_nodes WHERE state='in-progress'")
print("Stuck tasks:", c.fetchall())
conn.close()
EOF
```

**Fix:**
```bash
# Clean up and resume
$ limactl shell ralph-1 -- rm -f /home/ralph/work/ralph-1/.runs/.../smithers.pid
$ fabrik run resume --id 113
```

---

### Issue 2: "string or blob too big" SQLite Error

**Symptoms:**
```
[00:29:08] ✗ Run failed: string or blob too big
{
  "error": {
    "message": "string or blob too big",
    "stack": "Error: string or blob too big\n    at run (native)\n    ..."
  }
}
```

**Root Cause:**
Pi agent responses exceed SQLite's ~1GB limit (400MB+ transcripts).

**Fix:**
```bash
# 1. Truncate oversized database entries
$ limactl shell ralph-1 -- python3 << 'EOF'
import sqlite3
db = '/home/ralph/work/ralph-1/.runs/.../.smithers/run-113.db'
conn = sqlite3.connect(db)
c = conn.cursor()
c.execute("UPDATE _smithers_attempts SET response_text = SUBSTR(response_text, -500000) WHERE LENGTH(response_text) > 500000")
conn.commit()
print(f"Truncated {c.rowcount} entries")
conn.close()
EOF

# 2. Vacuum database to reclaim space
$ limactl shell ralph-1 -- sqlite3 /home/ralph/work/ralph-1/.runs/.../.smithers/run-113.db "VACUUM"

# 3. Resume with fixed smithers
$ fabrik run resume --id 113
```

**Prevention:**
Ensure smithers-orchestrator has truncation fix (100KB limit on responseText/errorJson).

---

### Issue 3: Task Stuck "in-progress" but No Process Running

**Symptoms:**
- Database shows task as "in-progress"
- No bun/smithers process found
- Log file not being updated

**Diagnosis:**
```bash
# Check for actual process
$ limactl shell ralph-1 -- ps aux | grep -E 'smithers|bun' | grep -v grep
# Output: (empty - no process!)

# Check task in database
$ limactl shell ralph-1 -- python3 << 'EOF'
import sqlite3
conn = sqlite3.connect('.../run-113.db')
c = conn.cursor()
c.execute("SELECT node_id, state, last_attempt FROM _smithers_nodes WHERE state='in-progress'")
print(c.fetchall())
conn.close()
EOF
```

**Fix:**
```bash
# Mark stuck task as failed and retry
$ limactl shell ralph-1 -- python3 << 'EOF'
import sqlite3, time
conn = sqlite3.connect('.../run-113.db')
c = conn.cursor()
now = int(time.time() * 1000)

# Mark node as failed
c.execute("UPDATE _smithers_nodes SET state='failed' WHERE node_id='15:impl'")

# Mark attempt as failed
c.execute("UPDATE _smithers_attempts SET state='failed', finished_at_ms=? WHERE node_id='15:impl'", (now,))

conn.commit()
conn.close()
EOF

# Then resume
$ fabrik run resume --id 113
```

---

### Issue 4: Old run.sh Script Installing Broken smithers

**Symptoms:**
- `fabrik run attach` shows old version being installed
- Fix was applied but error still occurs

**Check:**
```bash
$ limactl shell ralph-1 -- grep "smithers-orchestrator" /home/ralph/work/ralph-1/.runs/.../run.sh
# Shows: github:evmts/smithers#ea5ece3 (OLD)
```

**Fix:**
```bash
# Update run.sh to use fixed version
$ limactl shell ralph-1 -- sed -i 's|github:evmts/smithers#ea5ece3|github:SamuelLHuber/smithers#3e41cf48|g' /home/ralph/work/ralph-1/.runs/.../run.sh
```

---

## Debugging Checklist

### Quick Status (Single Command)
```bash
# Recommended: Uses VM as source of truth
fabrik runs show --id 113
```
**Shows:** Host status, VM status, current task, progress, mismatch warnings

### Detailed Checks (When Needed)

#### 1. Process Check
```bash
limactl shell ralph-1 -- ps aux | grep -E 'smithers|bun' | grep -v grep
```
**Expected:** Shows bun/smithers processes
**If empty:** Workflow crashed, needs resume

#### 2. Heartbeat Check
```bash
limactl shell ralph-1 -- cat /home/ralph/work/ralph-1/.runs/.../heartbeat.json
```
**Expected:** Recent timestamp (< 2 min old)
**If old:** Heartbeat writer failed, but main process may still run

#### 3. Database Check
```bash
limactl shell ralph-1 -- python3 << 'EOF'
import sqlite3
conn = sqlite3.connect('/home/ralph/work/ralph-1/.runs/.../.smithers/run-113.db')
c = conn.cursor()
c.execute("SELECT run_id, status FROM _smithers_runs ORDER BY started_at_ms DESC LIMIT 1")
print("Run:", c.fetchone())
c.execute("SELECT COUNT(*), SUM(CASE WHEN state='finished' THEN 1 ELSE 0 END) FROM _smithers_nodes")
print("Progress:", c.fetchone())
conn.close()
EOF
```

#### 4. Log Check
```bash
limactl shell ralph-1 -- tail -20 /home/ralph/work/ralph-1/.runs/.../reports/smithers.log
```

#### 5. Exit Code Check
```bash
limactl shell ralph-1 -- cat /home/ralph/work/ralph-1/.runs/.../exit_code 2>/dev/null || echo "Still running"
```

---

## Key Files in VM

| File | Purpose | When to Check |
|------|---------|---------------|
| `run.sh` | Startup script | When wrong smithers version installed |
| `smithers.pid` | Process ID file | Check if process alive |
| `heartbeat.json` | Status heartbeat | Detect stale/missing updates |
| `exit_code` | Final exit status | Confirm completion |
| `reports/smithers.log` | Log output | Debug specific errors |
| `.smithers/*.db` | SQLite database | Direct state inspection |

---

## Database Schema Reference

### Key Tables

```sql
-- Run status
SELECT run_id, status FROM _smithers_runs;

-- Task status
SELECT node_id, state, last_attempt FROM _smithers_nodes;

-- Attempt details (includes response_text)
SELECT node_id, attempt, state, LENGTH(response_text) 
FROM _smithers_attempts;

-- Current in-progress task
SELECT node_id, state FROM _smithers_nodes 
WHERE state='in-progress' ORDER BY updated_at_ms DESC;
```

---

## Prevention Best Practices

1. **`runs show` now queries VM by default** - no need for `--live` flag
   ```bash
   fabrik runs show --id 113  # Automatically gets truth from VM
   ```

2. **Watch for mismatch warnings** - if you see "⚠️ (VM shows: X)", investigate

3. **Watch for stale heartbeats** - if > 10 min old, workflow may be stuck

4. **Monitor database size** - should stay < 100MB with truncation fix

5. **Use `runs watch` for active monitoring** instead of repeated `show`

6. **Check smithers version** in run.sh if errors persist after fixes

---

## See Also

- [LEARNINGS.md](./LEARNINGS.md) - General architectural learnings
- Smithers truncation fix: `github:SamuelLHuber/smithers#3e41cf48`
