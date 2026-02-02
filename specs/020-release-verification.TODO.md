# TODO: 020-release-verification (TDD Required)

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

- [ ] Write webhook payload validation tests. Then implement release webhook handler. Verify by passing tests.
- [ ] Write JSON schema validation tests for release report. Then implement serializer. Verify by passing tests.
- [ ] Write prompt assembly snapshot tests for Trail of Bits Skills context. Then implement prompt builder. Verify by passing tests.
- [ ] Write security analysis tests using mock LanguageModel. Then implement @effect/ai integration. Verify by passing tests.
- [ ] Write compatibility scoring tests using mock LanguageModel. Then implement scoring. Verify by passing tests.
- [ ] Write reproducible build flow tests with mocked Ralph runner. Then implement flow. Verify by passing tests.
- [ ] Write freigabe fallback test (Manuelle Prüfung on build failure). Then implement logic. Verify by passing tests.
- [ ] Write PDF generation tests (A4) and S3 upload tests (checksum). Then implement PDF + storage. Verify by passing tests.
- [ ] Write HTML email render + SMTP send tests (local SMTP sink). Then implement mailer. Verify by passing tests.
- [ ] Write run-store persistence tests for output + artifacts. Then implement persistence. Verify by passing tests.
