# Fabrik 

Fabrik runs as k3s-native Jobs/CronJobs with k3d for local/CI testing.

## Start Here
- Specs live in `specs/`.
- Active Kubernetes specs start at 05X.
- Local/CI testing is k3d-only (`specs/057-k3s-local-testing.md`).

## Key Specs
- `specs/050-k3s-infrastructure.md`
- `specs/051-k3s-orchestrator.md`
- `specs/052-k3s-orchestrator-dashboard.md`
- `specs/057-k3s-local-testing.md`
- `specs/060-security-hardening.md`
- `specs/061-incluster-optimizer.md`
- `specs/062-fabrik-laos-lint.md`
- `specs/063-benchmark-system.md`

## Notes
- Labels/annotations use the `fabrik.sh` domain (see `specs/051-k3s-orchestrator.md`).
