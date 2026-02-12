# Smithers v0.4.0 Migration TODO

## Scope
- [ ] Complete migration to Smithers `v0.4.0` runtime/API for Ralph workflows.
- [ ] Remove any operational dependency on legacy Smithers invocation semantics.
- [ ] Verify Linux (libvirt) and macOS (limactl) execution paths.

## Status Snapshot
- [x] Feature branch created: `feat/smithers-v0.4.0-migration`
- [x] Pin updated to `ebe18cb5370c0a9a1542da036aba016a02f0ae1e` in:
- [x] `nix/modules/ralph.nix`
- [x] `README.md`
- [x] `QUICKSTART.md`
- [x] Dispatch switched to `smithers run` / `smithers resume` in:
- [x] `src/fabrik/dispatch.ts`
- [x] `scripts/dispatch.sh`
- [x] v0.4-style workflow files in place:
- [x] `scripts/smithers-spec-runner.tsx`
- [x] `scripts/smithers-reviewer.tsx`
- [x] Embedded assets regenerated (`src/fabrik/embeddedAssets.ts`)

## Remaining Implementation Work
- [ ] Validate `scripts/smithers-spec-runner.tsx` behavior parity vs required policies:
- [ ] VCS enforcement: block completion on failed push.
- [ ] Review loop correctness and max retry semantics.
- [ ] Human gate generation semantics.
- [ ] Rate-limit handling + resume semantics.
- [ ] Ensure phase reporting (`phase.json`) is always written for heartbeat.
- [ ] Validate `scripts/smithers-reviewer.tsx` standalone reviewer behavior.
- [ ] Confirm `--resume` path in `scripts/dispatch.sh` works with real prior run state.
- [ ] Review docs for stale examples/wording and align with v0.4 CLI usage.
- [ ] Remove deprecated/legacy references that could confuse operators.

## Verification Plan

### A) Build + Static Validation
- [ ] `bun run build` passes.
- [ ] `./dist/fabrik deps check` reports Smithers up-to-date.
- [ ] `bunx github:evmts/smithers#ebe18cb5370c0a9a1542da036aba016a02f0ae1e --help` works.

### B) Local Runtime Smoke
- [ ] Execute a minimal v0.4 workflow with:
- [ ] `smithers run <workflow.tsx> --run-id <id> --input '{}'`
- [ ] Confirm artifacts created:
- [ ] `.smithers/*` DB state
- [ ] `reports/*.json`
- [ ] `controlDir/phase.json` when dispatch wrapper is used

### C) macOS VM E2E
- [ ] `./scripts/dispatch.sh --spec <spec.min.json> <vm> <spec.min.json>` succeeds.
- [ ] Host run row transitions from `running` to terminal status.
- [ ] `smithers.pid` and `heartbeat.json` are created and updated.
- [ ] `fabrik runs list/show/watch` reconcile correctly with heartbeat threshold.

### D) Linux VM E2E
- [ ] Run same dispatch smoke on libvirt VM.
- [ ] Validate SSH path, run script path, report output, and terminal status.
- [ ] Validate stale process handling sets host failure reason as `stale_process`.

### E) Resume + Failure Handling
- [ ] Kill Smithers process mid-run; verify reconcile marks stale correctly.
- [ ] Resume run via `--resume` and verify continued progress.
- [ ] Simulate failed push; verify run blocks/fails as expected and reports reason.

### F) Review Workflow Validation
- [ ] Multi-reviewer outputs (`review-*.json`) are produced.
- [ ] `review.json` aggregation is correct.
- [ ] `human-gate.json` emitted on approval/max-retry boundary conditions.

## Acceptance Criteria
- [ ] Default dispatch path uses only Smithers v0.4 CLI contract (`run/resume`).
- [ ] Linux and macOS E2E smoke passes.
- [ ] Reconcile + stale detection + host DB reason fields are correct.
- [ ] Workflow artifacts and review loop outputs match expected contract.
- [ ] Docs and embedded assets are fully in sync with implemented behavior.

## Nice-to-Have Follow-Ups
- [ ] Add automated integration tests for `dispatch -> run -> reconcile`.
- [ ] Add a dedicated migration note in `WORKFLOW.md` with old/new command examples.
- [ ] Add CI smoke for a minimal v0.4 workflow execution.
