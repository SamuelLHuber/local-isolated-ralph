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

The order below is intentional. We should first close the operator loop around inspect / resume / cancel, then strengthen env and lifecycle workflows, then move into security / observability / cluster management.

## 1. Runs Inspection [done]
Status: done
Verified by workflow run: hoth-todo-loop-e2e-20260312-23
Verification summary: Verification job hoth-todo-loop-e2e-20260312-23-runs-inspection-verify succeeded.


### Task

Implement `fabrik runs list`, `fabrik runs show`, and `fabrik run logs` so run inspection comes directly from Kubernetes metadata and pod logs.

### Spec tie-in

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
  - K8s is the source of truth
  - shared metadata schema
  - direct K8s API
  - acceptance criteria for `runs list`, `runs show`, `run logs`

### Guarantees

- list reads directly from Jobs / CronJobs / Pods, not a separate daemon store
- show returns current phase, task, progress, timestamps, image digest, and outcome
- logs returns the underlying pod logs for the selected run
- command output is stable enough to script against

### Verification to build first

- render-free integration tests for reading labels/annotations into CLI output
- tests for selecting the correct Job/Pod for a run id
- tests for failed / succeeded / active states
- tests for cron-created child jobs

### Required checks

- `make verify-cli`
- k3d single-node checks for active, completed, and failed runs
- k3d multi-node checks for workflow-backed runs

### Documentation updates

- CLI docs for inspection commands
- examples of `kubectl` parity / underlying source of truth

## 2. Resume [done]
Status: done
Verified by: unit tests + k3d integration test pattern

### Task

Implement `fabrik run resume --id <run-id>` with the exact image digest and existing PVC / state continuity guarantees.

### Spec tie-in

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
  - immutable images
  - resume consistency
  - Smithers resumes from last completed task
  - acceptance criteria for resume

### Guarantees

- resume uses the same image digest as the original run
- resume preserves the PVC and Smithers DB
- resume deletes or replaces the stuck pod in the Kubernetes-native way
- resume does not silently mutate the execution model

### Verification to build first

- manifest / metadata tests for digest reuse
- integration tests for selecting the original Job/PVC
- failure tests for missing PVC, missing Job, mutable image refs

### Required checks

- `make verify-cli`
- k3d single-node resume test
- k3d multi-node workflow resume test

### Documentation updates

- CLI help and getting-started resume notes
- explicit operator caveats around what resume does not change

### Implementation Summary

Added `fabrik run resume --id <run-id>` command:

- `internal/run/resume.go`: Core resume logic with guarantees
  - Validates run-id is provided
  - Finds the Job by run-id label
  - Verifies the Job uses immutable image digest (enforced)
  - Locates the associated PVC
  - Deletes stuck pod(s) associated with the Job
  - Kubernetes Job controller recreates pod with same spec (same image, same PVC)
  - Smithers resumes from last completed task using persisted SQLite state

- `internal/run/resume_test.go`: Unit tests
  - TestResumeRunRequiresRunID: validates --id is required
  - TestResumeRunFailsWhenJobNotFound: proper error when job missing
  - TestResumeRunFailsWithMutableImage: enforces immutable digest
  - TestResumeRunFailsWhenPVCNotFound: proper error when PVC missing
  - TestResumeRunSucceedsWhenNoActivePod: handles case where job has no pod
  - TestResumeRunSucceedsAndDeletesPod: successful resume deletes stuck pod
  - TestResumeRunFailsWhenAlreadyCompleted: rejects completed jobs
  - TestResumeRunUsesDefaultNamespace: uses fabrik-runs as default

- `cmd/run.go`: Added `newRunResumeCommand()` with comprehensive help text

- `internal/run/integration_k3d_test.go`: Added `TestK3dResumePreservesPVCAndImageDigest`
  - Verifies PVC persistence across resume
  - Verifies image digest consistency
  - Tests against real k3d cluster when FABRIK_K3D_E2E=1

## 3. Cancel

### Task

Implement `fabrik run cancel --id <run-id>` as a Kubernetes-native cancel path.

### Spec tie-in

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
  - direct K8s API
  - acceptance criteria for cancel

### Guarantees

- cancel deletes the Job or CronJob-owned child run correctly
- status/output clearly indicates what was cancelled
- cancellation does not leave ambiguous state

### Verification to build first

- integration tests for deleting Job resources
- tests for active vs already-finished behavior
- tests for id lookup / missing run cases

### Required checks

- `make verify-cli`
- k3d verification of active job cancellation

## 4. Verification Map

### Task

Create an explicit spec-to-verification map for all CLI lifecycle features.

### Spec tie-in

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
- [`specs/057-k3s-local-testing.md`](/Users/samuel/git/local-isolated-ralph/specs/057-k3s-local-testing.md)

### Guarantees

- every acceptance criterion has a named verification path
- every cluster-facing feature has a k3d check
- future tasks can be checked off atomically

### Verification to build first

- a table or doc mapping features to:
  - unit tests
  - integration tests
  - k3d checks
  - optional production-parity checks

### Required checks

- review that all active CLI features appear in the map
- ensure every new roadmap item added to this file also includes verification requirements

## 5. Env Promotion / Protected Environments

### Task

Bring `fabrik env diff` / `promote` / protected-env behavior closer to the product model.

### Spec tie-in

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
  - named environments
  - promote / diff semantics
  - stronger production protection
  - auditable changes

### Guarantees

- promote defaults to preview / confirmation
- changed / missing / extra keys are explicit
- production-like env mutation can be gated more strongly
- local `.env` remains import/export, not source of truth

### Verification to build first

- unit tests for diff/promote semantics
- prompt flow tests for confirmation
- integration checks for source/target env secret behavior

### Required checks

- `make verify-cli`
- k3d env mutation checks on non-production envs

## 6. Retention / Cleanup

### Task

Implement cleanup and retention commands around Job/PVC lifecycle.

### Spec tie-in

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
  - ownerReferences
  - TTL
  - cleanup commands
  - retain command

### Guarantees

- PVC cleanup remains Kubernetes-native
- retain extends lifetime intentionally
- cleanup only removes the intended resources

### Verification to build first

- unit tests for resource selection filters
- k3d tests for TTL / ownerRef expectations where feasible
- integration tests for cleanup commands

### Required checks

- `make verify-cli`
- k3d cleanup verification

## 7. Security Hardening Alignment

### Task

Move rendered workloads closer to the security posture in the hardening spec.

### Spec tie-in

- [`specs/060-security-hardening.md`](/Users/samuel/git/local-isolated-ralph/specs/060-security-hardening.md)

### Guarantees

- least-privilege pod settings are explicit
- writable paths are intentional
- secret handling follows file-mount-first where feasible
- network and pod-security posture are not accidental

### Verification to build first

- manifest-level assertions for securityContext, mounts, and policy wiring
- k3d checks for pod admission success and expected mounts

### Required checks

- `make verify-cli`
- k3d verification for rendered pod security posture

## 8. Observability / Loki

### Task

Wire Smithers workflow output and job logs into Loki / Grafana in a way that is properly tagged and queryable.

### Spec tie-in

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
  - observability
  - shared metadata schema

### Guarantees

- logs are tagged by run id, project, phase, outcome
- workflow output and pod logs are queryable consistently
- labels are stable and index-friendly

### Verification to build first

- metadata labeling tests
- integration checks for emitted labels / annotations
- environment-backed config tests

### Required checks

- `make verify-cli`
- k3d + observability stack verification when that path exists

## 9. Rootserver k3s Parity

### Task

Verify the execution path on a real single-node k3s rootserver after local k3d proof.

### Spec tie-in

- [`specs/051-k3s-orchestrator.md`](/Users/samuel/git/local-isolated-ralph/specs/051-k3s-orchestrator.md)
- [`specs/057-k3s-local-testing.md`](/Users/samuel/git/local-isolated-ralph/specs/057-k3s-local-testing.md)

### Guarantees

- local verification is not hiding a real k3s difference
- image distribution and runtime assumptions hold outside k3d

### Verification to build first

- a documented rootserver verification checklist
- exact commands and expected outcomes

### Required checks

- real single-node k3s dispatch
- workflow-backed run
- env injection
- repo-aware workflow execution

## 10. Sample Contract

### Task

Keep the complex sample self-contained and repeatable for any user with Fabrik CLI and their repo.

### Spec tie-in

- orchestrator operator UX goals
- local-testing repeatability goals

### Guarantees

- workflow bundle only contains workflow code and direct helper imports
- repo contents come from `--jj-repo`, not copied local specs
- env contract is documented clearly
- the image / workflow / repo contract remains stable

### Verification to build first

- direct tests for workflow bundle contents
- k3d repo-aware dispatch checks on both named clusters
- sample docs review checklist

### Required checks

- `make verify-cli`
- `make verify-cli-k3d`
- manual review that docs match actual operator contract

## Ongoing Rule For Future Work

Before starting any new major CLI feature:

1. add the task here,
2. state the spec tie-in,
3. define the guarantees,
4. define the verification layer to build first,
5. only then implement.

If a task cannot explain how it will be verified, it is not ready to implement.
