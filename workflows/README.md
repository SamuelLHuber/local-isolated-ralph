# Workflow Samples

This directory holds dispatchable Smithers workflows that are self-contained under a single bundle root.

## `todo-driver.tsx`

This workflow is for repositories that keep a verification-first execution plan in a root `todo.md`.

Dispatch contract:

```bash
fabrik run \
  --project fabrik \
  --env dev \
  --env-file .env \
  --workflow-path workflows/todo-driver.tsx \
  --jj-repo https://github.com/<owner>/<repo>.git \
  --jj-bookmark feat/<branch> \
  --accept-filtered-sync \
  --interactive=false
```

What it does:

- stages workflow code under `/workspace/.fabrik/workflows`
- clones the target repo into `/workspace/workdir`
- stores workflow control/runtime state under repo-local `.fabrik/`, including the Smithers DB at `.fabrik/smithers/todo-driver.db`
- uses the same control-root layout in local and cluster environments so workflow state paths stay identical across verification contexts
- reads `todo.md` from the cloned repo root
- runs a single monolithic Ralph loop that always picks the next highest-priority unfinished todo item
- keeps one active todo item sticky until that item either completes publication or becomes blocked; backlog planning must not switch items mid-flight
- blocks if the todo item is missing `Spec tie-in`, `Guarantees`, `Verification to build first`, or `Required checks`
- uses the repo working copy itself as the JJ-backed execution workspace
- snapshots progress with JJ after each implementation loop and after completion
- marks a completed item in `todo.md` as `## <n>. Title [done]` only after verifier success and review approval
- validates through same-cluster child verification Jobs instead of trusting agent summaries alone
- runs a review gate for spec alignment, maintainability, and verification evidence before reporting `done`
- feeds reviewer issues back into the next Ralph loop iteration instead of running a separate nested review-fix loop
- derives the current item phase from live Smithers outputs (`implement`, `validate`, `review`, `report`) rather than latching a planner-owned phase across iterations
- builds review context from the latest JJ diff summary (`jj diff --summary -r @-`) so reviewer file context reflects actual repo changes instead of agent self-reporting
- ignores reviewer complaints that only claim missing context when the workflow already provided the todo item, diff summary, and validation evidence

## Agent Timeouts

The workflow configures agent timeouts to catch hung API calls:

| Timeout | Default | Purpose |
|---------|---------|---------|
| `timeoutMs` | 4 hours | Hard limit for long tasks |
| `idleTimeoutMs` | 5 minutes | Resets on stdout/stderr; catches stuck API calls |

The idle timeout is recommended for all PiAgent configurations (`piReadAt`, `piWriteAt`, `piReviewAt`)—it allows active work (compiling, testing) to run for the full hour, but kills the task if no output appears for 5 minutes (typical symptom of a hung API connection).

## Workflow Structure

Workflows must be **synchronous** at the top level. The `smithers()` wrapper expects a synchronous function that returns JSX immediately:

```typescript
// ✅ Correct: synchronous workflow function
export default smithers((ctx) => {
  return renderWorkflow(ctx, ...)
})

function renderWorkflow(ctx, ...) {
  // Synchronous logic only
  return (
    <Workflow>...</Workflow>
  )
}
```

**Common mistake:** Making `renderWorkflow` async causes the workflow to finish immediately without running tasks. Move async operations (shell commands, file checks) into Task functions, not the workflow render function:

```typescript
// ❌ Wrong: async render function
async function renderWorkflow(ctx) {
  const result = await shell("bun run typecheck")  // Don't do this
  ...
}

// ✅ Correct: async inside Task
<Task id="validate">
  {async () => {
    const result = await shell("bun run typecheck")
    return result
  }}
</Task>
```

Required runtime inputs:

- `SMITHERS_JJ_REPO` via `--jj-repo`
- `FIREWORKS_API_KEY` in `--env-file` for the PI agent model
- `GITHUB_TOKEN` or `GH_TOKEN` in `--env-file` if the repo is private
- `JJ_USER_NAME` and `JJ_USER_EMAIL` in `--env-file` when the workflow is expected to create or push commits

Workflow runner requirements:

- the Fabrik-dispatched workflow Job must be able to authenticate to its cluster with the in-cluster ServiceAccount token
- the workflow pod needs enough RBAC in `fabrik-runs` to create, watch, and delete child Jobs and read Pod logs
- same-cluster verifier Jobs use the same immutable image digest and the same workspace PVC as the parent workflow run

Local k3d testing note:

- for local `dev-single` / `dev-multi`, use cluster-local registry digests instead of plain local tags
- Fabrik enforces immutable image references, and Kubernetes will only pull the image if the digest points at a registry the cluster can reach

Optional runtime inputs:

- `SMITHERS_JJ_BOOKMARK` via `--jj-bookmark`
- `MAX_TODO_ITEMS` in the env file if you want the planner to consider more than the default single-item selection window

Operational learnings from production clusters:

- dispatch-time workflow and manifest fixes only require a new `fabrik run` dispatch; do not rebuild the Smithers image unless runtime contents changed
- verifier gates should stay deterministic and stable; exploratory cluster and CLI-against-cluster checks belong in implementation/review as supporting evidence
- if the workflow starts repeating `validate`, inspect `.fabrik/smithers/todo-driver.db` on the workspace PVC before changing prompts; the persisted planner and validator rows will show whether the bug is state-machine logic or a real verifier failure

The workflow assumes `todo.md` uses this section shape for each executable item:

- `### Task`
- `### Spec tie-in`
- `### Guarantees`
- `### Verification to build first`
- `### Required checks`
- `### Documentation updates`

If the next unfinished item does not meet that contract, the workflow reports a blocked result instead of guessing.
