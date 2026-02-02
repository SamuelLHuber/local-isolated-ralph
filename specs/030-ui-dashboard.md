# PRD: UI Dashboard (Read‑Only v1, Config‑Ready)

## Overview
A clean internal admin dashboard built with Effect + TanStack Start that surfaces job runs, outputs, and repo configuration. v1 is read‑only for run results but supports repo/schedule/recipient management via API endpoints. The UI pulls all data from the service API and links to observability tools.

## Goals
- Provide a single place to view weekly summaries and release verification results.
- Display run history with status, duration, and trigger source.
- Allow repo, schedule, and recipient management (add/remove repos, update schedules, update recipients).
- Link to Grafana Tempo traces and Sentry errors for each run.

## Non‑Goals
- Public access or external sharing.
- In‑UI editing of prompts, channels, or credentials (later).
- Real‑time streaming updates (polling is sufficient).

## Users
- Internal engineering and product teams.

## Functional Requirements
### Pages
1) **Dashboard**
   - Summary tiles: last run, success rate, failures last 24h, pending jobs.
   - Latest outputs feed (weekly summaries, release verifications).

2) **Runs**
   - Table view: run id, job type, repo, status, duration, trigger, timestamp.
   - Filters: repo, job type, status, date range.

3) **Run Detail**
   - Header: job type, repo, version/week, status, duration, trigger.
   - Tabs:
     - Rendered summary (human‑readable).
     - Raw JSON output.
     - Artifacts (PDF links).
     - Observability links (Tempo trace, Sentry event).

4) **Repositories**
   - List of configured repos.
   - Add/remove repo.
   - Update schedules (cron string).
   - Update email recipients (per repo).
   - View prompt configuration (read‑only in v1).

5) **Schedules**
   - List view of cron schedules and next run time.

## API Requirements
Expose versioned API endpoints for UI:
- `GET /api/v1/runs`
- `GET /api/v1/runs/:id`
- `GET /api/v1/repos`
- `POST /api/v1/repos`
- `DELETE /api/v1/repos/:id`
- `PATCH /api/v1/repos/:id/schedule`
- `PATCH /api/v1/repos/:id/recipients`

All other settings (prompts, channels) are read‑only.

## Data Model (v1)
- `Run`:
  - id, jobId, repo, status, duration, trigger, startedAt, finishedAt
  - outputJson (full report)
  - artifacts[] (PDF URLs)
  - observability: { traceUrl, sentryUrl }

- `RepoConfig`:
  - id, repoFullName, schedule, prompt (read‑only), watchPaths
  - recipients (email list)

## API Schema (v1, suggested)
### Run
```json
{
  "id": "string",
  "jobId": "weekly-repo-summary | release-verification",
  "repo": "owner/name",
  "status": "queued | running | success | error | canceled",
  "trigger": "cron | webhook",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601 | null",
  "durationMs": 0,
  "outputJson": { "any": "json" },
  "artifacts": [{ "type": "pdf", "url": "https://...", "sha256": "..." }],
  "observability": { "traceUrl": "https://...", "sentryUrl": "https://..." }
}
```

### RepoConfig
```json
{
  "id": "string",
  "repoFullName": "owner/name",
  "schedule": "cron",
  "prompt": "string",
  "watchPaths": ["docs/", "spec/", "prd/", "TODO.md"],
  "recipients": ["ops@example.com"]
}
```

### Pagination
`GET /api/v1/runs` should accept `cursor` and `limit` and return:
```json
{
  "items": [/* Run */],
  "nextCursor": "string | null"
}
```

## Observability Links
- Tempo trace URLs and Sentry event URLs should be included if available.
- UI should surface these links prominently in Run Detail.

## UX/Design
- Clean admin dashboard style.
- Responsive layout (desktop first, mobile usable).
- Clear status indicators (success/warn/error).

## Acceptance Criteria
- UI renders runs list and run detail from API.
- Repo list + schedule management are functional via API.
- Observability links open in Grafana/Sentry.
- Design matches clean admin dashboard expectations.

## Explicit Assumptions
- UI is internal and unauthenticated in v1.
- UI is read‑only except repo add/remove, schedule updates, and recipient updates.
- Data is fetched from `/api/v1/...` endpoints.
- Polling interval defaults to 30s if no push mechanism is used.

## Open Questions
- None for v1.
