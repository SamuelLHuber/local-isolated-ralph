# NASA Engineering Principles Reviewer

Review against NASA-style engineering discipline and the "Power of Ten" rules for safety-critical code.

## Guarantee Hierarchy (L1-L5)

CRITICAL: Check that ALL applicable layers are implemented:

### L1 - TYPES (Compile-time enforcement)
- [ ] Branded types for domain values (e.g., `UserId` not `string`)
- [ ] Phantom types for state machines (invalid transitions unrepresentable)
- [ ] Error channels explicit in Effect types (all failures known)
- [ ] Exhaustive matching (`Match.exhaustive` for all unions)

### L2 - RUNTIME (Fail-fast assertions)
- [ ] Preconditions: `Effect.assert` before operations
- [ ] Postconditions: `Effect.assert` after operations (invariants hold)
- [ ] Smart constructors: Schema validation returning `Effect<T, ValidationError>`
- [ ] Boundary validation: All external input validated at entry points

### L3 - PERSISTENCE (Database constraints)
- [ ] UNIQUE constraints for idempotency
- [ ] Partial indexes for state-dependent constraints
- [ ] CHECK constraints for valid ranges
- [ ] Foreign keys for referential integrity
- [ ] Triggers for auto-maintained invariants

### L4 - TESTS (Behavioral verification)
- [ ] `@property` TSDoc comments naming every invariant
- [ ] Property-based tests (randomized inputs)
- [ ] Constraint verification (DB actually enforces constraints)

### L5 - MONITORING (Production defense)
- [ ] TODOs for production alerts (e.g., "detect double X")
- [ ] Metrics tracking for invariants
- [ ] Anomaly detection planning

## NASA "Power of Ten" Rules

1. **Simple control flow**
   - [ ] No recursion (use explicit loops with bounds)
   - [ ] Bounded loops only (fixed upper limits)
   - [ ] No dynamic dispatch where static suffices

2. **Fixed upper bounds**
   - [ ] All allocations bounded (no unbounded growth)
   - [ ] Array/collection sizes have limits
   - [ ] No while(true) without guaranteed exit

3. **No dynamic memory after init**
   - [ ] Pre-allocated pools where possible
   - [ ] Effect's Scope for resource management
   - [ ] No runtime allocation in hot paths (T1 only)

4. **Short functions**
   - [ ] Max 60 lines per function
   - [ ] Single responsibility enforced
   - [ ] Early returns preferred over deep nesting

5. **Minimum two assertions**
   - [ ] Preconditions checked (guard clauses)
   - [ ] Postconditions verified (invariants hold)
   - [ ] Loop invariants where applicable

6. **Data scope minimization**
   - [ ] Variables declared at smallest scope
   - [ ] No module-level mutable state
   - [ ] Function parameters preferred over shared state

7. **Check return values**
   - [ ] All Effect errors handled (no unhandled channels)
   - [ ] No floating Promises (all awaited/caught)
   - [ ] Service errors explicitly matched

8. **Limited preprocessor**
   - [ ] No magic (no hidden control flow from decorators)
   - [ ] No compile-time code generation obscuring logic
   - [ ] Explicit is better than implicit

9. **Pointer discipline** (TypeScript: reference safety)
   - [ ] No `null` without `Option/Maybe` types
   - [ ] No undefined without explicit handling
   - [ ] References validated before dereference

10. **Compile with warnings** (strict TypeScript)
    - [ ] `strict: true` enforced
    - [ ] No `any` types
    - [ ] Exhaustive switch cases
    - [ ] Unused variables flagged

## Fabrik-Specific Rules (from AGENTS.md)

- [ ] **State Management**: No `db.state.set()` during render
- [ ] **VM Self-Heal**: Heartbeat logic present for long-running tasks
- [ ] **VCS Enforcement**: Every task pushes to branch (`jj git push --branch`)
- [ ] **Host/VM Decoupling**: Code can run standalone (no host dependency)

## Effect-TS Safety Patterns

- [ ] Error channels explicit (not thrown exceptions)
- [ ] Smart constructors for branded types
- [ ] Phantom types preventing invalid state transitions
- [ ] `Match.exhaustive` for all unions

## Severity

- `CRITICAL`: Missing guarantee layer for T1/T2 code, Power of Ten violation
- `WARNING`: L5 monitoring not planned, minor assertion missing

Flag any violation with severity. Missing layers for critical code = `changes_requested`.
