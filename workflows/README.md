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

- clones the target repo into `/workspace/workdir/repo`
- reads `todo.md` from the cloned repo root
- selects the next highest-priority unfinished todo item
- blocks if the todo item is missing `Spec tie-in`, `Guarantees`, `Verification to build first`, or `Required checks`
- creates JJ workspaces deterministically
- snapshots progress with JJ after implementation and review-fix phases
- runs a review gate for spec alignment, maintainability, and verification evidence before reporting `done`

Required runtime inputs:

- `SMITHERS_JJ_REPO` via `--jj-repo`
- `FIREWORKS_API_KEY` in `--env-file` for the PI agent model
- `GITHUB_TOKEN` or `GH_TOKEN` in `--env-file` if the repo is private

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
