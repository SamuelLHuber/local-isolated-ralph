# Fabrik CLI Getting Started

This directory is the start of the Go-based `fabrik` CLI.

The immediate goal is to replace the ad hoc behavior in `k8s/run-and-sync.sh` with a maintainable Go command surface, starting with:

- `fabrik run`
- `fabrik run status`
- `fabrik run logs`
- `fabrik run resume`
- `fabrik run cancel`

The first development target is local `k3d`, because that gives us fast feedback for both single-node and multi-node cluster shapes before we verify against a real single-node `k3s` server.

## Stack Choice

We are using:

- `github.com/spf13/cobra` for command structure, flags, help text, and subcommands
- Charm Go libraries for operator UX where they add value
- `github.com/charmbracelet/huh` for the first prompt/form layer

This is an intentional split of responsibilities:

- Cobra owns the CLI architecture.
- Charm tooling improves the user experience.
- Kubernetes remains the source of truth for runtime state.

`Fang` is not the foundation here. If we want it later for nicer help output or extra polish, it can be added on top of Cobra, but the baseline implementation should stay understandable as plain Cobra commands with focused Charm integrations.

## Why Cobra

Cobra is the right base layer for Fabrik because we need:

- stable subcommands
- explicit flags for automation and CI
- shell completion support
- predictable help and usage output
- straightforward testing of command handlers

The Fabrik CLI is not just an interactive wizard. It also needs to work non-interactively for validation, CI, and scripted cluster operations. Cobra handles that well.

## Why Charm Libraries

Charm tooling is useful for the parts where the operator is making choices locally:

- choosing a kube context
- selecting a namespace
- confirming cluster mutations
- entering missing values interactively
- showing progress while we wait for `kubectl` or Kubernetes resources

For the first milestone, we should use Charm's Go libraries directly inside `fabrik`. We do not need to jump directly to a full-screen TUI.

Good initial uses for Charm libraries:

- `huh` input prompts for kube context and namespace
- `huh` input prompts for run id, spec path, project id, image reference
- confirmation before applying resources
- spinners while waiting on `kubectl apply`, `kubectl wait`, and sync steps

## Workflow Image Resolution

Workflow-backed runs do not need a manual `--image` when the Smithers runtime image has been published to GHCR.

The default behavior is:

- publish `k8s/Dockerfile` to `ghcr.io/<github-owner>/fabrik-smithers`
- tag the image with the default branch name (`main` or `master`) and a `sha-<commit>` tag
- when `fabrik run --workflow-path ...` is used without `--image`, the CLI:
  - derives the GitHub owner from the local `origin` remote
  - derives the default branch from `origin/HEAD`
  - resolves `ghcr.io/<owner>/fabrik-smithers:<default-branch>` to a registry digest
  - dispatches the Job with the immutable digest reference

This keeps the operator UX simple without violating the immutable-image rule.

Override behavior:

- set `FABRIK_SMITHERS_IMAGE` to force a specific image reference
- pass `--image` explicitly to override both the env var and auto-resolution

Recommended usage for production-like runs:

```bash
fabrik run \
  --run-id counter-rootserver \
  --spec specs/051-k3s-orchestrator.md \
  --project counter \
  --workflow-path examples/counter-local/workflow.tsx \
  --input-json '{"appName":"counter-rootserver-app"}' \
  --context default \
  --interactive=false
```

For workflows that should preserve repository history and push results back upstream, prefer dispatching from version control rather than relying on post-run artifact sync alone:

```bash
fabrik run \
  --run-id counter-rootserver \
  --spec specs/051-k3s-orchestrator.md \
  --project counter \
  --workflow-path examples/counter-local/workflow.tsx \
  --input-json '{"appName":"counter-rootserver-app"}' \
  --jj-repo https://github.com/example/counter-app.git \
  --jj-bookmark fabrik/counter-rootserver \
  --context default \
  --interactive=false
```

This maps to the workflow's existing `SMITHERS_JJ_REPO` / `SMITHERS_JJ_BOOKMARK` support in [`examples/counter-local/workflow.tsx`](/Users/samuel/git/local-isolated-ralph/examples/counter-local/workflow.tsx). The local sync output remains useful for logs and artifacts, but VCS fidelity should come from the repo-aware workflow path.

## Filtered Workflow Sync

Workflow artifact sync is intentionally filtered.

This is not a workspace sync feature.

The source of truth for repository state should be:

1. clone the repo inside the workflow with JJ/Git
2. inject a few local-only files such as `.env.local`

That means `.fabrik-sync` is a local secrets/config injection feature, not a way to mirror a local checkout into the cluster.

What is excluded from local post-run artifact sync:

- `.git`
- `.jj`
- large dependency trees such as `node_modules`

Why:

- round-tripping full VCS metadata through the Kubernetes API stream is slow and unreliable
- preserving repo state should happen inside the workflow by cloning and pushing through JJ/Git
- local post-run sync is for logs, generated outputs, and lightweight working files

Operator rule:

- workflow dispatch requires explicit acknowledgement of filtered sync
- interactive runs prompt for confirmation
- non-interactive runs must pass `--accept-filtered-sync`

Recommended pattern:

1. use `--jj-repo` and `--jj-bookmark` so the workflow prepares a real repo in-cluster
2. use `.fabrik-sync` as the manifest for a few small non-VCS files that need to be injected into the workspace, such as `.env.local`
3. do not treat local post-run artifact sync as the source of truth for repository history

Example `.fabrik-sync`:

```text
# small files only
.env.local
config/app.env
```

Rules enforced by the CLI:

- entries are relative paths only
- entries must be explicit file paths; directories are rejected
- `.git`, `.jj`, `node_modules`, `.next`, `dist`, and `build` are blocked
- symlinks are rejected
- files larger than 256 KiB are rejected
- total injected content larger than 1 MiB is rejected

When present, `.fabrik-sync` is bundled locally, mounted into the Job as a Secret, and extracted into `/workspace/workdir` before the workflow starts. You can override the manifest location with `--fabrik-sync-file`.

Verification path used for this implementation:

- unit tests cover allowed files, comments, blocked `.git` / `.jj` / `node_modules` / `.next` / `dist` / `build`, absolute paths, parent traversal, directory rejection, symlinks, per-file size overflow, and total-size overflow
- render tests verify the Secret mount and bootstrap extraction command
- live smoke tests dispatch the sample workflow to `k3d-dev-single` and `k3d-dev-multi`, then verify the injected files exist in the synced artifacts while blocked trees remain excluded

## Design Rules

The CLI must follow the existing Fabrik specs, especially:

- `specs/051-k3s-orchestrator.md`
- `specs/057-k3s-local-testing.md`

Important rules to preserve:

- Kubernetes is the source of truth.
- Jobs must use immutable image references.
- Resume must use the same image digest as the original run.
- Local persistence is a single SQLite DB at `~/.cache/fabrik/state.db`.
- `fabrik-runs` is the default namespace for run execution.

## Initial Command Scope

The first implemented command is:

```bash
fabrik run
```

Its job is to replace the shell dispatch flow in `k8s/run-and-sync.sh` with typed Go code.

The first slice should:

1. collect inputs from flags or Charm-powered prompts
2. validate required values
3. render Kubernetes resources
4. apply PVC + Job resources
5. set PVC owner references for TTL cleanup
6. wait for completion
7. save logs locally
8. sync artifacts back to `k8s/job-sync/<run-id>/`

The first slice should not try to implement every spec at once.

## Interactive vs Non-Interactive Behavior

We want both modes from the start.

Interactive mode:

- prompts when required values are missing
- uses Charm Go libraries
- optimized for local operator workflows

Non-interactive mode:

- all required values passed via flags
- no prompts
- safe for CI, tests, and automation

Rule of thumb:

- If a command may run in CI, it must be fully operable without interactive prompting.
- Charm UX should enhance the CLI, not become a hard requirement for automation.

## Suggested Project Layout

As implementation grows, keep the code split by responsibility rather than by command alone:

```text
src/fabrik-cli/
  cmd/
    root.go
    run.go
    run_status.go
    run_logs.go
  internal/
    config/
    kubectl/
    k8s/
    prompts/
    render/
    sync/
    validate/
  docs/
    getting-started.md
```

Suggested ownership:

- `cmd/`: Cobra command definitions and wiring
- `internal/prompts/`: Charm prompt and interaction integration
- `internal/render/`: manifest rendering
- `internal/k8s/`: Kubernetes object modeling and apply/wait logic
- `internal/sync/`: logs and artifact sync behavior
- `internal/validate/`: spec and input validation

## Development Workflow

Use local `k3d` first.

Single-node:

```bash
scripts/k3d/cluster.sh create single dev
scripts/k3d/cluster.sh verify single dev
```

Multi-node:

```bash
scripts/k3d/cluster.sh create multi dev
scripts/k3d/cluster.sh verify multi dev
```

Then exercise the CLI against those contexts before moving to a real rootserver `k3s` cluster.

## Validation Strategy

We should build validation into the CLI early:

- `fabrik run --render` to print the manifests without applying them
- `fabrik run --dry-run` to run Kubernetes client-side validation
- deterministic naming and metadata output for tests

This lets us verify spec alignment before we rely on a live cluster every time.

## Testing and Verification

Testing needs to cover both command behavior and interactive terminal behavior.

### Required test layers

1. Unit tests for pure logic:
   - input and flag validation
   - image reference and digest checks
   - manifest rendering defaults and metadata
2. Command tests for Cobra handlers:
   - expected stdout/stderr/help output
   - required flag handling in non-interactive mode
   - error paths without mutating cluster state
3. Interactive TUI tests for prompt flows:
   - keyboard navigation and selection behavior
   - confirmation/cancel paths
   - validation messages and retry loops
4. Integration verification against local `k3d`:
   - `fabrik run` end-to-end happy path
   - `--render` and `--dry-run` safety workflows
   - artifact sync outputs and expected files

### Microsoft TUI test library

For interactive terminal verification we use Microsoft's TUI testing approach:

- repository: `https://github.com/microsoft/tui-test`
- purpose: deterministic terminal interaction tests (keypresses, rendered frames, assertions)
- current implementation note: the library does not currently expose a stable Go module path/version for this repository, so we mirror the same testing model with deterministic injected terminal IO in Go tests until an importable pinned module is available.

When a stable Go module path is published, add it as a pinned development dependency in `src/fabrik-cli/go.mod` (no floating versions).

### Wiring requirements for proper TUI testing

To make the CLI testable with `tui-test`, we should wire the command runtime so tests can inject terminal IO and environment safely:

- keep `main.go` minimal (process wiring only)
- expose callable command/app constructors from packages under `cmd/` and `internal/`
- pass `io.Reader` / `io.Writer` dependencies instead of hard-coding `os.Stdin` / `os.Stdout`
- isolate prompt orchestration in `internal/prompts/` behind testable interfaces
- make terminal size, color, and animation behavior configurable for deterministic tests
- disable or stub spinner timing/animation in test mode

A practical target shape is:

- `cmd/`: returns configured Cobra commands usable by both `main.go` and tests
- `internal/prompts/`: wraps Charm interactions and can be driven by TUI tests
- `internal/...`: business logic invoked by commands without terminal coupling

### Verification checklist before merging

- `go test ./...` passes locally
- interactive flows have deterministic tests using the Microsoft `tui-test` testing model (currently implemented via injected IO harnessing in Go)
- non-interactive command paths are covered without prompts
- `--render` and `--dry-run` behaviors are asserted
- local `k3d` smoke checks confirm real-cluster compatibility

### Invariant assertions with this test approach

This pipeline lets us assert critical Fabrik invariants at multiple layers:

- immutable images are required (`latest` rejected, digest references accepted)
- project IDs remain DNS-1123 compliant
- render mode emits deterministic Kubernetes YAML without mutation
- dry-run mode validates through Kubernetes client-side checks
- interactive confirmation can cancel dispatch deterministically
- command output contracts stay stable for operator workflows and CI parsing

For local cluster verification with `k3d`:

1. create/verify cluster:
   - `scripts/k3d/cluster.sh create single dev`
   - `scripts/k3d/cluster.sh verify single dev`
2. run unit + command tests:
   - `go test ./...`
3. run env-gated `k3d` integration test layer:
   - `FABRIK_K3D_E2E=1 go test ./internal/run -run TestK3dRenderAndDryRun -v`
4. run CLI checks manually when needed:
   - `go run . run --render ...`
   - `go run . run --dry-run ...`
   - `go run . run ... --wait`
5. verify artifacts under `k8s/job-sync/<run-id>/`

## Implementation Guidance

When building commands in this module:

- keep command handlers thin
- put cluster and manifest logic in internal packages
- validate project IDs and image references before any mutation
- prefer typed manifest generation over stringly shell scripting
- preserve the existing artifact sync behavior while we migrate

The shell script is the behavior baseline, not the architecture baseline.

## Near-Term Roadmap

Phase 1:

- scaffold Cobra root command
- implement `fabrik run`
- support interactive prompting with Charm Go libraries
- verify on `k3d` single-node and multi-node

Phase 2:

- add `run status`
- add `run logs`
- add `run resume`
- add `run cancel`

Phase 3:

- verify on real single-node `k3s`
- extend toward the broader orchestrator and infrastructure specs

## Decision Summary

For this CLI:

- use Cobra as the foundation
- use Charm's Go libraries for interaction
- keep non-interactive execution first-class
- develop against local `k3d` first
- match Fabrik specs, not just the current shell script
