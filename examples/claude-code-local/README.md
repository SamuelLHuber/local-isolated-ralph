# Claude Code Sample (Local)

```bash
bunx smithers run examples/claude-code-local/workflow.tsx \
  --run-id claude-code-sample
```

Output: `public/todo-app.html`

Claude Code implements a TODO app, a second Claude Code instance reviews it, and the loop repeats on issues (up to 3 iterations).

## Cluster dispatch

Set up shared credentials, then dispatch:

```bash
kubectl create secret generic fabrik-credentials -n fabrik-system \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-...

fabrik run \
  --run-id claude-code-sample \
  --spec specs/051-k3s-orchestrator.md \
  --project claude-sample \
  --workflow-path examples/claude-code-local/workflow.tsx \
  --input-json '{}' \
  --context k3d-dev-single \
  --accept-filtered-sync \
  --interactive=false
```

Credentials are mounted at `/etc/fabrik/credentials/` in the pod. See [`src/fabrik-runtime`](../../src/fabrik-runtime/) for runtime credential helpers.
