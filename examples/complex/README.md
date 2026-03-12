# Complex Sample: PI Spec Implementation

This workflow demonstrates an end-to-end implementation pipeline using Fabrik CLI with external repo awareness.

## What This Sample Demonstrates

- **Workflow-driven repo operations**: The workflow clones a target repo using `--jj-repo` and performs implementation work
- **Deterministic JJ operations**: Uses helper utilities for workspace preparation and bookmark pushing
- **Multi-phase validation**: Implements discover → implement → validate → review cycles
- **Self-contained execution**: Only workflow code and direct imports are bundled; repo specs come from `--jj-repo`

## Prerequisites

- Fabrik CLI built and available in your PATH
- Kubernetes cluster with Fabrik runtime image available
- Fireworks API key (for the PI agent)
- Codex auth files in `~/.codex/` (for agent authentication)

## Usage

```bash
fabrik run \
  --run-id pi-sample-$(date +%s) \
  --spec specs/051-k3s-orchestrator.md \
  --project pi-implementation \
  --env dev \
  --env-file .env.dispatch \
  --workflow-path examples/complex/pi-spec-implementation.tsx \
  --input-json '{}' \
  --jj-repo https://github.com/your-org/your-repo.git \
  --jj-bookmark feat/fabrik-pi-sample \
  --image fabrik-smithers@sha256:<digest> \
  --namespace fabrik-runs \
  --accept-filtered-sync \
  --wait
```

## Environment Contract

The complex sample expects these environment variables to be provided via `--env-file` or project env:

| Variable | Required | Description |
|----------|----------|-------------|
| `FIREWORKS_API_KEY` | Yes | API key for Fireworks AI (Kimi K2.5 model access) |
| `GITHUB_TOKEN` or `GH_TOKEN` | Optional | GitHub token for repo clone authentication |
| `JJ_USER_NAME` / `JJ_USER_EMAIL` | Optional | JJ/Git identity for commits |

The workflow receives these Fabrik-injected variables:

| Variable | Source | Description |
|----------|--------|-------------|
| `SMITHERS_JJ_REPO` | `--jj-repo` flag | Repository URL to clone |
| `SMITHERS_JJ_BOOKMARK` | `--jj-bookmark` flag | Bookmark to move and push |
| `SMITHERS_RUN_ID` | `--run-id` flag | Unique run identifier |
| `SMITHERS_WORKFLOW_PATH` | Derived | Path to mounted workflow bundle |
| `SMITHERS_INPUT_JSON` | `--input-json` flag | Workflow input parameters |

## Workflow Structure

```
examples/complex/
├── pi-spec-implementation.tsx    # Main workflow entry point
└── utils/
    ├── jj-shell.ts               # Deterministic JJ shell operations
    └── codex-auth-rotation.ts    # Auth rotation helper (not currently used)
```

## Bundle Contract Guarantees

When you dispatch this workflow:

1. **Only workflow code is bundled**: The bundle contains only `pi-spec-implementation.tsx` and `utils/jj-shell.ts` (the direct import)
2. **No specs included**: Repo specs come from `--jj-repo`, not from your local specs directory
3. **Immutable image required**: The runtime image must use a digest reference (`@sha256:`)
4. **Repo cloned at runtime**: The workflow clones the repo specified by `--jj-repo` into the Job pod

## Helper Utilities

### jj-shell.ts

Deterministic shell operations using Bun's `$` shell:

- `prepareWorkspaces()`: Creates JJ workspaces for parallel ticket processing
- `snapshotChange()`: Describes current change and opens a new one
- `pushBookmark()`: Moves bookmark to current change and pushes to origin

These operations are performed directly by the workflow (not delegated to LLM agents) for reproducibility.

## Verification

The bundle contents are verified by unit tests in:
`src/fabrik-cli/internal/run/workflow_bundle_test.go`

Run verification:
```bash
make verify-cli
```

K3d integration verification:
```bash
make verify-cli-k3d
```
