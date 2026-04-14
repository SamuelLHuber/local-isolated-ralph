---
name: fabrik-smithers-monitor
description: Continuous monitoring runbook for Fabrik Smithers workflow runs. Automatically discovers active runs, monitors progress with 15-minute intervals, detects failures, and auto-restarts failed runs. Acts as a guardian to ensure runs complete successfully.
compatibility: Requires kubectl access to target cluster/namespace, permission to read Jobs/Pods/logs and delete/restart Jobs. Designed for long-running monitoring sessions.
metadata:
  author: fabrik
  version: "1.0.0"
  category: operations
---

# Fabrik Smithers Run Monitor

Use this skill when the user wants to:
- "monitor the runs" or "keep an eye on the runs"
- "guardian mode" for workflow runs
- "make sure runs complete"
- "auto-restart if they fail"
- Continuous monitoring of active Fabrik runs

## Goal

Act as a **guardian** over Fabrik runs by:
1. Discovering active runs automatically or using provided run IDs
2. Monitoring every 15 minutes (configurable)
3. Detecting failures (idle timeout, git issues, workflow errors)
4. **Auto-restarting failed runs** (with fixes applied)
5. Reporting progress until completion

## Required inputs (optional)

The skill can auto-discover runs or accept explicit inputs:

- **kubeconfig path** (optional, default: current kubectl context or look in `~/.kube`)
  - Example: `~/.kube/config`, `~/.kube/my-cluster`
- **namespace** (optional, default: `fabrik-runs`)
- **run IDs** (optional, auto-discovered if not provided)
  - Example: `cf-pi-kimi-1776037020`, `onefootball-pi-fw-20260413-113931`
- **project names** (optional, for filtering)
  - Example: `task-tracker`, `onefootball-heads`
- **auto-restart** (optional, default: `true`)
  - Whether to automatically restart failed runs
- **check interval** (optional, default: `15m`)
  - How often to check status (e.g., `5m`, `15m`, `30m`)

## Guardian Monitoring Runbook

### Phase 1: Initial Discovery

**Step 1: Determine kubeconfig**
```bash
# Use provided kubeconfig, or current context, or look in ~/.kube
if [ -n "$INPUT_KUBECONFIG" ]; then
    KUBECONFIG="$INPUT_KUBECONFIG"
    export KUBECONFIG
fi
# Verify connection
kubectl get nodes
```

**Step 2: Discover runs**
```bash
# If run IDs provided, use those
# If not, find active runs in namespace
NAMESPACE="${INPUT_NAMESPACE:-fabrik-runs}"

# List all jobs
kubectl --kubeconfig "$KUBECONFIG" get jobs -n "$NAMESPACE"

# Filter for running/pending jobs
kubectl --kubeconfig "$KUBECONFIG" get jobs -n "$NAMESPACE" | grep -E "Running|Pending|Failed|Complete"

# Extract run IDs from job names (remove fabrik- prefix)
# fabrik-cf-pi-kimi-1776037020 → cf-pi-kimi-1776037020
```

**Step 3: Get initial status**
```bash
# For each discovered run:
RUN_ID="<run-id>"

# Get job status
kubectl --kubeconfig "$KUBECONFIG" get job -n "$NAMESPACE" fabrik-$RUN_ID

# Get pod status  
kubectl --kubeconfig "$KUBECONFIG" get pods -n "$NAMESPACE" -l "fabrik.sh/run-id=$RUN_ID"

# Get last log lines
kubectl --kubeconfig "$KUBECONFIG" logs -n "$NAMESPACE" "fabrik-$RUN_ID-<pod>" -c fabrik --tail=10
```

### Phase 2: Continuous Monitoring Loop

**For each run being monitored, execute this loop:**

```bash
CHECK_INTERVAL="${INPUT_INTERVAL:-900}"  # 15 minutes in seconds
MAX_CHECKS="${INPUT_MAX_CHECKS:-0}"        # 0 = unlimited

check_count=0
while [ "$MAX_CHECKS" -eq 0 ] || [ "$check_count" -lt "$MAX_CHECKS" ]; do
    check_count=$((check_count + 1))
    
    for RUN_ID in "${MONITORED_RUNS[@]}"; do
        monitor_run "$RUN_ID"
    done
    
    sleep "$CHECK_INTERVAL"
done
```

**Monitor single run function:**
```bash
monitor_run() {
    local RUN_ID="$1"
    local JOB_NAME="fabrik-$RUN_ID"
    
    # Get current status
    STATUS=$(kubectl --kubeconfig "$KUBECONFIG" get job -n "$NAMESPACE" "$JOB_NAME" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || echo "Unknown")
    FAILED=$(kubectl --kubeconfig "$KUBECONFIG" get job -n "$NAMESPACE" "$JOB_NAME" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || echo "Unknown")
    
    # Get pod
    POD=$(kubectl --kubeconfig "$KUBECONFIG" get pods -n "$NAMESPACE" -l "fabrik.sh/run-id=$RUN_ID" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
    
    if [ -n "$POD" ]; then
        # Running - get progress
        LOGS=$(kubectl --kubeconfig "$KUBECONFIG" logs -n "$NAMESPACE" "$POD" -c fabrik 2>&1 | grep -E "→|✓|✗" | tail -5)
        echo "[$RUN_ID] Running: $LOGS"
        
    elif [ "$FAILED" = "True" ]; then
        # Failed - analyze and restart
        echo "[$RUN_ID] FAILED - analyzing..."
        
        # Get failure reason
        FAIL_LOGS=$(kubectl --kubeconfig "$KUBECONFIG" logs -n "$NAMESPACE" -l "fabrik.sh/run-id=$RUN_ID" --previous -c fabrik 2>&1 | tail -20)
        
        # Classify failure
        if echo "$FAIL_LOGS" | grep -q "CLI idle timed out"; then
            echo "[$RUN_ID] Idle timeout - may need longer timeout or workflow stuck"
        elif echo "$FAIL_LOGS" | grep -q "no author and/or committer"; then
            echo "[$RUN_ID] Git config missing - need JJ_USER_NAME/JJ_USER_EMAIL"
        elif echo "$FAIL_LOGS" | grep -q "push failed"; then
            echo "[$RUN_ID] Git push failed - check remote/permissions"
        fi
        
        # Auto-restart if enabled
        if [ "$AUTO_RESTART" = "true" ]; then
            restart_run "$RUN_ID"
        fi
        
    elif [ "$STATUS" = "True" ]; then
        # Complete
        echo "[$RUN_ID] COMPLETE ✅"
        # Remove from monitored runs
        MONITORED_RUNS=("${MONITORED_RUNS[@]/$RUN_ID}")
        
    else
        # Pending or unknown
        echo "[$RUN_ID] Status: $STATUS / Failed: $FAILED"
    fi
}
```

### Phase 3: Auto-Restart Failed Runs

**Restart function with fixes:**
```bash
restart_run() {
    local RUN_ID="$1"
    local JOB_NAME="fabrik-$RUN_ID"
    
    echo "[$RUN_ID] Restarting..."
    
    # Get project from job labels
    PROJECT=$(kubectl --kubeconfig "$KUBECONFIG" get job -n "$NAMESPACE" "$JOB_NAME" -o jsonpath='{.metadata.labels.fabrik\.sh/project}' 2>/dev/null || echo "")
    
    # Get workflow path (need to know source)
    # This may need to be inferred or stored
    
    # Delete old job
    kubectl --kubeconfig "$KUBECONFIG" delete job -n "$NAMESPACE" "$JOB_NAME" 2>/dev/null
    sleep 2
    
    # Redispatch (requires fabrik CLI or kubectl apply)
    # This requires knowing the original dispatch parameters
    # May need to extract from job spec or have user provide
    
    echo "[$RUN_ID] Restarted - monitoring will resume"
}
```

### Phase 4: Progress Reporting

**After each check, output summary:**

```
=== Guardian Check N: TIMESTAMP ===

Active Runs: X | Complete: Y | Failed: Z

[RUN-ID-1] Status: Running | Phase: implement (12m) | Progress: validate → fix
[RUN-ID-2] Status: Complete ✅ | Duration: 15m | Result: Run finished
[RUN-ID-3] Status: Failed ❌ | Error: idle timeout | Action: Restarted

Next check in 15 minutes...
```

## Common Failure Patterns & Auto-Fixes

### Pattern 1: Idle Timeout (5 min → needs 15 min)
**Detection:** `CLI idle timed out after 300000ms`  
**Fix:** Update workflow `idleTimeoutMs: 300_000` → `900_000`  
**Auto-restart:** Yes, with updated workflow

### Pattern 2: Git Config Missing
**Detection:** `no author and/or committer set`  
**Fix:** Add `JJ_USER_NAME` and `JJ_USER_EMAIL` to env secret  
**Auto-restart:** Yes, after patching secret

### Pattern 3: API Hang (no output > 15 min)
**Detection:** `CLI idle timed out after 900000ms` (15 min)  
**Fix:** May be real API issue or workflow stuck  
**Auto-restart:** Yes, but monitor closely

### Pattern 4: Git Push Failures
**Detection:** `Bookmark push retry failed` or `Revision doesn't exist`  
**Fix:** Check remote branch exists, rebase issues  
**Auto-restart:** Yes, will retry

### Pattern 5: Provider/API Errors
**Detection:** `Missing FIREWORKS_API_KEY` or `unknown provider`  
**Fix:** Check secrets have required API keys  
**Auto-restart:** No, fix secrets first

## Output Format

**During monitoring (every check):**
```
=== Guardian Check N: TIMESTAMP ===

[RUN-ID] 🟢 Running | [last 3 tasks]
[RUN-ID] ✅ Complete | Duration: Xm | Finished
[RUN-ID] ❌ Failed | Error: [type] | Restarting...

[RUN-ID] Progress Timeline:
[00:00:00] → prepareRepo ✅
[00:00:18] → discover ✅
[00:02:45] → implement ✅ (2m27s)
[00:04:12] → validate ✅
[00:05:30] → fix (current, 3m elapsed)
```

**Final summary when all complete:**
```
=== GUARDIAN MISSION COMPLETE ===

All runs finished successfully:

| Run | Duration | Final Status | Restarts |
|-----|----------|--------------|----------|
| ID-1 | 15m | ✅ COMPLETE | 2 |
| ID-2 | 7m | ✅ COMPLETE | 1 |

Total monitoring time: X hours
Total restarts: N
Fixes applied: idle timeout, git config
```

## Quick Commands Reference

```bash
# Start monitoring with defaults (uses current kubectl context)
monitor_fabrik_runs()

# Monitor specific runs with explicit kubeconfig
monitor_fabrik_runs --kubeconfig ~/.kube/my-cluster --runs "id1,id2"

# Monitor with custom interval
monitor_fabrik_runs --interval 5m --namespace fabrik-runs

# One-shot status check
fabrik_status --run-id <id>

# Force restart a run
fabrik_restart --run-id <id>
```

## Guardrails

- **Never restart more than 10 times** - escalate to human after that
- **Check PVC exists** before restart - don't lose state
- **Preserve Smithers DB** across restarts - it's the source of truth
- **Report every restart** with reason and fix applied
- **Clean up old pods** after successful restart to avoid confusion
- **Verify image digest** unchanged on restart (immutable guarantee)

## Dependencies

- `kubectl` with cluster access
- `fabrik` CLI (for dispatch if available, or use kubectl)
- `jq` (optional, for json parsing)
- `sleep` (for interval timing)

---

## Quick References

See `fabrik-smithers-run-forensics` skill for deep investigation when runs fail repeatedly.
