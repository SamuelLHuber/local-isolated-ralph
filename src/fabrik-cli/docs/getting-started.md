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
