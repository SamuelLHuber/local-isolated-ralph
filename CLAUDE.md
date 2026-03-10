# Fabrik

## Deployment Targets
- Linux and macOS local development via k3d (k3s in Docker)
- Production via k3s clusters on NixOS (see `specs/050-k3s-infrastructure.md`)

## Critical Rules
- K8s is the source of truth for runtime state.
- Use immutable image references for Jobs and keep resume on the same digest.
- Local persistence is a single DB: `~/.cache/fabrik/state.db`.

## Dependencies
- Do not add new direct dependencies without explicit approval.
- Keep versions pinned (no `latest`, `^`, `~`, `*`).

## Version Control
- Use `jj` for local history management in this repo.
- When upstreaming work, keep the corresponding git branch and jj bookmark aligned.
- Every commit message must be expansive and explain the intent clearly:
  - why the change was needed,
  - what goal the change is trying to achieve,
  - and what behavior or workflow is being improved or protected.

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
