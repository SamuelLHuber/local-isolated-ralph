# @dtechvision/fabrik-runtime

TypeScript helpers for Fabrik/Smithers workflows.

## Scope

Use this package for server-side workflow code.

Do not use it for:
- browser apps
- generic Node libraries

Published entrypoints:
- `@dtechvision/fabrik-runtime`
- `@dtechvision/fabrik-runtime/credential-pool`
- `@dtechvision/fabrik-runtime/codex-auth`
- `@dtechvision/fabrik-runtime/jj-shell`
- `@dtechvision/fabrik-runtime/k8s-jobs`

## Requirements

- ESM-capable runtime
- TypeScript source consumption
- Bun/Smithers-style workflow execution is the primary target

Module-specific requirements:

| Module | Requirement |
|---|---|
| `credential-pool` | mounted credential files for file-pool features |
| `codex-auth` | Codex auth files in the credential pool layout |
| `jj-shell` | `jj` and `git` in `PATH` |
| `k8s-jobs` | Kubernetes runtime access |

## Install

```bash
bun add @dtechvision/fabrik-runtime smithers-orchestrator zod
```

or

```bash
npm install @dtechvision/fabrik-runtime smithers-orchestrator zod
```

## Quickstart

```ts
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";
import { withCodexAuthPoolEnv } from "@dtechvision/fabrik-runtime/codex-auth";

const { smithers, outputs } = createSmithers(
  { report: z.object({ codexHomeSet: z.boolean() }) },
  { dbPath: process.env.SMITHERS_DB_PATH ?? ".smithers/runtime-check.db" },
);

export default smithers(() => (
  <Workflow name="runtime-package-check">
    <Task id="verify" output={outputs.report}>
      {async () => {
        const env = withCodexAuthPoolEnv({});
        return { codexHomeSet: typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0 };
      }}
    </Task>
  </Workflow>
));
```

Run:

```bash
bunx smithers run path/to/workflow.tsx --run-id runtime-package-check
```

## Common use

Read a credential into `process.env`:

```ts
import { injectCredentialEnv } from "@dtechvision/fabrik-runtime/credential-pool";

injectCredentialEnv("ANTHROPIC_API_KEY");
```

Rotate across credential files:

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
const rotated = await pool.handleError(err);
```

Create a Codex agent with auth rotation:

```ts
import { createCodexAgentWithPool } from "@dtechvision/fabrik-runtime/codex-auth";

const codex = createCodexAgentWithPool({
  model: "gpt-5",
  cwd: process.cwd(),
  env: {},
});
```

## Notes

- Fabrik runtime images may already ship this package.
- Package versions follow the same `v*` tag line as Fabrik releases.
- Prefer aligned Fabrik image and package versions when both are in use.
