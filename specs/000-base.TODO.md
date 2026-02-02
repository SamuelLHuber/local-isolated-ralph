# TODO: 000-base (TDD Required)

## TDD Rules
- Write tests before implementation for each item (red → green → refactor).
- Use `@effect/vitest` (`it.effect`, `it.scoped`, `it.live`) and TestContext services like `TestClock`.
- Do not mark a task complete unless tests pass.
- Manual review is required between specs.
- Use Effect dependency injection for all external services.
- Minimal dependencies only (see `specs/TESTING-STACK.md`).

## Definition of Done
- All new tests pass (`bun test`).
- Typecheck passes (`bun run typecheck`).
- No new lint issues (if linting is enabled).

- [ ] Write schema tests for SQLite run-store (runs table, status enum, output JSON, timestamps). Then implement schema. Verify by passing tests.
- [ ] Write CRUD tests for run-store interface (create, update, list, get). Then implement SQLite backend. Verify by passing tests.
- [ ] Write idempotency tests using `X-GitHub-Delivery` with 48h window. Then implement dedupe logic. Verify by passing tests.
- [ ] Write async webhook tests ensuring 202 returns before task completion. Then implement queue/async execution. Verify by passing tests.
- [ ] Write retention cleanup tests (180 days) using `TestClock`. Then implement scheduled cleanup. Verify by passing tests.
- [ ] Write tracing export test (span emitted) and validate in Tempo in manual review. Then wire OTEL exporter. Verify by passing tests + manual check.
- [ ] Write logging transport test (structured log shape) and validate in Loki in manual review. Then wire Loki transport. Verify by passing tests + manual check.
- [ ] Write Sentry capture test (mocked) and validate in Sentry in manual review. Then wire Sentry integration. Verify by passing tests + manual check.
- [ ] Write config validation tests (missing envs). Then implement validation. Verify by passing tests.
- [ ] Write API error response tests. Then document endpoints and error responses. Verify by passing tests + review of doc.
