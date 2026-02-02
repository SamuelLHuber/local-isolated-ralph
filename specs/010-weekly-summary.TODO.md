# TODO: 010-weekly-summary (TDD Required)

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

- [ ] Write GitHub API client tests (PRs, reviews/comments, commits, files). Then implement client. Verify by passing tests.
- [ ] Write weekly window tests (Mon–Sun Europe/Berlin) using `TestClock`. Then implement date filtering. Verify by passing tests.
- [ ] Write docs/spec/TODO path extraction tests. Then implement path rules. Verify by passing tests.
- [ ] Write prompt merge snapshot tests. Then implement base + per-repo prompt merger. Verify by passing tests.
- [ ] Write summary generation tests using a mock LanguageModel. Then implement @effect/ai integration. Verify by passing tests.
- [ ] Write reviewer loop tests (5 reviewers, 4 approvals, max 3 iterations, quality rubric). Then implement loop. Verify by passing tests.
- [ ] Write JSON schema validation tests for output format. Then implement output serializer. Verify by passing tests.
- [ ] Write run-store persistence tests. Then implement persistence. Verify by passing tests.
- [ ] Write repo config API tests (schedule/prompt/watch paths). Then implement endpoints. Verify by passing tests.
