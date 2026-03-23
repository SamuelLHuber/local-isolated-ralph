# Complex Samples

This directory contains end-to-end workflow samples for Fabrik CLI plus reusable workflow helpers from `@dtechvision/fabrik-runtime`.

## Included Samples

- `pi-spec-implementation.tsx`: PI-based multi-phase repo implementation pipeline
- `codex-auth-rotation-sample.tsx`: minimal Codex workflow using the shared auth-pool helper

## What This Sample Demonstrates

- **Workflow-driven repo operations**: The workflow clones a target repo using `--jj-repo` and performs implementation work
- **Deterministic JJ operations**: Uses helper utilities for workspace preparation and bookmark pushing
- **Multi-phase validation**: Implements discover → implement → validate → review cycles
- **Self-contained execution**: Only workflow code and direct imports are bundled; repo specs come from `--jj-repo`
- **Codex auth rotation**: Codex workflows can import the runtime helper and rotate across mounted `auth.json` / `*.auth.json` pools

## Prerequisites

- Fabrik CLI built and available in your PATH
- Kubernetes cluster with Fabrik runtime image available
- Fireworks API key (for the PI agent)
- `fabrik-credentials` secret in `fabrik-system` with required API keys

## PI Workflow Usage

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

## Codex Auth Rotation Usage

Use this sample when you want the smallest checked-in workflow that proves `@dtechvision/fabrik-runtime/codex-auth` is available in the runtime image.

Run with a cluster-shared credential bundle:

```bash
fabrik run \
  --run-id codex-rotation-sample-$(date +%s) \
  --spec specs/051-k3s-orchestrator.md \
  --project codex-rotation-sample \
  --env dev \
  --workflow-path examples/complex/codex-auth-rotation-sample.tsx \
  --input-json '{}' \
  --image fabrik-smithers@sha256:<digest> \
  --namespace fabrik-runs \
  --accept-filtered-sync \
  --wait
```

Verify the run afterwards:

```bash
fabrik runs inspect --id <run-id>
fabrik run logs --id <run-id> --follow
```

In the logs you should see the runtime helper lines:

- `codex auth rotation ...`
- `codex auth pool summary: ...`

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
├── codex-auth-rotation-sample.tsx  # Minimal Codex sample using @dtechvision/fabrik-runtime/codex-auth
├── pi-spec-implementation.tsx    # Main workflow entry point
└── utils/
    └── codex-auth-rotation.ts    # Re-export from @dtechvision/fabrik-runtime/codex-auth
```

## Bundle Contract Guarantees

When you dispatch this workflow:

1. **Only workflow code is bundled**: The bundle contains only `pi-spec-implementation.tsx`; package imports such as `@dtechvision/fabrik-runtime/jj-shell` resolve from the runtime image rather than being copied into the workflow archive
2. **No specs included**: Repo specs come from `--jj-repo`, not from your local specs directory
3. **Immutable image required**: The runtime image must use a digest reference (`@sha256:`)
4. **Repo cloned at runtime**: The workflow clones the repo specified by `--jj-repo` into the Job pod

## Helper Utilities

### `@dtechvision/fabrik-runtime/jj-shell`

Deterministic shell operations using Bun's `$` shell:

- `prepareWorkspaces()`: Creates JJ workspaces for parallel ticket processing
- `snapshotChange()`: Describes current change and opens a new one
- `pushBookmark()`: Moves bookmark to current change and pushes to origin

These operations are performed directly by the workflow (not delegated to LLM agents) for reproducibility.

### `@dtechvision/fabrik-runtime/codex-auth`

Codex workflows should use `createCodexAgentWithPool()` from `@dtechvision/fabrik-runtime/codex-auth` to rotate across cluster-mounted `auth.json` / `*.auth.json` credentials.

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

Focused runtime-package workflow verification:

```bash
cd src/fabrik-cli
FABRIK_K3D_E2E=1 FABRIK_K3D_CLUSTER=dev-single \
  go test ./internal/run -run TestK3dWorkflowRuntimePackageImports -timeout 10m -v
```

That test proves a workflow can import `@dtechvision/fabrik-runtime/...` from the rebuilt Smithers image inside k3d.

Focused local bundle verification for the checked-in complex samples:

```bash
cd src/fabrik-cli
go test ./internal/run -run 'TestComplexSampleBundleContents|TestCodexRotationSampleBundleContents' -v
```
