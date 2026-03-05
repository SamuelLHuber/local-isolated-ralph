# Counter App (Local)

```bash
bunx smithers run examples/counter-local/workflow.tsx \
  --run-id counter-app-agent \
  --input '{"appName":"react-counter-app"}'
```

Output: `<appName>/` in the current working directory.

Optional jj config:
- `SMITHERS_JJ_REPO`: if set, the workflow will `jj git clone` into `<appName>/` before making changes.
- `SMITHERS_JJ_BOOKMARK`: if set, the workflow will `jj commit` and `jj git push --bookmark` after each implementation step.
