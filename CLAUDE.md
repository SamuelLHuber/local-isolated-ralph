# Agent Rules

To learn more about why we are developing **fabrik** you can read ./WORKFLOW.md

## Deployment Targets

ALWAYS make sure that we provide compatibility with linux (libvirt) and macos (limactl).

see 
- ./SETUP-LINUX.md
- ./SETUP-MACOS.md

We additionally want to be able to deploy to Kubernetes in pods. Which is why every base image is NixOS. The declerative nature alows each environment and run to be reproducable and our deployment to target all of these systems.

## CRITICAL: State Management

### NEVER write `db.state` during render
- **PROHIBITED**: Any direct `db.state.set()` calls inside component render functions
- **PROHIBITED**: State transitions triggered synchronously during render phase
- **WHY**: Causes React error #185 (nested updates), reactive sqlite invalidation loops

### Use `onFinished` handlers for all task/review completions
- All state transitions for completed work must use `onFinished` callbacks
- Never transition state inline during render or in unguarded effects

### Guarded `useEffect` for edge cases only
- Only use `useEffect` for transitions that lack `onFinished` events:
  - "all reviewers complete" detection
  - "tasks complete on resume" transitions
- Must use stable one-time keys with `useRef` guard:

```tsx
const transitionKey = useRef<string>("");
useEffect(() => {
  if (!condition) return;
  const key = `${phase}:${index}`;
  if (transitionKey.current === key) return;
  transitionKey.current = key;
  db.state.set(...);
}, [phase, index]);
```

## CRITICAL: VM Self-Heal

### Every run must be self-sufficient
- Write `controlDir/smithers.pid` on startup
- Write `controlDir/heartbeat.json` every 30s (timestamp + phase)
- On startup: if stale pid exists (no live process), mark execution as failed and continue
- This enables host reconciliation without polling VM state

## CRITICAL: SQLite "string or blob too big" Error

### Root Cause
The smithers-orchestrator uses SQLite via drizzle-orm to store task outputs. SQLite has a maximum string/blob size limit (default ~1GB). When agent outputs exceed this limit during UPDATE operations, the error occurs.

### Common Triggers
- Very large spec files parsed into discovery output
- Agent generating massive JSON responses
- Accumulated error messages or stack traces in retry loops

### Recovery
Use the resume command with the `--fix` flag to truncate large database entries before resuming:

```bash
# Find the failed run ID
fabrik runs list

# Resume with database fix
fabrik run resume --id <run-id> --fix

# Without fix (if database is not corrupted)
fabrik run resume --id <run-id>
```

The `--fix` option runs a Python script in the VM that truncates entries larger than 500KB in the smithers database tables.

## CRITICAL: VCS Enforcement

### Every task with changes must push to VCS
- Block task completion on successful push to spec branch
- If push fails, task fails (do not advance)
- Support `jj git push --change @` when no branch name available
- Clear review artifacts before re-review so new reviews actually run

## CRITICAL: Host/VM Decoupling

### Host CLI reconciles before display
- `runs list/show/watch` must call `reconcile()` first
- Mark host DB status=failed with reason `stale_process` when:
  - VM run has no live PID, OR
  - heartbeat.json is stale (>60s)
- Orchestrator updates host DB when runs blocked/done

### VM is source of truth for execution state
- Host eventually consistent with VM via reconciliation
- VM can run standalone and resume independently
- Host may become remote controller later, but per-VM runs remain self-sufficient

## CRITICAL: Dependency Updates

### Always check before updating
- Run `fabrik deps check` before dependency bumps.
- This must include Bun dependency status plus Smithers pin drift vs `main`.

### Updates are explicit and opt-in
- For repo packages: run `fabrik deps update --bun`.
- For Smithers GitHub pin: run `fabrik deps update --smithers` (or `--smithers-ref <ref>`).
- Do not change Smithers install source back to npm package coordinates; keep GitHub pinning.

### Default policy: do not add dependencies
- Do not add new direct `dependencies` or `devDependencies` unless explicitly approved by a human.
- Keep dependency versions pinned (no `latest`, `^`, `~`, or `*` ranges) in `package.json`.
- CI enforces this via `bun run deps:policy`.
- Install local git hooks with `bun run hooks:install` so pre-commit runs the same check.

### Keep docs and embedded assets in sync
- When Smithers pin changes, ensure `nix/modules/ralph.nix`, `README.md`, and `QUICKSTART.md` are updated together.
- Regenerate embedded assets so `src/fabrik/embeddedAssets.ts` reflects doc changes.

## Summary

| Never Do | Always Do |
|----------|-------------|
| Write `db.state` during render | Use `onFinished` handlers |
| Unconditional state in effects | Guard with `useRef` + stable key |
| Assume host knows VM state | Write pid + heartbeat every 30s |
| Allow task complete without push | Block on VCS push success |
| Start fresh runs unnecessarily | Resume existing runs when possible |
