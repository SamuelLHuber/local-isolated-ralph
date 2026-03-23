# Fabrik CLI Getting Started

This directory is the start of the Go-based `fabrik` CLI.

The immediate goal is to replace the ad hoc behavior in `k8s/run-and-sync.sh` with a maintainable Go command surface, starting with:

- `fabrik run`
- `fabrik run status`
- `fabrik run logs`
- `fabrik run resume`
- `fabrik run cancel`

The first development target is local `k3d`, because that gives us fast feedback for both single-node and multi-node cluster shapes before we verify against a real single-node `k3s` server.

## Install From GitHub Releases

`fabrik` v0.1.1 is distributed through GitHub Releases for this repository:

- <https://github.com/SamuelLHuber/local-isolated-ralph/releases>

GitHub Releases is the canonical binary install source for v0.1.1.

To install, download the binary that matches your OS and CPU, mark it executable, move it onto your `PATH`, and verify the embedded build metadata with `fabrik version`.

macOS arm64 example:

```bash
curl -L -o fabrik-darwin-arm64 https://github.com/SamuelLHuber/local-isolated-ralph/releases/download/v0.1.1/fabrik-darwin-arm64
curl -L -o fabrik-sha256.txt https://github.com/SamuelLHuber/local-isolated-ralph/releases/download/v0.1.1/fabrik-sha256.txt
shasum -a 256 -c fabrik-sha256.txt --ignore-missing
chmod +x fabrik-darwin-arm64
mv fabrik-darwin-arm64 /usr/local/bin/fabrik
fabrik version
```

Linux x64 example:

```bash
curl -L -o fabrik-linux-x64 https://github.com/SamuelLHuber/local-isolated-ralph/releases/download/v0.1.1/fabrik-linux-x64
curl -L -o fabrik-sha256.txt https://github.com/SamuelLHuber/local-isolated-ralph/releases/download/v0.1.1/fabrik-sha256.txt
sha256sum -c fabrik-sha256.txt --ignore-missing
chmod +x fabrik-linux-x64
sudo mv fabrik-linux-x64 /usr/local/bin/fabrik
fabrik version
```

Expected `fabrik version` output includes:

- the release tag such as `0.1.1` or the default `dev` value for non-release builds
- the Git commit SHA
- the build timestamp in UTC
- the compiled platform

## Release Artifacts

The release workflow publishes these standalone binaries:

- `fabrik-darwin-arm64` for macOS on Apple Silicon
- `fabrik-linux-x64` for Linux on x86_64 / amd64
- `fabrik-linux-arm64` for Linux on arm64

The workflow also publishes:

- `fabrik-sha256.txt` with SHA-256 checksums for the released binaries

Artifact names come directly from [`.github/workflows/release.yml`](/Users/samuel/git/local-isolated-ralph/.github/workflows/release.yml).

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

- publish `k8s/Dockerfile` to `ghcr.io/<image-owner>/fabrik-smithers`
- tag the image with the default branch name (`main` or `master`) and a `sha-<commit>` tag
- when `fabrik run --workflow-path ...` is used without `--image`, the CLI:
  - first checks `FABRIK_SMITHERS_IMAGE` for an explicit immutable image reference override
  - otherwise checks `FABRIK_SMITHERS_REPO` for an explicit GHCR repository override such as `samuellhuber/fabrik-smithers`
  - otherwise derives the GitHub owner from the local `origin` remote and uses `ghcr.io/<owner>/fabrik-smithers`
  - derives the default branch from `origin/HEAD`, and falls back to `git remote show origin` when `origin/HEAD` is not configured
  - resolves `ghcr.io/<repo>:<default-branch>` to a registry digest
  - dispatches the Job with the immutable digest reference

This keeps the operator UX simple without violating the immutable-image rule.

Override behavior:

- set `FABRIK_SMITHERS_IMAGE` to force a specific image reference
- set `FABRIK_SMITHERS_REPO` to force the GHCR repository used for auto-resolution when the image owner differs from the repo owner
- pass `--image` explicitly to override both env vars and auto-resolution

If origin default-branch detection still cannot be resolved, either:

- run `git remote set-head origin <branch>` in the checkout, or
- pass `--image`, or
- set `FABRIK_SMITHERS_IMAGE`

For private GHCR packages, the CLI uses `GITHUB_TOKEN` or `GH_TOKEN` during GHCR bearer-token exchange when resolving the digest.

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
  --env dev \
  --env-file .env.counter \
  --workflow-path examples/counter-local/workflow.tsx \
  --input-json '{"appName":"counter-rootserver-app"}' \
  --jj-repo https://github.com/example/counter-app.git \
  --jj-bookmark fabrik/counter-rootserver \
  --context default \
  --interactive=false
```

This maps to the workflow's existing `SMITHERS_JJ_REPO` / `SMITHERS_JJ_BOOKMARK` support in [`examples/counter-local/workflow.tsx`](/Users/samuel/git/local-isolated-ralph/examples/counter-local/workflow.tsx). The local sync output remains useful for logs and artifacts, but VCS fidelity should come from the repo-aware workflow path.

When `--env-file` is provided together with `--project` and `--env`, the CLI updates the canonical env Secret in `fabrik-system` from that dotenv file and mirrors the validated data into the run namespace before dispatch. `fabrik-system` remains the source of truth; the run-namespace Secret exists so the Job Pod can consume it through standard `envFrom` / Secret volume wiring.

If the workflow clones a private GitHub repo over HTTPS, include `GITHUB_TOKEN=` (or `GH_TOKEN=`) in that env file. The Smithers runtime configures `GIT_ASKPASS` from those env vars so `git` / `jj git clone` can authenticate non-interactively inside the Job pod.

If a repo-backed workflow is expected to create or push commits, also include `JJ_USER_NAME=` and `JJ_USER_EMAIL=` in that env file. The runtime applies those values to both Git and JJ so commit creation and bookmark pushes do not fail on missing identity.

The PI sample workflow at [`examples/complex/pi-spec-implementation.tsx`](/Users/samuel/git/local-isolated-ralph/examples/complex/pi-spec-implementation.tsx) also expects `FIREWORKS_API_KEY=` in that same env file. The runtime materializes a self-contained Pi `models.json` for Fireworks-backed `accounts/fireworks/models/kimi-k2p5`, so the sample can clone a private GitHub repo and run PI against it without any extra in-pod setup.

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

When present, `.fabrik-sync` is bundled locally, mounted into the Job as a Secret, and extracted into `/workspace/workdir` before the workflow starts. Workflow source code is staged separately under `/workspace/.fabrik/workflows` so repo-backed workflows can clone directly into `/workspace/workdir` and let Smithers see the JJ/Git repository at its execution root. You can override the sync manifest location with `--fabrik-sync-file`.

For workflow-backed runs, Fabrik owns the Smithers runtime layout and exports a stable runtime contract into the pod:

- `SMITHERS_WORKFLOW_PATH=/workspace/.fabrik/...`
- `SMITHERS_WORKDIR=/workspace/workdir`
- `SMITHERS_DB_PATH=/workspace/.smithers/state.db`
- `SMITHERS_LOG_DIR=/workspace/.smithers/executions/<run-id>/logs`
- `SMITHERS_HOME=/workspace`

Workflow authors should treat `SMITHERS_DB_PATH` as the only stable hook for Smithers state. Do not derive the database or `.smithers` directory from `process.cwd()` when the workflow is intended to run under Fabrik.

Fabrik does not own agent-specific cache layout. For long-running cluster workflows, avoid putting large writable caches under `/tmp`, because the pod mounts `/tmp` as a bounded `emptyDir`. Large caches for Codex, Claude Code, Playwright, npm, browser downloads, or similar tooling should live on the workspace PVC under `/workspace/<tool-runtime>/...`, while small transient scratch files can still use `/tmp`.

Recommended workflow pattern:

```ts
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

const smithersDbPath =
  process.env.SMITHERS_DB_PATH ?? "./workflows/my-workflow.db"

mkdirSync(dirname(smithersDbPath), { recursive: true })
```

This keeps plain local runs working while allowing Fabrik-dispatched runs to use the runtime-managed state path automatically.

For repo-backed workflows, the intended layout is:

- `process.cwd()` and `SMITHERS_WORKDIR` are the workspace root, not the repo root
- clone the repo into a child directory under that root such as `join(process.cwd(), "repo")`
- do not clone directly into `SMITHERS_WORKDIR` itself
- keep Smithers state in `SMITHERS_DB_PATH` / `SMITHERS_LOG_DIR`, not under the repo checkout

The current contract for Fabrik-provided repo env is:

- `SMITHERS_JJ_REPO` and `SMITHERS_JJ_BOOKMARK` are raw workflow inputs
- Fabrik configures auth and identity for `git` / `jj`
- the workflow is responsible for deciding whether and where to clone

Recommended repo-backed pattern:

```ts
const workdir = process.cwd()
const repoDir = join(workdir, "repo")
const jjRepo = process.env.SMITHERS_JJ_REPO
const jjBookmark = process.env.SMITHERS_JJ_BOOKMARK

if (jjRepo) {
  if (jjBookmark) {
    await $`jj git clone --branch ${jjBookmark} ${jjRepo} ${repoDir}`.cwd(workdir)
  } else {
    await $`jj git clone ${jjRepo} ${repoDir}`.cwd(workdir)
  }
}
```

The canonical example today is [`examples/counter-local/workflow.tsx`](/Users/samuel/git/local-isolated-ralph/examples/counter-local/workflow.tsx). Follow that shape: workspace root at `process.cwd()`, checkout in a child directory, then run later `jj` commands from inside that checkout.

For JJ-backed workflows, version control safety is part of the workflow contract too:

- the workflow owns JJ state transitions inside the checkout
- `jj` commands should run from the repo checkout directory, not from the workspace root
- before `jj describe`, `jj bookmark set`, `jj git push`, or `jj new`, the workflow should verify it is inside a valid JJ repo and fail clearly if `.jj` is missing
- workflows should handle recoverable JJ state instead of assuming a pristine checkout every time

At minimum, repo-backed workflows should defend against:

- empty or undescribed working revisions left behind by interrupted earlier runs
- no-op changes where there is nothing meaningful to commit or push
- missing bookmarks or missing repo metadata in the target checkout
- failed `jj describe`, `jj new`, `jj bookmark set`, or `jj git push` calls that should stop the run with a clear error instead of silently corrupting the workflow state

The practical standard is:

- detect invalid or incomplete JJ state before mutating history
- recover when the state is obviously safe to repair, for example by abandoning an empty undescribed revision
- otherwise fail explicitly with a message that explains which JJ invariant was violated

If your workflow creates commits, it should encode these checks directly in the workflow logic rather than assuming Fabrik will repair JJ state for you.

Verification path used for this implementation:

- unit tests cover allowed files, comments, blocked `.git` / `.jj` / `node_modules` / `.next` / `dist` / `build`, absolute paths, parent traversal, directory rejection, symlinks, per-file size overflow, and total-size overflow
- render tests verify the Secret mount and bootstrap extraction command
- live smoke tests dispatch the sample workflow to `k3d-dev-single` and `k3d-dev-multi`, then verify the injected files exist in the synced artifacts while blocked trees remain excluded

## Current Execution Model

The CLI currently supports two execution inputs on the same `fabrik run` surface:

- `--job-command` for a direct shell-command Job or CronJob
- `--workflow-path` for a Smithers workflow-backed Job or CronJob

The reasoning is simple:

- one-shot runs and scheduled runs should share the same operator-facing command
- command mode keeps smoke tests and simple maintenance tasks easy to reason about
- workflow mode exercises the real Smithers runtime path we care about for production-like execution

Default live behavior for one-shot `fabrik run` is:

- apply resources
- verify the Job has started
- return

`--wait` is the explicit opt-in for completion tracking and local artifact sync.

## Cron Storage Model

`run --cron` creates Kubernetes `CronJob` objects.

Scheduled child runs do not reuse a single shared PVC. Instead, the CronJob pod template uses a generic ephemeral volume with a `volumeClaimTemplate`, so each spawned pod gets its own PVC.

We use this shape because:

- a shared PVC on the CronJob would couple unrelated scheduled runs
- `ReadWriteOnce` claims do not fit overlapping or back-to-back scheduled executions well
- per-run storage is easier to inspect, clean up, and reason about
- it stays close to the orchestrator spec without introducing a custom controller

The practical result is:

- one-shot Jobs: standalone per-run PVC objects
- CronJobs: one PVC per spawned pod, named by Kubernetes as `<pod-name>-workspace`

On k3d and k3s, this relies on the cluster storage class supporting generic ephemeral volumes. Our local `local-path` storage class supports this, so the k3d verification suite asserts it directly.

## Environment Model

Project environment data lives in Kubernetes Secrets in `fabrik-system`, named as `fabrik-env-<project>-<env>`.

The CLI now exposes the first env-management slice directly:

- `fabrik env set` to create or update a project environment Secret from a dotenv file or inline `KEY=value` pairs
- `fabrik env ls` and `fabrik env validate` to inspect the stored shape without printing secret values
- `fabrik env pull` to materialize a local dotenv file for developer workflows
- `fabrik env diff` and `fabrik env promote` to compare and copy named environments
- `fabrik env run -- <command>` to run a local command with the selected project environment injected
- `fabrik run --env <name> --env-file <path>` when a dispatch should upsert the canonical env Secret from a local dotenv file before the Job is created

The reasoning follows the orchestrator spec:

- Kubernetes is the source of truth for runtime env state
- named environments such as `dev`, `staging`, and `prod` stay explicit
- local pull is for developer ergonomics, not a second source of truth
- reserved runtime keys such as `SMITHERS_*` are not managed through project env Secrets

The current CLI slice is intentionally narrow:

- it manages project env Secrets only
- it does not yet implement the broader permission and audit model from the spec
- `env run` is local developer convenience, not cluster-side Job injection

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
8. optionally wait for completion and sync artifacts back to `k8s/job-sync/<run-id>/`

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
   - for the multi-node shape:
     - `scripts/k3d/cluster.sh create multi dev`
     - `scripts/k3d/cluster.sh verify multi dev`
2. run unit + command tests:
   - `go test ./...`
3. run env-gated `k3d` integration test layer:
   - `FABRIK_K3D_E2E=1 go test ./internal/run -run 'TestK3d' -v`
   - this covers both manual command flows and the sample Smithers workflow at `examples/counter-local/workflow.tsx`
   - for workflow-backed k3d verification, set `FABRIK_SMITHERS_IMAGE` to a cluster-pullable immutable image and ensure `fabrik-credentials` exists in `fabrik-system`
   - when testing against local k3d registries, push the image into the cluster-local registry and use that registry digest, not a bare local tag:
     - `docker tag fabrik-smithers:dev localhost:5111/fabrik-smithers:dev`
     - `docker push localhost:5111/fabrik-smithers:dev`
     - `docker tag fabrik-smithers:dev localhost:5112/fabrik-smithers:dev`
     - `docker push localhost:5112/fabrik-smithers:dev`
     - then dispatch with:
       - `dev-single-registry:5111/fabrik-smithers@sha256:<digest>`
       - `dev-multi-registry:5112/fabrik-smithers@sha256:<digest>`
4. run CLI checks manually when needed:
   - `go run . run --render ...`
   - `go run . run --dry-run ...`
   - `go run . run ...`
   - `go run . run ... --wait`
5. verify artifacts under `k8s/job-sync/<run-id>/` only for `--wait` flows

### Workflow Validation In Clusters

Workflow-backed validation is now cluster-native.

- parent Smithers workflow Jobs get a per-run ServiceAccount, Role, and RoleBinding in `fabrik-runs`
- the workflow pod receives downward-API identity:
  - `KUBERNETES_NAMESPACE`
  - `KUBERNETES_POD_NAME`
  - `KUBERNETES_NODE_NAME`
- validation can dispatch child verification Jobs into the same cluster instead of guessing from agent output
- child verification Jobs mount the same workspace PVC, run deterministic commands, and return success/failure from Kubernetes Job state plus logs

This means:

- local development still uses `k3d` as the fast cluster proof
- cloud runs on `k3s`/`hoth` do not need nested `k3d`
- workflow validation should fail if a required verifier Job cannot be created or if its required checks do not pass

## Implementation Guidance

When building commands in this module:

- keep command handlers thin
- put cluster and manifest logic in internal packages
- validate project IDs and image references before any mutation
- prefer typed manifest generation over stringly shell scripting
- preserve the existing artifact sync behavior while we migrate

The shell script is the behavior baseline, not the architecture baseline.

## Run Inspection Commands

The runs inspection commands provide direct access to Kubernetes resources, reading from Jobs, CronJobs, and Pods using the shared metadata schema defined in `specs/051-k3s-orchestrator.md`.

### `fabrik runs list`

Lists all Fabrik runs across Jobs and CronJobs in the configured namespace:

```bash
# List runs in default namespace
fabrik runs list

# List runs in a specific namespace
fabrik runs list --namespace fabrik-runs

# List runs with a specific context
fabrik runs list --context my-cluster

# Output as JSON for scripting
fabrik runs list -o json

# Output just run IDs (useful for piping)
fabrik runs list -o name
```

The output shows:
- Run ID (ULID format)
- Project
- Phase (e.g., plan, implement, review, complete)
- Status (e.g., pending, active, succeeded, failed)
- Current task
- Progress (finished/total)
- Age
- Type (job or cron)

### `fabrik runs show`

Shows detailed information about a specific run:

```bash
# Show run details
fabrik runs show --id 01JK7V8X1234567890ABCDEFGH

# Show as JSON
fabrik runs show --id 01JK7V8X1234567890ABCDEFGH -o json

# Show as YAML-like output
fabrik runs show --id 01JK7V8X1234567890ABCDEFGH -o yaml
```

The output includes:
- Run metadata (ID, project, spec)
- Current phase and status
- Task and progress
- Timestamps (started, finished)
- Image digest
- Outcome (succeeded, failed, cancelled)
- Pod and Job names
- Cron schedule (if CronJob)

### `fabrik run logs`

Retrieves logs from the pod running a Fabrik run:

```bash
# Get last 200 lines of logs (default)
fabrik run logs --id 01JK7V8X1234567890ABCDEFGH

# Get last 1000 lines
fabrik run logs --id 01JK7V8X1234567890ABCDEFGH --tail 1000

# Stream logs in real-time
fabrik run logs --id 01JK7V8X1234567890ABCDEFGH --follow

# Get logs from previous container instance (after restart)
fabrik run logs --id 01JK7V8X1234567890ABCDEFGH --previous
```

### `fabrik run cancel`

Cancels a running Fabrik run by deleting its Job:

```bash
fabrik run cancel --id 01JK7V8X1234567890ABCDEFGH
```

### `fabrik run resume`

Resumes a stuck Fabrik run by deleting its pod, causing the Job controller to recreate it. Progress is preserved in the PVC:

```bash
fabrik run resume --id 01JK7V8X1234567890ABCDEFGH
```

**Guarantees:**
- Uses the same immutable image digest as the original run (rejects mutable tags like `:latest`)
- Preserves the PVC and Smithers SQLite state across pod restarts
- Deletes only the pod; the Job controller recreates it with identical spec
- Does not mutate execution model (image, command, env, resources remain unchanged)

**Requirements:**
- The Job must exist and be active (not already succeeded/failed)
- The PVC must exist and be Bound
- The image must use a digest reference (`repo/image@sha256:<digest>`)

**RBAC Requirements:**
The service account used by the CLI must have permission to delete pods in the target namespace. Apply the RBAC configuration from `k8s/rbac.yaml`:

```bash
kubectl apply -f k8s/rbac.yaml
```

Required permissions for resume:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: fabrik-runner
  namespace: fabrik-runs
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "delete"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list"]
```

**Troubleshooting RBAC Errors:**

If you see an error like:
```
Error from server (Forbidden): pods "..." is forbidden: User "system:serviceaccount:fabrik-runs:..." cannot delete resource "pods"
```

Verify the RoleBinding is applied:
```bash
kubectl get rolebinding -n fabrik-runs fabrik-runner-verifiers -o yaml
```

For in-cluster workflows (verification jobs, CI runners), ensure the pod's service account is bound to the `fabrik-runner` role. The `k8s/rbac.yaml` includes a RoleBinding for the `system:serviceaccounts:fabrik-runs` group that grants permissions to all service accounts in the namespace.

**Operator Caveats:**
- Resume does NOT change the image, command, or environment
- Resume does NOT reset the Smithers state; it continues from the last completed task
- Resume does NOT work on CronJobs (resume their child Jobs instead)
- If the Job spec itself needs changes, cancel and create a new run
- Resume relies on the Job controller retry budget. Fabrik Jobs use `backoffLimit: 1` so deleting the active pod leaves one controller recreation attempt available.
- If you supply your own Job spec outside Fabrik, ensure its retry policy still allows controller recreation after a resume-triggered pod delete.

### kubectl Parity

All inspection commands read directly from Kubernetes and provide kubectl-equivalent access:

```bash
# fabrik runs list is equivalent to:
kubectl get jobs -n fabrik-runs -l fabrik.sh/managed-by=fabrik
kubectl get cronjobs -n fabrik-runs -l fabrik.sh/managed-by=fabrik

# fabrik runs show --id <id> is equivalent to:
kubectl get job -n fabrik-runs -l fabrik.sh/run-id=<id> -o yaml
kubectl get pod -n fabrik-runs -l fabrik.sh/run-id=<id> -o yaml

# fabrik run logs --id <id> is equivalent to:
kubectl logs -n fabrik-runs -l fabrik.sh/run-id=<id>
```

The Fabrik CLI provides a higher-level, more stable interface that parses the shared metadata schema and presents human-readable output.

## Near-Term Roadmap

Phase 1:

- scaffold Cobra root command
- implement `fabrik run`
- support interactive prompting with Charm Go libraries
- verify on `k3d` single-node and multi-node

Phase 2 (completed):

- add `fabrik runs list`
- add `fabrik runs show`
- add `fabrik run logs`
- add `fabrik run cancel`
- add `fabrik run resume`

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
