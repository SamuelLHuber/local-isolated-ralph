# Fabrik Learnings (Kubernetes-First)

## Core Principles
- K8s is the source of truth. Avoid dual databases or host-side state.
- Jobs/CronJobs only. No custom schedulers.
- Resume by recreating pods with the same PVC; never lose progress.
- Use immutable image references and keep resume on the same digest.
- Store derived data in a single local DB: `~/.cache/fabrik/state.db`.

## Operational Learnings
- Stuck pod recovery: delete the pod, let the Job recreate it with the same PVC.
- Health contracts must be explicit and shared across CLI/TUI/dashboard.
- Local/CI testing should be k3d-only with a local registry to avoid pull failures.

## Guardrails
- Never write state during render; always use `onFinished` callbacks.
- Avoid caches unless they materially improve performance.
- Keep labels/annotations consistent (`fabrik.sh/*`).
