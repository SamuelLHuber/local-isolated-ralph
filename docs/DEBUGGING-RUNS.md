# Debugging Fabrik Runs

This guide explains how to debug and inspect runs deeply when things go wrong or you need to understand run state.

## Overview

When you dispatch a run with `fabrik run --spec <spec> --vm <vm>`, the following happens:

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  fabrik run     │────▶│  dispatch.ts     │────▶│  VM (ralph-1)   │
│  --spec --vm    │     │  - Validate spec │     │                 │
│                 │     │  - Insert run DB │     │  workdir/       │
│                 │     │  - Sync project  │     │  controlDir/    │
│                 │     │  - Write specs   │     │  reports/       │
│                 │     │  - Start script  │     │  .smithers/*.db │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Key VM Directories

| Directory | Purpose |
|-----------|---------|
| `workdir/` | Your project code synced from host |
| `controlDir/` | Run metadata (`run.sh`, `smithers.pid`, `heartbeat.json`, `exit_code`) |
| `reports/` | `smithers.log`, `run-context.json`, `smithers-version.json` |
| `.smithers/*.db` | SQLite database with task progress |

## Todo Generation (Non-Dynamic Mode)

In **non-dynamic mode** (default), you must provide a todo file with tasks. The workflow is:

```bash
# Step 1: Generate the spec
fabrik spec interview | tee /tmp/spec-prompt.txt
cat /tmp/spec-prompt.txt | claude-code  # Save output as specs/feature.json

# Step 2: Generate the todo from the spec
fabrik todo generate | tee /tmp/todo-prompt.txt
cat /tmp/todo-prompt.txt | claude-code  # Save output as specs/feature.todo.json

# Step 3: Dispatch with both files
fabrik run --spec specs/feature.json --todo specs/feature.todo.json --vm ralph-1
```

### Todo File Format

The todo file must contain a `tickets` array with at least one task:

```json
{
  "v": 1,
  "tickets": [
    {
      "id": "task-1",
      "title": "Implement feature X",
      "description": "...",
      "tier": "T1",
      "model": "standard"
    }
  ]
}
```

**Critical**: Empty todo files (`{"tickets":[]}`) will cause the run to complete immediately with no work done. The dispatcher now validates this and will **crash before dispatching** if the todo has no tickets.

### Dynamic Mode (Alternative)

If you don't want to pre-generate tasks, use `--dynamic`:

```bash
fabrik run --spec specs/feature.json --vm ralph-1 --dynamic
```

In dynamic mode, the workflow discovers tasks at runtime from the spec content. The todo file is optional and will be generated at a unique path (`<spec>.dynamic-todo.json`).

**Important**: Dynamic mode will **NOT** use an existing `*.todo.json` file. If you previously had an empty todo file, it won't interfere. The workflow generates tasks fresh from the spec content each time.

### Root Cause: The Empty Todo Bug (Fixed)

**Bug**: Runs with `--dynamic` were completing immediately with no work done.

**Root Cause**: 
1. CLI resolved default todo path: `spec-chinese-readings-n-art.md.todo.json`
2. Dispatch created empty placeholder: `{"_type":"dynamic","generated":true,"tickets":[]}`
3. Dynamic workflow saw empty tickets and completed immediately
4. No actual task discovery happened from the spec content

**Fix** (commit 3fef4f8):
- Dynamic mode no longer resolves default todo paths
- If no todo provided in dynamic mode, no placeholder is written
- Dynamic workflow discovers tasks fresh from spec content
- Non-dynamic mode validates todo exists and has tickets before dispatch

**After fix**: `--dynamic` runs discover tasks from spec, `--todo` runs use provided todo file.

## Quick Debug Commands

### 1. Check Run Status (Host-side)

```bash
# List recent runs (auto-reconciles status from VM)
fabrik runs list

# Show specific run details
fabrik runs show --id <run-id>

# Manually reconcile status from VM to host DB
fabrik runs reconcile

# Reconcile with custom stale threshold (default 120s)
fabrik runs reconcile --heartbeat-seconds 60
```

### 2. Attach to Live Run

```bash
# Stream logs from a running or completed run
fabrik run attach --id <run-id>
```

This tails the `smithers.log` file in the VM's report directory.

## Deep VM Inspection

### Directory Structure

For a run with workdir `/home/ralph/work/<vm>/<project>-<timestamp>`, the control directory is:

```
/home/ralph/work/<vm>/.runs/<project>-<timestamp>/
├── exit_code          # Exit code of smithers process (0 = success)
├── heartbeat.json     # Last heartbeat with timestamp, pid, phase
├── smithers.pid       # Process ID of running smithers
├── run.sh            # The generated run script
├── reports/
│   ├── smithers.log       # Full execution log
│   ├── run-context.json   # Run metadata and context
│   └── smithers-version.json  # Smithers version info
└── .smithers/
    └── <spec-id>.db       # SQLite database with task state
```

### Essential VM Commands

```bash
# Check if VM is running
limactl list

# Enter VM shell
limactl shell <vm>

# Check control directory files
limactl shell <vm> -- ls -la /home/ralph/work/<vm>/.runs/<workdir>/

# Check exit code (0 = success, empty = still running)
limactl shell <vm> -- cat /home/ralph/work/<vm>/.runs/<workdir>/exit_code

# Check heartbeat (last update timestamp)
limactl shell <vm> -- cat /home/ralph/work/<vm>/.runs/<workdir>/heartbeat.json

# Check if process is alive
limactl shell <vm> -- ps aux | grep smithers

# Stream the smithers log (follow mode)
limactl shell <vm> -- tail -f /home/ralph/work/<vm>/.runs/<workdir>/reports/smithers.log

# View full log
limactl shell <vm> -- cat /home/ralph/work/<vm>/.runs/<workdir>/reports/smithers.log
```

## Querying the Smithers Database

The smithers SQLite database (`<spec-id>.db`) contains detailed task state.

### Python Query Script

```bash
limactl shell <vm> -- bash -lc "
python3 << 'PY'
import sqlite3, json, os

# Adjust path for your run
path = '/home/ralph/work/<vm>/.runs/<workdir>/.smithers/<spec-id>.db'

if not os.path.exists(path):
    print(f'Database not found: {path}')
    raise SystemExit(1)

conn = sqlite3.connect(path)

# List all tables
print('=== TABLES ===')
for row in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\"):
    print(f'  {row[0]}')

# Check _smithers_runs (if exists)
print('\n=== _smithers_runs ===')
try:
    for row in conn.execute('SELECT run_id, status, started_at_ms, finished_at_ms FROM _smithers_runs ORDER BY started_at_ms DESC'):
        print(f'  run_id={row[0]}, status={row[1]}, started={row[2]}, finished={row[3]}')
except:
    print('  Table not found (legacy workflow)')

# Check discover table (dynamic mode)
print('\n=== discover ===')
for row in conn.execute('SELECT * FROM discover LIMIT 5'):
    print(f'  {row}')

# Check report table (task status)
print('\n=== report ===')
for row in conn.execute('SELECT task_id, status, node_id, issues FROM report ORDER BY node_id LIMIT 20'):
    print(f'  task={row[0]}, status={row[1]}, node={row[2]}, issues={row[3]}')

# Check gate table (validation gates)
print('\n=== gate ===')
for row in conn.execute('SELECT task_id, gate_name, passed, details FROM gate LIMIT 10'):
    print(f'  task={row[0]}, gate={row[1]}, passed={row[2]}, details={row[3]}')

# Check input table
print('\n=== input ===')
for row in conn.execute('SELECT * FROM input LIMIT 5'):
    print(f'  {row}')

conn.close()
PY
"
```

### Common Database Queries

```sql
-- Find blocked or failed tasks
SELECT task_id, status, issues, next 
FROM report 
WHERE status IN ('blocked', 'failed') 
ORDER BY node_id;

-- Check review summary
SELECT iteration, status, issues, next 
FROM final_review 
ORDER BY iteration DESC 
LIMIT 1;

-- Count tasks by status
SELECT status, COUNT(*) 
FROM report 
GROUP BY status;
```

## Checking Spec and Todo Files

```bash
# Check the spec that was used
limactl shell <vm> -- cat /home/ralph/work/<vm>/<workdir>/specs/<spec-name>.min.json | head -100

# Check the todo file (if empty, run will complete immediately)
limactl shell <vm> -- cat /home/ralph/work/<vm>/<workdir>/specs/<spec-name>.todo.min.json

# For dynamic mode, check if todo was generated
limactl shell <vm> -- ls -la /home/ralph/work/<vm>/<workdir>/specs/
```

## Common Issues and Solutions

### Run Shows "Done" Immediately (Exit Code 0)

**Symptom**: Run status is `done` with `exit_code: 0` but no work was done.

**Check**:
```bash
# The todo file may be empty
limactl shell <vm> -- cat /home/ralph/work/<vm>/<workdir>/specs/<spec>.todo.min.json
```

**Cause**: Empty todo (`{"tickets":[]}`) means no tasks to execute.

**Prevention**: The dispatcher now validates todos and will **crash with a clear error** if:
- The todo file is missing (non-dynamic mode)
- The todo file has an empty `tickets` array

**Fixed Bug**: Previously, using `--dynamic` with an existing empty `*.todo.json` file would cause the run to use that empty file instead of generating tasks dynamically. This is now fixed - dynamic mode ignores existing todo files and always generates fresh.

**Fix**:
```bash
# Option 1: Generate todo first (non-dynamic mode)
fabrik todo generate | claude-code  # Save output as specs/feature.todo.json
fabrik run --spec <spec> --todo <todo> --vm <vm>

# Option 2: Use dynamic mode (ignores existing todos, discovers tasks at runtime)
fabrik run --spec <spec> --vm <vm> --dynamic
```

### Run Shows "Failed" with "stale_process"

**Symptom**: Status `failed`, `failure_reason: stale_process`.

**Check**:
```bash
# Heartbeat is stale (>120s old)
limactl shell <vm> -- cat /home/ralph/work/<vm>/.runs/<workdir>/heartbeat.json

# Process is not running
limactl shell <vm> -- ps aux | grep smithers
```

**Cause**: Smithers process died without writing exit_code, or VM was restarted.

**Action**: Check `smithers.log` for crash details, then retry the run.

### Run Stuck in "running" but No Process

**Symptom**: Status `running` but `ps aux` shows no smithers process.

**Check**:
```bash
# Check for exit_code file (reconcile may have missed it)
limactl shell <vm> -- cat /home/ralph/work/<vm>/.runs/<workdir>/exit_code

# Force reconcile
fabrik runs reconcile --heartbeat-seconds 30
```

### Cannot Access VM Files

**Symptom**: `limactl shell` commands fail.

**Check**:
```bash
# VM status
limactl list

# Start VM if stopped
limactl start <vm>

# Check SSH works
limactl shell <vm> -- echo "VM is up"
```

## Workflow File Inspection

If you need to debug the workflow itself:

```bash
# Check which workflow file is being used
limactl shell <vm> -- ls -la /home/ralph/work/<vm>/<workdir>/smithers-runner/

# View the workflow
limactl shell <vm> -- cat /home/ralph/work/<vm>/<workdir>/smithers-runner/workflow.tsx

# View the run script (environment variables, commands)
limactl shell <vm> -- cat /home/ralph/work/<vm>/.runs/<workdir>/run.sh
```

## Host-side Database

The host keeps a lightweight run tracking database:

```bash
# Location
~/.cache/ralph/ralph.db

# Query with sqlite3
sqlite3 ~/.cache/ralph/ralph.db "SELECT * FROM runs ORDER BY started_at DESC LIMIT 10;"

# Get specific run
sqlite3 ~/.cache/ralph/ralph.db "SELECT * FROM runs WHERE id = <run-id>;"
```

## Reconciliation Logic

The `fabrik runs reconcile` command performs these checks:

1. For each "running" run in host DB:
   - Read `exit_code` from control dir → mark done/failed if present
   - Read `smithers.pid` → check if process alive
   - Read `heartbeat.json` → mark failed if stale (>120s by default)
   - If no PID and stale heartbeat → mark failed with `stale_process`
   - If PID exists but process dead → check heartbeat, mark failed if stale

2. Update host DB with reconciled status

## Debugging Checklist

When a run behaves unexpectedly:

- [ ] Check run status: `fabrik runs show --id <id>`
- [ ] Check VM is running: `limactl list`
- [ ] Check exit_code file exists and value
- [ ] Check heartbeat.json timestamp (is it stale?)
- [ ] Check smithers.pid and process status
- [ ] View smithers.log for errors
- [ ] Query smithers.db for task state
- [ ] Verify spec and todo files exist and have content
- [ ] Check workflow.tsx was copied correctly
- [ ] Run `fabrik runs reconcile` to sync status

## Related Commands

| Command | Purpose |
|---------|---------|
| `fabrik runs list` | List recent runs (auto-reconciles) |
| `fabrik runs show --id <id>` | Show run details (auto-reconciles) |
| `fabrik runs reconcile` | Sync VM state to host DB |
| `fabrik run attach --id <id>` | Stream logs from run |
| `fabrik runs watch --vm <vm>` | Watch for blocked tasks |
| `fabrik runs feedback --id <id> --decision approve` | Approve a blocked run |

## See Also

- `src/fabrik/reconcile.ts` - Reconciliation logic
- `src/fabrik/dispatch.ts` - Run dispatch logic
- `src/fabrik/runDb.ts` - Host-side database schema
