# Fabrik

## Deployment Targets
- Linux and macOS local development via k3d (k3s in Docker)
- Production via k3s clusters on NixOS (see `specs/050-k3s-infrastructure.md`)

## Critical Rules
- K8s is the source of truth for runtime state.
- Use immutable image references for Jobs and keep resume on the same digest.
- Local persistence is a single DB: `~/.cache/fabrik/state.db`.
- Do not rebuild/publish the Smithers runtime image unless the container runtime contents changed.
- Dispatch-time changes do not require a new image:
  - `src/fabrik-cli/internal/run/*` manifest/render/dispatch changes only need a new `fabrik run` dispatch from updated local code.
  - `workflows/*.tsx` changes are bundled and mounted at dispatch time, so they only need a new dispatch.
  - repo code that the workflow clones only needs the branch/bookmark updated, then a new dispatch.
- Rebuild the image only when startup/runtime dependencies change, for example:
  - `k8s/Dockerfile`
  - installed tools like `git`, `jj`, `kubectl`, `smithers`
  - files baked into `/opt/smithers-runtime`

## Dependencies
- Do not add new direct dependencies without explicit approval.
- Keep versions pinned (no `latest`, `^`, `~`, `*`).

## Version Control
- Follow [`versioncontrol.md`](/Users/samuel/git/local-isolated-ralph/versioncontrol.md) for all version control behavior in this repo, including local `jj` usage, bookmark/branch alignment, workspace flow, publication, and commit message structure.

## Verification and Testing Policy
- Every new feature and every code change must be fully verified and tested before commit.
- Verification must be layered and principled:
  - fast deterministic unit/command tests first,
  - invariant-focused behavior assertions second,
  - local k3d integration verification for Kubernetes behavior when applicable.
- For `src/fabrik-cli`, required baseline before merging:
  - `make verify-cli` (or equivalent `go test ./...` in `src/fabrik-cli`),
  - k3d-gated integration verification for cluster-affecting changes (`make verify-cli-k3d`).
- Do not merge changes that bypass or weaken invariant checks (immutable image refs, non-interactive safety, render/dry-run guarantees).
