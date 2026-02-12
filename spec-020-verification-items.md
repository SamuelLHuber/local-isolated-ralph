# Spec 020 verification items (remaining)

This checklist captures the remaining verification-heavy tasks from `specs/020-fabrik-v0-2-0.todo.json`.
Each item includes the goal, suggested steps, and expected evidence.

## Current blockers / status
- **Bun EISDIR cache error in VM**: `EISDIR reading /home/ralph/.bun/install/cache/react@19.2.4.../index.js`.
  - Attempted cache reset: `rm -rf ~/.bun/install/cache ~/.bun/install/packages`.
  - Removed the specific cache entry: `rm -rf ~/.bun/install/cache/react@19.2.4*`.
  - Reinstalled smithers and re-ran; error persists after fresh `bun install` and Smithers start.
  - Next steps: try a clean Bun upgrade/downgrade in VM or isolate cache with `BUN_INSTALL_CACHE_DIR` during Smithers runs.

## 1) release-readiness
**Goal:** Ensure build + CLI smoke tests pass; update docs if needed.

**Steps:**
- `bun run build`
- CLI sanity:
  - `./dist/fabrik flow`
  - `./dist/fabrik known-issues`
  - `./dist/fabrik spec validate`
  - `./dist/fabrik spec minify`
  - `./dist/fabrik runs list`

**Evidence:** build succeeds; commands exit 0 with expected output.

## 2) test-vm-scripts (macOS + Linux)
**Goal:** Test VM scripts on real VMs for create/setup/fleet/multi-Ralph flows.

**Steps (macOS/Lima):**
- `./scripts/create-ralph.sh ralph-1 2 4 20`
- `./scripts/setup-base-vm.sh` (inside VM)
- `./dist/fabrik fleet --specs-dir specs --vm-prefix ralph`

**Steps (Linux/libvirt):**
- `./scripts/create-ralph.sh ralph-1 2 4 20`
- `./scripts/setup-base-vm.sh` (inside VM)
- `./dist/fabrik fleet --specs-dir specs --vm-prefix ralph`

**Evidence:** VMs created and fleet dispatch runs; reports appear in VM workdirs.

## 3) claude-auth-flow
**Goal:** Verify Claude auth persistence across VM snapshots.

**Steps:**
- Ensure `~/.claude.json` or `~/.claude` exists on host.
- `./dist/fabrik credentials sync --vm <vm>`
- Inside VM: run a small Claude command to confirm auth.
- Snapshot VM (Lima snapshot or libvirt snapshot).
- Restore snapshot and repeat Claude command.

**Evidence:** Claude works before/after snapshot restore.

## 4) git-credentials-vm
**Goal:** Verify PR creation from VM with GH auth.

**Steps:**
- `./dist/fabrik credentials sync --vm <vm>`
- Inside VM, in repo workdir:
  - `jj new main`
  - Make a small change
  - `jj describe`
  - `jj git push --change @`
  - `gh pr create`

**Evidence:** PR created successfully from VM.

## 5) jj-shared-workflow
**Goal:** Validate shared spec workflow using JJ inside VM.

**Steps:**
- Inside VM repo:
  - `jj new main -m "task-1"`
  - `jj new main -m "task-2"`
- Run a spec that targets multiple tasks.
- Confirm tasks land in the intended JJ changes and can be pushed.

**Evidence:** JJ changes exist with expected content; push succeeds.

## 6) vm-template-cloning
**Goal:** Document Lima snapshot cloning + libvirt virt-clone; measure time savings.

**Steps:**
- Lima: snapshot a base VM, clone from snapshot; measure time.
- libvirt: `virt-clone` from base image; measure time.
- Record timings in docs.

**Evidence:** Documentation with measured times and commands.

## 7) ci-cd-integration
**Goal:** Add CI docs + GitHub Actions example for Ralphs.

**Steps:**
- Draft docs with prerequisites for self-hosted runner.
- Provide minimal GH Actions workflow snippet.

**Evidence:** docs updated; example workflow included.

## 8) reproducible-standalone
**Goal:** Verify standalone binary works without local repo checkout.

**Steps:**
- Move/rename local repo or set `LOCAL_RALPH_HOME` to missing path.
- `LOCAL_RALPH_HOME=/tmp/ralph-missing ./dist/fabrik docs --topic workflow`
- `LOCAL_RALPH_HOME=/tmp/ralph-missing ./dist/fabrik spec validate`

**Evidence:** embedded assets extracted; commands succeed.

## 9) idempotency
**Goal:** Ensure fabrik run only writes to workdir + ~/.cache/fabrik.

**Steps:**
- Baseline file tree snapshot of home.
- Run `./dist/fabrik run ...` twice.
- Compare diffs outside workdir + ~/.cache/fabrik.

**Evidence:** No unexpected files modified outside intended paths.

## 10) orchestrator-script (verification)
**Goal:** Validate orchestrator workflow end-to-end on small fleet.

**Steps:**
- `./dist/fabrik orchestrate --specs <specs> --vms <vm list> --project . --include-git`
- Confirm per-VM runs complete and output is collected.

**Evidence:** runs complete; output summarises DONE/BLOCKED appropriately.

---

Notes:
- Items above are verification-heavy and require real VM interactions.
- For Linux validation, use libvirt + virsh/ssh paths.
