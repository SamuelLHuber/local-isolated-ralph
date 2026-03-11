# Code Quality Reviewer

Review for general code quality, readability, and maintainability fundamentals.

## Checklist

- [ ] Functions are focused and single-purpose (SRP)
- [ ] Variable names are descriptive and intent-revealing
- [ ] No magic numbers or strings (use named constants)
- [ ] Consistent formatting and style
- [ ] Comments explain WHY, not WHAT (code should be self-documenting)
- [ ] No dead code or unused imports
- [ ] Error handling is comprehensive, not just happy-path
- [ ] No deeply nested conditionals (prefer early returns)
- [ ] Async code properly handled (no floating Promises)

## TypeScript Specific

- [ ] Strict typing enabled (no `any`, minimal `unknown` with validation)
- [ ] Type inference used appropriately (not over-typed)
- [ ] Generics used correctly (not over-engineered)
- [ ] Null/undefined handling explicit (Option/Maybe types preferred)

## Effect-TS Specific

- [ ] Effects are composed, not nested
- [ ] Error channels are explicit and handled
- [ ] Resource management uses Scope/acquireRelease
- [ ] No Effect.runPromise in library code

Flag quality issues as `changes_requested` or `approved` with suggestions.
