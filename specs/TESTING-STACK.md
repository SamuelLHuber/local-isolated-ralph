# Testing Stack (Effect-First, Minimal Dependencies)

## Principles
- Use Effect dependency injection for all external services (GitHub API, LLMs, SMTP, S3, Ralph runners).
- Use `@effect/vitest` as the primary test API (`it.effect`, `it.scoped`, `it.live`).
- Prefer TestContext services like `TestClock` for time-based tests.
- Avoid adding new dependencies unless necessary; justify each addition.

## Required Tooling
- **Unit / integration**: `vitest` (>= 4.0) + `@effect/vitest`
- **Assertions**: `expect` from `@effect/vitest`
- **HTTP tests**: built-in `fetch` against a test server (no extra HTTP test libs by default).
- **UI tests**: Playwright only if strictly needed (visual + E2E). Otherwise keep minimal.

## Patterns to Use
- Use `it.effect` for most tests (auto TestContext).
- Use `it.scoped` for tests that require a Scope.
- Use `TestClock` to simulate timeouts/retries deterministically.
- Use `Effect.exit` to validate failure paths.
- Avoid flaky tests; if unavoidable, wrap with `it.flakyTest`.

## Dependency Rules
- Mock via Effect services, not test-specific libraries.
- No new mocking frameworks unless justified.
