# TODO: 030-ui-dashboard (TDD Required)

## TDD Rules
- Write tests before implementation for each item (red → green → refactor).
- Use `@effect/vitest` for API tests; keep UI tests minimal.
- Do not mark a task complete unless tests pass.
- Manual review is required between specs.
- Use Effect dependency injection for all external services.
- Minimal dependencies only (see `specs/TESTING-STACK.md`).

## Definition of Done
- All new tests pass (`bun test`).
- Typecheck passes (`bun run typecheck`).
- No new lint issues (if linting is enabled).

- [ ] Write API tests for `/api/v1/runs` and `/api/v1/runs/:id` with cursor pagination. Then implement endpoints. Verify by passing tests.
- [ ] Write API tests for repo CRUD and schedule/recipient updates. Then implement endpoints. Verify by passing tests.
- [ ] Write UI tests for Dashboard page (tiles + latest feed) only if critical. Then implement UI. Verify by passing tests.
- [ ] Write UI tests for Runs list with filters and 30s polling only if critical. Then implement UI. Verify by passing tests.
- [ ] Write UI tests for Run Detail (rendered summary, JSON, artifacts, observability links) only if critical. Then implement UI. Verify by passing tests.
- [ ] Write UI tests for Repositories page (list, add/remove, schedule update, recipients update) only if critical. Then implement UI. Verify by passing tests.
- [ ] Write UI tests for Schedules page (list + next run times) only if critical. Then implement UI. Verify by passing tests.
- [ ] Use manual visual QA for layout (desktop + mobile) unless visual regression is required later.
