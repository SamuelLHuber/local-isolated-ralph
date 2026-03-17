# Fabrik CLI Todo

This file is the execution plan for the remaining `fabrik-cli` work.

It is intentionally verification-first.

Nothing in this file should be marked done until:

1. the guarantee is stated clearly,
2. the verification layer for that guarantee exists,
3. the implementation is complete,
4. the required checks pass locally,
5. the relevant cluster verification passes in the right environment,
6. the result matches the applicable spec.

Workflow-managed completion is recorded by changing the item heading to `## <n>. Title [done]`.

## Core Rule

Build the verification layer first, then implement the feature, then check it off.

For every item below, "done" means:

- unit or command-level verification exists for the deterministic logic,
- cluster-facing verification exists for the intended execution environment,
- the user-facing contract is documented,
- the implementation matches the spec intent rather than only passing one happy path.

## Verification Ladder

Every CLI feature should be verifiable through these layers.

### Layer 1: Deterministic logic

Use fast tests for:

- option validation,
- manifest rendering,
- path resolution,
- env parsing,
- requirement resolution / preflight,
- metadata rendering,
- immutable image enforcement.

Expected command:

```bash
make verify-cli
```

### Layer 2: Invariant-focused CLI integration

Use focused integration tests for:

- kubectl apply / get / wait flows,
- secret mirroring,
- cron creation semantics,
- workflow bundle mounting,
- resume / cancel behavior,
- artifact sync behavior,
- metadata / labels / annotations.

These should assert invariants, not only "command exited 0".

### Layer 3: k3d single-node verification

This is the fast local cluster proof for:

- one-shot dispatch,
- cron creation,
- workflow startup,
- env secret injection,
- repo-aware workflow execution,
- resume / cancel / inspect flows.

Expected command:

```bash
make verify-cli-k3d
```

Default cluster:

- `dev-single`

Override when needed:

```bash
FABRIK_K3D_CLUSTER=dev-multi make verify-cli-k3d
```

### Layer 4: multi-node proof

Any feature touching scheduling, cron behavior, image distribution, or workflow execution semantics should also be proven on:

- `dev-multi`

If a feature only passes on `dev-single`, it is not done.

### Layer 5: same-cluster verifier Jobs

Cloud-dispatched workflow runs must not guess about cluster behavior or claim that nested `k3d` passed.

For cloud validation, the workflow should dispatch deterministic child verification Jobs into the same cluster and namespace family that the parent run is using.

Those Jobs must:

- use an immutable image digest,
- mount the same workspace PVC when workspace state matters,
- report success or failure from Kubernetes Job status and logs,
- fail the parent validation when a required verifier Job is skipped or cannot run.

This layer complements local `k3d` proof. It does not replace local single-node and multi-node verification for release readiness.

### Layer 6: production-parity check

For changes that materially affect execution semantics, the final check should eventually run against a real single-node `k3s` rootserver as described in:

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
- [`specs/057-k3s-local-testing.md`](/Users/samuel/git/local-isolated-ralph/specs/057-k3s-local-testing.md)

This is not required for every local iteration, but it is required before treating a major execution feature as truly finished.

## Definition Of Done Template

Every future task should be written in this shape:

### Task

Short statement of the user-facing outcome.

### Spec tie-in

List the exact spec sections or guarantees this implements.

### Guarantees

Flat list of what must be true when the task is complete.

### Verification to build first

Flat list of tests or checks that must exist before or alongside implementation.

### Required checks

Flat list of the commands and cluster checks that must pass before marking done.

### Documentation updates

What user-facing docs, sample docs, or code comments must change.

## Priority Order

The active order below is intentional. The next major work item is generic shared-credential rotation with verification defined up front. Completed items have been collapsed into an archive so this file stays focused on active work.

## Completed Work Archive

- Runs Inspection [done]
  Verified by workflow run `hoth-todo-loop-e2e-20260312-32`.
- Resume [done]
  Verified by unit and integration coverage for immutable image reuse, PVC continuity, and RBAC failures.
- Cancel [done]
  Verified by workflow run `hoth-todo-loop-e2e-20260312-32`.
- Verification Map [done]
  Verified by creation of [`specs/058-cli-verification-map.md`](/Users/samuel/git/local-isolated-ralph/specs/058-cli-verification-map.md).
- Env Promotion / Protected Environments [done]
  Verified by workflow run `hoth-todo-loop-e2e-20260312-39`.
- Retention / Cleanup [done]
  Verified by workflow run `hoth-todo-loop-e2e-20260312-39`.
- Security Hardening Alignment [done]
  Verified by workflow run `hoth-todo-loop-e2e-20260312-39`.
- Observability / Loki [done]
  Verified by workflow run `hoth-todo-loop-e2e-20260312-39`.
- Rootserver k3s Parity [done]
  Verified by workflow run `hoth-todo-loop-e2e-20260312-39` and [`specs/059-k3s-rootserver-parity.md`](/Users/samuel/git/local-isolated-ralph/specs/059-k3s-rootserver-parity.md).
- Sample Contract [done]
  Verified by workflow run `hoth-todo-loop-e2e-20260312-39`.

## 1. Shared Credential Rotation And Verification

### Task

Implement the shared credential bundle model defined in the specs and verify it across env-style credentials, file-backed bundles, and helper-layer rotation behavior.

### Spec tie-in

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
  - shared credential bundles
  - refreshable mount contract
  - separation of responsibilities
  - Kubernetes-native notification model
- [`specs/057-k3s-local-testing.md`](/Users/samuel/git/local-isolated-ralph/specs/057-k3s-local-testing.md)
  - shared credential verification requirements
- [`specs/058-cli-verification-map.md`](/Users/samuel/git/local-isolated-ralph/specs/058-cli-verification-map.md)
  - Shared Credential Bundles And Rotation
- [`specs/059-k3s-rootserver-parity.md`](/Users/samuel/git/local-isolated-ralph/specs/059-k3s-rootserver-parity.md)
  - follow-up parity scenarios to add once implementation exists

### Implementation checkpoints

- add generic shared-bundle selection and namespace mirroring in `src/fabrik-cli`
- replace rotation-sensitive `subPath` mounts with directory mounts
- support run-scoped override bundles that suppress cluster defaults for the same target
- keep provider-native parsing and pool rotation in helper utilities, not Fabrik core
- support Pi auth bundle mounting separately from adjacent Pi `models.json` config

### Verification gates

- implement the named L1-L6 checks in [`specs/058-cli-verification-map.md`](/Users/samuel/git/local-isolated-ralph/specs/058-cli-verification-map.md)
- pass `make verify-cli`
- pass `make verify-cli-k3d`
- pass `FABRIK_K3D_CLUSTER=dev-multi make verify-cli-k3d`
- add rootserver parity scenarios to [`specs/059-k3s-rootserver-parity.md`](/Users/samuel/git/local-isolated-ralph/specs/059-k3s-rootserver-parity.md) before marking done

## Ongoing Rule For Future Work

Before starting any new major CLI feature:

1. add the task here,
2. state the spec tie-in,
3. define the guarantees,
4. define the verification layer to build first,
5. only then implement.

If a task cannot explain how it will be verified, it is not ready to implement.
