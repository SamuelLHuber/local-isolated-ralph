# Workflow Samples

This directory holds dispatchable Smithers workflows that are self-contained under a single bundle root.

## `todo-driver.tsx`

This workflow is for repositories that keep a verification-first execution plan in a root `todo.md`.

Dispatch contract:

```bash
fabrik run \
  --project fabrik \
  --env dev \
  --env-file .env \
  --workflow-path workflows/todo-driver.tsx \
  --jj-repo https://github.com/<owner>/<repo>.git \
  --jj-bookmark feat/<branch> \
  --accept-filtered-sync \
  --interactive=false
```

What it does:

- stages workflow code under `/workspace/.fabrik/workflows`
- clones the target repo into `/workspace/workdir`
- reads `todo.md` from the cloned repo root
- selects the next highest-priority unfinished todo item
- blocks if the todo item is missing `Spec tie-in`, `Guarantees`, `Verification to build first`, or `Required checks`
- creates JJ workspaces deterministically
- snapshots progress with JJ after implementation and review-fix phases
- validates through same-cluster child verification Jobs instead of trusting agent summaries alone
- runs a review gate for spec alignment, maintainability, and verification evidence before reporting `done`

Required runtime inputs:

- `SMITHERS_JJ_REPO` via `--jj-repo`
- `FIREWORKS_API_KEY` in `--env-file` for the PI agent model
- `GITHUB_TOKEN` or `GH_TOKEN` in `--env-file` if the repo is private
- `JJ_USER_NAME` and `JJ_USER_EMAIL` in `--env-file` when the workflow is expected to create or push commits

Workflow runner requirements:

- the Fabrik-dispatched workflow Job must be able to authenticate to its cluster with the in-cluster ServiceAccount token
- the workflow pod needs enough RBAC in `fabrik-runs` to create, watch, and delete child Jobs and read Pod logs
- same-cluster verifier Jobs use the same immutable image digest and the same workspace PVC as the parent workflow run

Local k3d testing note:

- for local `dev-single` / `dev-multi`, use cluster-local registry digests instead of plain local tags
- Fabrik enforces immutable image references, and Kubernetes will only pull the image if the digest points at a registry the cluster can reach

Optional runtime inputs:

- `SMITHERS_JJ_BOOKMARK` via `--jj-bookmark`
- `MAX_TODO_ITEMS` in the env file if one dispatch should attempt more than one todo item

The workflow assumes `todo.md` uses this section shape for each executable item:

- `### Task`
- `### Spec tie-in`
- `### Guarantees`
- `### Verification to build first`
- `### Required checks`
- `### Documentation updates`

If the next unfinished item does not meet that contract, the workflow reports a blocked result instead of guessing.
