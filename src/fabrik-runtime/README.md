# @dtechvision/fabrik-runtime

Shared TypeScript utilities for Fabrik workflow pods.

- **Credential pool** — read from mounted `/etc/fabrik/credentials`, rotate on failure, notify operators
- **Codex auth rotation** — rotate among `auth.json` / `*.auth.json` credentials for Codex-backed workflows
- **K8s jobs** — dispatch child verification jobs from a running workflow
- **JJ shell** — deterministic JJ/Git snapshot, bookmark push, workspace prep

## Import Surface

Workflows should import from `@dtechvision/fabrik-runtime/...`.

- `@dtechvision/fabrik-runtime/credential-pool`
- `@dtechvision/fabrik-runtime/codex-auth`
- `@dtechvision/fabrik-runtime/jj-shell`
- `@dtechvision/fabrik-runtime/k8s-jobs`

For in-cluster Fabrik runs, the Smithers runtime image ships this package in its `node_modules`.
For local workflow development in another repo, add the package as a dependency from a release or local path.

## Installation

Install from npm:

```bash
bun add @dtechvision/fabrik-runtime
```

or:

```bash
npm install @dtechvision/fabrik-runtime
```

Smithers workflows also need their normal workflow dependencies in the consuming repo:

```bash
bun add smithers-orchestrator zod
```

or:

```bash
npm install smithers-orchestrator zod
```

Package releases follow the same `v*` tag version as the Fabrik CLI release flow.

## Smithers Integration

Use the package from ordinary Smithers workflows:

```ts
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";
import { withCodexAuthPoolEnv } from "@dtechvision/fabrik-runtime/codex-auth";
import { prepareWorkspaces } from "@dtechvision/fabrik-runtime/jj-shell";

const { smithers, outputs } = createSmithers(
  {
    report: z.object({
      codexHomeSet: z.boolean(),
      jjHelpersLoaded: z.boolean(),
    }),
  },
  { dbPath: process.env.SMITHERS_DB_PATH ?? ".smithers/runtime-check.db" },
);

export default smithers(() => (
  <Workflow name="runtime-package-check">
    <Task id="verify" output={outputs.report}>
      {async () => {
        const env = withCodexAuthPoolEnv({});
        return {
          codexHomeSet: typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0,
          jjHelpersLoaded: typeof prepareWorkspaces === "function",
        };
      }}
    </Task>
  </Workflow>
));
```

Run it locally with Smithers from a repo that has installed:

- `@dtechvision/fabrik-runtime`
- `smithers-orchestrator`
- `zod`

Then:

```bash
bunx smithers run path/to/workflow.tsx --run-id runtime-package-check
```

The workflow file should live in the consuming project tree so normal Node/Bun package resolution can find the installed dependencies.

## Credentials

Operators manage `fabrik-credentials` in `fabrik-system` via kubectl. The CLI mirrors it into the run namespace at dispatch time. The secret is directory-mounted (no subPath) at `/etc/fabrik/credentials/` so running pods observe file replacements.

```ts
import { injectCredentialEnv } from "@dtechvision/fabrik-runtime/credential-pool";

// Reads /etc/fabrik/credentials/ANTHROPIC_API_KEY → process.env.ANTHROPIC_API_KEY
injectCredentialEnv("ANTHROPIC_API_KEY");
```

For file-pool rotation (e.g. multiple Codex auth files):

```ts
import { CredentialFilePool } from "@dtechvision/fabrik-runtime/credential-pool";

const pool = new CredentialFilePool({
  prefix: "codex-auth",
  extension: ".json",
  activeDir: "/tmp/codex-active",
  activeFilename: "auth.json",
  agent: "codex",
});
pool.init();

// On auth failure:
const rotated = await pool.handleError(err);
```

For Codex-specific rotation, use the higher-level helper:

```ts
import { createCodexAgentWithPool } from "@dtechvision/fabrik-runtime/codex-auth";

const codex = createCodexAgentWithPool({
  model: "gpt-5",
  cwd: process.cwd(),
  env: {},
});
```

## Local Verification

Runtime package tests:

```bash
cd src/fabrik-runtime
bun test ./src
```

Repo-wide CLI and workflow verification:

```bash
make verify-cli
make verify-cli-k3d
```

Focused runtime-package k3d import verification:

```bash
cd src/fabrik-cli
FABRIK_K3D_E2E=1 FABRIK_K3D_CLUSTER=dev-single \
  go test ./internal/run -run TestK3dWorkflowRuntimePackageImports -timeout 10m -v
```

The complex sample in [examples/complex/README.md](/Users/samuel/git/local-isolated-ralph/examples/complex/README.md) shows how workflow code consumes the package surface in practice.

Local Smithers CLI verification:

```bash
bunx smithers run path/to/workflow.tsx --run-id runtime-package-check
```

The expected result is a successful run whose output reports:

- `codexHomeSet: true`
- `jjHelpersLoaded: true`

## Precedence

1. Fabrik runtime metadata (`SMITHERS_*`, `FABRIK_*`, `KUBERNETES_*`)
2. Project env (`fabrik-env-<project>-<env>`) via `envFrom`
3. Shared credentials (`fabrik-credentials`) via file mount
