# PRD: Weekly Summary — Ralph/CLI Orchestration Extension

## Overview
This document extends `010-weekly-summary.md` with a Ralph/CLI deep‑dive loop for higher‑quality summaries. The system can spawn local Ralph loops (single machine/container) to produce section‑level artifacts that are aggregated into the final weekly summary JSON.

## Goals
- Improve summary quality by allowing deeper, tool‑assisted analysis.
- Keep orchestration stateless while supporting rich context via local clones.
- Make Ralph usage configurable per task (always/on_gap/never).

## Execution Environment
- No Kubernetes required in v1.
- Ralph loops run on a single machine or container by default.
- If configured, Ralph runs are dispatched as Kubernetes Jobs via the cluster API.
- Each run is isolated in its own working directory.

## Ralph Orchestration
### Policy
- `use_ralph`: `always` | `on_gap` | `never`
- Default: `on_gap` (escalate when reviewer loop flags missing sections).
- Max iterations: `RALPH_MAX_ITERATIONS` (default 10, configurable).
- Parallelization: Ralph loops may run in parallel per section.
- Retry limit: 3 restarts on failure, then alert the end user.
- Runtime thresholds: alert at 24h, 32h, 40h; cancel at 48h.

### Inputs
- GitHub API payloads (PRs, commits, file lists, diffs).
- Optional local clone context (full clone) using repo URL and token.
- Prompt file `PROMPT.md` and checklist `TODO.md` generated per run.

### Outputs
Each Ralph loop produces a JSON artifact focused on a specific section:
```json
{
  "section": "documentation_highlights",
  "content": ["..."]
}
```
Artifacts are aggregated into the final weekly summary JSON.

## Context Assembly
- Primary context: GitHub API.
- Optional enhancement: full clone for targeted paths (`docs/`, `spec/`, `prd/`, `TODO.md`).
- If clone is enabled, only required paths are read to reduce overhead.
- No shared clone cache in v1.

## Flow
1) Build base summary with @effect/ai.
2) Run reviewer loop (5 reviewers, 4 approvals).
3) If reviewers flag gaps and `use_ralph != never`:
   - Spawn Ralph loop for missing sections.
   - If Ralph fails, restart the run (up to the configured retry limit).
   - Merge returned artifacts into summary.
   - Re‑run reviewer loop.

## Configuration
- `USE_RALPH`: `always` | `on_gap` | `never`
- `RALPH_MAX_ITERATIONS`: default 10
- `RALPH_AGENT`: `claude` | `codex` | `opencode` (default `claude`)
- `RALPH_REPO_URL`: provided per task/run
- `RALPH_INCLUDE_GIT`: true/false (default false)
- `RALPH_RUNNER`: `local` | `k8s` (default `local`)
- `RALPH_K8S_NAMESPACE`: namespace for Jobs when `RALPH_RUNNER=k8s`

## Acceptance Criteria
- Ralph loop can be triggered per task based on policy.
- Artifacts are merged into final summary JSON.
- Reviewer loop approves or stops after max iterations.

## Explicit Assumptions
- Ralph runs only when configured (default `on_gap`).
- Full clone is allowed only for Ralph runs.
- Each Ralph run is time‑boxed and capped at 10 iterations by default.
- No shared clone cache in v1; each run is isolated.
- Section artifacts are merged deterministically into final output.

## Open Questions
- Should Ralph always run for high‑risk repos?
- Should Ralph loops be parallelized per section by default?
