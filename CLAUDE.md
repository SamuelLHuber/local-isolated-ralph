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
