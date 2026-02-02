# TODO: 011-weekly-summary-ralph (TDD Required)

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

- [ ] Write tests for Ralph runner interface (local/k8s adapters). Then implement interface. Verify by passing tests.
- [ ] Write local Ralph runner dry-run tests (dummy agent command). Then implement local runner. Verify by passing tests.
- [ ] Write k8s Job runner tests (mocked client). Then implement k8s runner. Verify by passing tests.
- [ ] Write PROMPT.md/TODO.md generation snapshot tests. Then implement file generation. Verify by passing tests.
- [ ] Write artifact parsing + deterministic merge tests. Then implement merger. Verify by passing tests.
- [ ] Write retry/alert/cancel tests using `TestClock`. Then implement orchestration policy. Verify by passing tests.
- [ ] Write run-store artifact persistence tests. Then implement persistence. Verify by passing tests.
