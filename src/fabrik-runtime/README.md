# fabrik-runtime

Shared TypeScript utilities for Fabrik workflow pods.

- **Credential pool** — read from mounted `/etc/fabrik/credentials`, rotate on failure, notify operators
- **K8s jobs** — dispatch child verification jobs from a running workflow
- **JJ shell** — deterministic JJ/Git snapshot, bookmark push, workspace prep

## Credentials

Operators manage `fabrik-credentials` in `fabrik-system` via kubectl. The CLI mirrors it into the run namespace at dispatch time. The secret is directory-mounted (no subPath) at `/etc/fabrik/credentials/` so running pods observe file replacements.

```ts
import { injectCredentialEnv } from "fabrik-runtime/credential-pool";

// Reads /etc/fabrik/credentials/ANTHROPIC_API_KEY → process.env.ANTHROPIC_API_KEY
injectCredentialEnv("ANTHROPIC_API_KEY");
```

For file-pool rotation (e.g. multiple Codex auth files):

```ts
import { CredentialFilePool } from "fabrik-runtime/credential-pool";

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

## Precedence

1. Fabrik runtime metadata (`SMITHERS_*`, `FABRIK_*`, `KUBERNETES_*`)
2. Project env (`fabrik-env-<project>-<env>`) via `envFrom`
3. Shared credentials (`fabrik-credentials`) via file mount
