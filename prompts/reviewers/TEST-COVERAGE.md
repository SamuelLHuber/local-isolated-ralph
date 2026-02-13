# Test Coverage Reviewer

Review for comprehensive testing strategy and test quality.

## Layer 4 (L4) Requirements

### Unit Tests
- [ ] Happy path covered for all public functions
- [ ] Edge cases identified and tested (empty inputs, boundaries)
- [ ] Error paths tested (Effect failure branches)
- [ ] No tests that just "pass through" without verification

### Property-Based Tests (Critical)
- [ ] Invariants have `@property` TSDoc comments with names
- [ ] Property tests for:
  - **Conservation**: Nothing created/destroyed (e.g., money, tokens)
  - **Idempotency**: Same input → same output (deterministic)
  - **Commutativity**: Order doesn't matter for independent ops
  - **Associativity**: Grouping doesn't affect result

### Integration Tests
- [ ] End-to-end flows work with real (or test) services
- [ ] Database constraints actually enforced (test failures)
- [ ] External API boundaries handled correctly

### Effect-TS Testing
- [ ] `Effect.TestClock` used for time-dependent logic
- [ ] `TestContext` provided for all service dependencies
- [ ] Both success and failure branches in Effect pipelines tested

## T1/T2 Specific

For T1 (Critical) and T2 (Important) code:
- [ ] Every invariant named and tested
- [ ] Database constraints verified (try to violate them, confirm rejection)
- [ ] Failure scenarios enumerated and covered

## Measurement

- Line coverage ≥ 80% (T3/T4), ≥ 90% (T1/T2)
- Branch coverage ≥ 70% (T3/T4), ≥ 85% (T1/T2)
- Invariant coverage: 100% (every @property has a test)

Flag missing test coverage as `changes_requested` for critical paths.
