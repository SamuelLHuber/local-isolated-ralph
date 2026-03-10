# Fabrik CLI Plan (run-and-sync -> gum-based CLI)

## Goal
Turn `k8s/run-and-sync.sh` into a “gold-standard” interactive CLI using `gum`, aligned with existing specs (especially `specs/051-k3s-orchestrator.md`) and suitable as the foundation for the Fabrik CLI. The initial CLI should wrap `kubectl`, provide sensible defaults, and template K8s resources to match the spec.

## Core Idea
Keep the exact behavior of `k8s/run-and-sync.sh`, but wrap it in a single entrypoint that:
- Reads config defaults (kube context, namespace, image digest, PVC size, storage class, auth/config paths).
- Uses `gum` for guided input and confirmation when flags aren’t provided.
- Emits and applies templated K8s YAML that includes required labels/annotations.
- Provides non-interactive flags for CI/automation.

## CLI Shape (initial “gold standard”)

Commands:
1. `fabrik run`
   - Interactive by default, prompts via `gum choose`/`gum input`.
   - Flags override prompts for automation.
2. `fabrik run sync`
   - Run the sync pod + `kubectl cp` only.
3. `fabrik run logs`
   - Fetch logs for a run id, optionally `-f`.
4. `fabrik run clean`
   - Deletes sync/clean pods and optionally the Job/PVC.
5. `fabrik run status`
   - Reads labels/annotations; prints a table.

## Required Prompts (when flags absent)
- Kube context (`kubectl config get-contexts`).
- Namespace (default `fabrik-runs`).
- Run ID (default: timestamp or user input).
- Image digest/tag (must be immutable per spec).
- PVC size (default `10Gi`).
- Pre-clean toggle (default true).
- Confirmation before apply.

## Spec Alignment Checklist
Must align to `specs/051-k3s-orchestrator.md`:
- Namespace default: `fabrik-runs`.
- Job name: `fabrik-<run-id>`.
- PVC name: `data-fabrik-<run-id>`.
- Required labels/annotations on Job/Pod:
  - Labels: `fabrik.sh/run-id`, `fabrik.sh/spec`, `fabrik.sh/project`, `fabrik.sh/phase`.
  - Annotations: `fabrik.sh/status`, `fabrik.sh/started-at`, `fabrik.sh/finished-at`, `fabrik.sh/outcome`.
- Enforce immutable image references (digest or pinned tag).
- Keep `ttlSecondsAfterFinished` and ownerReference for PVC GC.
- Local persistence: `~/.cache/fabrik/state.db`.

## Templating Strategy
Create K8s YAML templates and fill in via env substitution:
- `k8s/templates/job.yaml`
- `k8s/templates/pvc.yaml`
- `k8s/templates/sync-pod.yaml`
- `k8s/templates/clean-pod.yaml`

Template variables:
- `RUN_ID`, `NAMESPACE`, `IMAGE`, `PVC_NAME`, `PVC_SIZE`, `STORAGE_CLASS`, `LABELS`, `ANNOTATIONS`.

## Gum Usage (interactive UX)
Use:
- `gum choose` for kube context and namespace.
- `gum input` for run id/spec/project.
- `gum confirm` before cluster mutation.
- `gum spin` for `kubectl apply` and wait steps.
- `gum table` for status output.

## Minimal Implementation Plan
1. Add `scripts/fabrik` (shell) wrapper around kubectl + templates.
2. Add template YAMLs in `k8s/templates/`.
3. Keep output compatibility with current script: `k8s/job-sync/<run-id>/`.
4. If `gum` missing, fall back to non-interactive flags only.

## Validation & Testing (Gold Standard)
### 1) Static Template Validation (no cluster)
- Add `fabrik run --render` to output the exact YAML for all resources.
- Validate required labels/annotations and names via grep/jsonpath checks.
- Enforce immutable image reference (digest or pinned tag) in render mode.
 - Deterministic output: stable ordering for labels/annotations, fixed run-id in tests.

### 2) K8s Dry-Run Validation
- Add `fabrik run --dry-run` that runs `kubectl apply --dry-run=client -o yaml`.
- This ensures schema validity without a live cluster.

### 3) Live k3d Smoke Tests
- Use a disposable k3d cluster per `specs/057-k3s-local-testing.md`.
- Run CLI in non-interactive mode with all flags set.
- Verify:
  - Job completes successfully.
  - PVC has ownerReference to the Job.
  - Logs and sync artifacts exist in `k8s/job-sync/<run-id>/`.

### 4) TUI Automation (Interactive)
- Add `@microsoft/tui-test` as a dev dependency to drive gum prompts.
- Tests should:
  - Select kube context/namespace.
  - Enter run id/spec/project.
  - Confirm apply.
  - Assert “Done” and key status messages.
- Enable traces for debugging (tui-test config).

### 5) CI Behavior
- Default CI to non-interactive (`--non-interactive` or flags only).
- Run static/dry-run tests on every PR.
- Run k3d smoke tests on merge/nightly.
- Add a single fast validation loop command:
  - `fabrik run --validate --non-interactive --run-id test-123 --image <digest> --spec <spec> --project <project>`
 - Add GitHub Actions workflows to enforce these checks.
   - PR: render + dry-run + spec assertions (fast).
   - Merge/Nightly: k3d smoke test + optional TUI test.

## Tight Validation Loop (Developer Workflow)
- `fabrik run --render` for instant schema + spec checks (no cluster).
- `fabrik run --validate` to render + dry-run + spec assertions in one pass.
- Use golden YAML snapshots for stable outputs and low-cost regressions.
- Provide a fake `KUBECTL` hook in tests to capture applies without a cluster.

## Open Questions (to resolve before coding)
- Should `scripts/fabrik` replace `k8s/run-and-sync.sh` or wrap it as the executor?
- Where should default config live (e.g., `~/.config/fabrik/config.toml`)?
- Which fields are mandatory for the “gold standard” run (spec/project/phase)?
