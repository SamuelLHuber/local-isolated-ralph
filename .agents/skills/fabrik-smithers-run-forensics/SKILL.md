---
name: fabrik-smithers-run-forensics
description: Investigate and explain Smithers workflow runs on Fabrik Kubernetes clusters using kubectl, workspace PVC inspection, Smithers SQLite state, and remote branch/bookmark checks. Use when a user asks what happened in a run, why it failed, what code was produced, or what was pushed.
compatibility: Requires kubectl access to the target cluster/namespace, permission to read Jobs/Pods/PVCs/logs and exec temporary inspector Pods, plus git and either sqlite3 or python3 for DB queries.
metadata:
  author: fabrik
  version: "1.0.0"
  category: operations
---

# Fabrik Smithers Run Forensics

Use this skill when the user asks:
- “what did this run do?”
- “why did this Smithers run fail?”
- “what progress did the agent make?”
- “what code was produced?”
- “what actually got pushed?”

Goal: produce a high-confidence run narrative from **four sources of truth**:
1. Job/Pod logs (runtime timeline + visible errors)
2. Workspace PVC files (artifacts and outputs)
3. Smithers DB (`.smithers/state.db`) for structured execution state
4. Remote VCS branch/bookmark state for publication truth

---

## Required inputs to ask for (if missing)

- kubeconfig path (example: `~/.kube/hoth`)
- namespace (default usually `fabrik-runs`)
- run id or job name prefix (example: `onefootball-codefabrik-20260411-1725`)
- expected remote branch/bookmark (if user wants publish verification)

If inputs are incomplete, ask once, then proceed with best-effort discovery.

---

## Investigation flow

### 1) Locate run resources

- List Jobs and Pods in the namespace.
- Match by run-id in names and/or labels (`fabrik.sh/run-id`).
- Identify:
  - Job name
  - primary pod(s)
  - workspace PVC name (often from `FABRIK_WORKSPACE_PVC` env var or mount claim)

### 2) Read runtime logs first

- Pull `kubectl logs` from the `fabrik` container.
- Summarize:
  - node/task sequence
  - first hard failure
  - retried nodes
  - terminal error
- If there are multiple pods from retries, compare both quickly.

### 3) Inspect workspace PVC

Mount the run PVC into a short-lived inspector pod.
Check:
- `/workspace/.smithers/executions/<run-id>/logs/stream.ndjson`
- `/workspace/.smithers/state.db`
- `/workspace/repo` (or configured workdir)
- `/workspace/.fabrik/workflows` (workflow bundle used at runtime)

### 4) Query Smithers DB for exact state

Use sqlite (`sqlite3` or python `sqlite3`) to read:
- `_smithers_runs` (status + timings)
- `_smithers_attempts` (node-level attempts + failures)
- `_smithers_events` (typed event stream)
- node-specific output tables if present

Prefer concrete facts:
- run final status
- failing node + attempt + iteration
- normalized error code/message
- event counts and last failure events

### 5) Verify produced code and pushed state

Inside mounted repo:
- inspect working copy state (changed/uncommitted files)
- inspect local JJ/Git history around `@` and `@-`
- inspect relevant bookmark/branch pointers
Then verify remote truth:
- `git ls-remote <repo-url> <branch>`

Report differences clearly:
- “present on PVC but not pushed”
- “pushed to remote at commit X”

### 6) Optional: Loki gap callout

If available evidence is partial, explicitly state Loki would add:
- full agent trace completeness
- cross-pod/time-window log continuity
- richer search across runs

---

## Output format for users

Return concise sections:

1. **Run summary** (status, duration, failing stage)
2. **What happened** (timeline bullets)
3. **DB evidence** (key rows/fields)
4. **Workspace evidence** (files/artifacts/code state)
5. **Remote publication status** (branch/bookmark commit)
6. **Conclusion + next action** (exact fix path)

Always separate observed facts from inferences.

---

## Guardrails

- Kubernetes resources are source of runtime truth.
- Do not claim code was published without remote verification.
- If tooling missing in inspector image (e.g. `git`, `jj`, `sqlite3`), use a better-suited image or python fallback.
- Clean up temporary inspector pods.
- Redact secrets/tokens from logs and outputs.

---

## Mergable Convergence Criteria

Work is only considered "done" when it is **mergable** — ready for PR and merge to main. The workflow enforces this through explicit gates that block iteration completion until production-readiness is achieved.

### The Convergence Flow

```
implement → validate → review
                          ↓
              ┌─ NO ─→ fix (if validation failed)
              ↓
        slice approved? (review + validation pass)
                          ↓
              ┌─ NO ─→ mergable check fails
              ↓
        mergable? (lint clean, typecheck clean, no TODOs in diff)
                          ↓
              ┌─ NO ─→ mergableFix task (mandatory cleanup)
              ↓
         commit → push → discover next
```

### Mergable Gates (Enforced by Workflow)

| Gate | Verification Command | Failure Action |
|------|------------------------|----------------|
| **TypeCheck clean** | `bun run typecheck` | Block commit, trigger mergableFix |
| **Lint clean** | `bun run lint` | Block commit, trigger mergableFix |
| **No TODOs in diff** | `git diff` → grep for `TODO\|FIXME\|XXX\|HACK` | Block commit, trigger mergableFix |
| **Review approved** | `review.approved === true` | Loop review→fix→implement |
| **Validation passed** | `validation.success === true` | Loop fix→implement→validate |

Key principle: `sliceApproved` (review + validation) is necessary but **not sufficient**. The code must also be **mergable** (no lint/type/TODO debt).

### Investigating Convergence Failures

When runs iterate many times without completing:

1. **Check iteration counts by node:**
   ```sql
   SELECT node_id, COUNT(*) as attempts, MAX(iteration) as max_iter
   FROM _smithers_attempts
   WHERE run_id = ?
   GROUP BY node_id
   ORDER BY attempts DESC;
   ```
   - High `fix` or `mergableFix` counts → convergence struggle
   - High `review` with `approved=false` → review rejection loop

2. **Check for mergable blockers in logs:**
   Look for: `[codefabrik] Slice approved but NOT mergable:`
   
3. **Verify in workspace:**
   ```bash
   # In PVC inspector pod
   cd /workspace/repo
   bun run typecheck 2>&1 | head -20
   bun run lint 2>&1 | head -20
   git diff | grep -i "todo\|fixme" | head -10
   ```

4. **Common convergence blockers:**
   - Type errors in changed files (often from incomplete refactors)
   - Lint violations (unused imports, formatting)
   - TODOs left as "reminders" instead of being resolved
   - Test failures that validation catches but fix doesn't resolve

### Escalation Thresholds

If a ticket exceeds these iteration counts, suggest human review:
- `fix` > 8 attempts: Likely fundamental issue
- `mergableFix` > 3 attempts: Code quality discipline problem
- `review` > 5 attempts with `approved=false`: Specification mismatch

---

## Quick references

- For step-by-step command skeletons: `references/COMMANDS.md`
- For SQL snippets: `references/SQL.md`
