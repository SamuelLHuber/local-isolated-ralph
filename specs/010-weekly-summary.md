# PRD: Weekly Repository Summary

## Overview
Produce a weekly AI-generated summary for configured GitHub repositories. The summary focuses on merged PRs, commit activity, and meaningful changes across code and documentation. Output is JSON for downstream formatting and delivery. Summaries are generated via @effect/ai with an internal multi-reviewer consensus loop.

## Goals
- Generate a weekly summary per repo from GitHub API data only (no local clones).
- Highlight new features, learning insights, improvements, and docs/spec changes.
- Support per-repo prompts to steer the AI while keeping a common output template.
- Use an AI reviewer loop until 4/5 reviewers agree the summary is complete.

## Non-Goals
- No domain-specific persistence beyond the run store.
- No notifications or UI delivery in this phase.
- No real-time PR monitoring (weekly only).

## Schedule
- Default cadence: Sundays at 18:00 Europe/Berlin (Frankfurt time).
- Configurable per repo via API/UI (v1: API only).

## Data Sources
GitHub API only (no local clones), for the current calendar week (Mon–Sun):
- Merged PRs (title, description, comments/reviews, labels, files changed).
- Commits (message, author, files changed, diff metadata).
- File changes to detect docs/spec highlights:
  - docs/ or documentation-related paths
  - spec/ or prd/ directories
  - TODO.md (explicit file)

## Output Format (JSON)
```json
{
  "repo": "owner/name",
  "period": { "from": "ISO-8601", "to": "ISO-8601" },
  "highlights": {
    "new_features": ["..."],
    "learning_highlights": ["..."],
    "documentation_highlights": ["..."],
    "improvements": ["..."],
    "spec_summaries": ["..."],
    "notes": ["optional"],
    "risks_or_questions": ["optional"]
  },
  "sources": {
    "merged_prs": [
      {
        "number": 123,
        "title": "...",
        "url": "...",
        "merged_at": "ISO-8601",
        "authors": ["..."],
        "summary": "..."
      }
    ],
    "commits": [
      {
        "sha": "...",
        "message": "...",
        "url": "...",
        "date": "ISO-8601"
      }
    ],
    "docs_changes": ["path"],
    "spec_changes": ["path"],
    "todo_changes": ["path"]
  },
  "review": {
    "reviewers": 5,
    "approved": 4,
    "notes": ["..."],
    "iterations": 1
  }
}
```

## AI Workflow
- Use @effect/ai to produce the initial summary from GitHub API data.
- Use a multi-reviewer loop:
  - 5 reviewer agents evaluate completeness and correctness.
  - Repeat summary generation if fewer than 4 reviewers approve.
  - Cap iterations to prevent infinite loops (default: 3).
- Prompts are configurable per repo, merged with a global base prompt and output schema.
- Provider: OpenAI integration via @effect/ai-openai.
- Output language: English (future: optional translation step).

## Configuration
Per repo config (managed via API/UI in v1):
- `repo`: owner/name
- `schedule`: cron string (default: Sunday 18:00 Europe/Berlin)
- `prompt`: custom prompt extension
- `watch_paths`: optional list of paths or globs (defaults include docs/, spec/, prd/, TODO.md)
- `recipients`: email recipients for future notifications

Global config:
- `SUMMARY_TIMEZONE`: default Europe/Berlin
- `SUMMARY_LOOKBACK_DAYS`: default 7
- `REVIEWERS`: default 5
- `REVIEW_APPROVALS_REQUIRED`: default 4
- `REVIEW_MAX_ITERATIONS`: default 3
- `GITHUB_TOKEN`: required for GitHub API access

## Security / Compliance
- Use GitHub API tokens with least privileges (read-only for public repos).
- No PII is processed beyond GitHub usernames.
- Outputs are JSON; no external distribution in this phase.

## Acceptance Criteria
- For each configured repo, a weekly summary job runs at the configured time.
- Output JSON includes all required sections and source metadata.
- Reviewer loop completes with 4/5 approvals or hits max iterations.
- Observability: logs and traces for GitHub fetch, AI generation, reviewer loop.

## Explicit Assumptions
- Weekly window is calendar week (Mon–Sun) in Europe/Berlin time.
- PR review comments are included in the analysis.
- Prompts live in config (per‑repo overrides allowed).
- Docs/spec highlight detection relies on path rules (docs/, spec/, prd/, TODO.md).
- Truncation rules for very large PRs/commit diffs will be added if needed.
- Reviewer minimum quality: no empty sections, at least one item in new_features or improvements when changes exist, and sources referenced.
- The job runs Sunday 18:00 local time and summarizes the current week from Monday 00:00 through the run time.

## Open Questions
- None for v1.
