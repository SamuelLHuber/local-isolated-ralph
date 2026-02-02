# PRD: Base Cron + Webhook Execution Service

## Overview
Build a minimal, reliable execution service that can run tasks on a cron schedule and on-demand via webhook. The service keeps no domain state beyond a run store, exposes structured JSON responses for task execution, and emits full observability signals (OTEL traces to Grafana Tempo, logs to Loki, Sentry error tracking). This is the foundation for future features like weekly repo summaries and release verification.

## Goals
- Run scheduled tasks via cron with retries and clear logging.
- Trigger tasks via webhook with optional auth.
- Return JSON responses for task execution that can later be formatted into notifications and persisted.
- Provide full observability using Effect primitives like the built-in OTEL integration, Sentry integration, and Effect logging.

## Non-Goals
- No external notifications (email, Slack, etc.) yet.
- No task-specific business logic (weekly summaries, release verification).
- No durable multi-tenant data layer beyond the run store (SQLite).

## Users / Stakeholders
- Engineering: needs a reliable task runner and webhook trigger.
- Product: needs task outputs in JSON form for future workflows.

## Functional Requirements
### API
- `GET /_health`
  - Returns `{ "status": "ok" }`.
- `POST /webhook`
  - Auth: optional `Authorization: Bearer <WEBHOOK_SECRET>` if configured.
  - Request body:
    ```json
    {
      "jobId": "string",
      "payload": { "any": "json" }
    }
    ```
  - Response (202 Accepted, async processing):
    ```json
    { "status": "accepted", "jobId": "string" }
    ```
  - Error cases: 400 missing/invalid JSON; 401 unauthorized; 404 not found; 405 method not allowed.

### Task Execution
- Tasks are identified by `jobId` and executed via a centralized Task Runner.
- Task Runner returns a JSON-compatible result:
  ```json
  {
    "status": "ok" | "error",
    "message": "string?",
    "data": { "any": "json" }
  }
  ```
- Unknown `jobId` returns error in Task Runner; webhook returns 500.
- Webhook should enqueue/trigger async execution and return immediately (no blocking on task completion).
- Task results are stored in SQLite for persistence (default).
- Run retention: 180 days.
- Webhook events should be idempotent using GitHub's delivery id header when present (dedupe window 48 hours).

### Cron Scheduler
- Cron jobs are configured in code using Effect Cron.
- Each cron job maps to a `jobId` and optional payload.
- Retry policy: exponential backoff, max 3 retries.

## Observability
- Logs: structured JSON with timestamp, level, message, and job metadata (Loki).
- Tracing: OpenTelemetry integration for HTTP requests and task execution.
- Export traces to Grafana Tempo via OTLP (HTTP preferred).
- Error tracking: Sentry integration for unhandled errors and task failures (DSN via env).
- All observability should be integrated via Effect-friendly adapters where possible.

## Configuration
Environment variables:
- `PORT` (default: 3000)
- `LOG_LEVEL` (default: info)
- `WEBHOOK_SECRET` (default: empty)
- `CRON_TIMEZONE` (default: UTC)
- `OTLP_ENDPOINT` (default: `http://localhost:4318/v1/traces` for LAOS)
- `SENTRY_DSN` (required for Sentry integration)
- `RUN_STORE`: `memory` | `sqlite` (default: sqlite)
- `RUN_STORE_SQLITE_PATH` (used when `RUN_STORE=sqlite`)
- `RUN_RETENTION_DAYS` (default: 180)

Cron jobs are defined in `src/config.ts` with schedule and payload.

## Security
- Webhook auth via bearer token (optional).
- No inbound public endpoints beyond `/webhook` and `/_health`.
- Future: add IP allowlist and request signature verification if needed.

## Acceptance Criteria
- Server starts and serves `/webhook` and `/_health`.
- Cron jobs execute and log results on schedule.
- Webhook triggers tasks asynchronously and returns JSON response immediately.
- Structured logs emitted for every task execution.
- OTEL traces exported to Tempo.
- Errors captured in Sentry.

## Explicit Assumptions
- Webhook tasks are processed asynchronously; failures are reported via logs/traces and Sentry.
- Task output persistence uses SQLite by default.
- Reasonable timeouts are enforced per task and sub-step (exact values TBD).
- GitHub/API rate limits are handled with retries/backoff.
- Idempotency/deduping uses GitHub's delivery id header when present (dedupe window 48 hours).

## Open Questions
- Which Sentry project/DSN should be used in each environment.
- Should task failures return 202 with error details or 500 (current plan: 500).

## Milestones
- M1: Cron + webhook execution with retries.
- M2: Observability wiring (OTEL + Tempo + Sentry).
- M3: Ready for weekly summary feature spec.
