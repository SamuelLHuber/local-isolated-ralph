# Tigerstyle Audit Reviewer

Review against Tigerstyle principles: code should be consistent, explicit, dense, and defensive.

## Core Principles

### 1. CONSISTENCY
- [ ] Code follows established patterns (no exceptions without justification)
- [ ] Naming conventions consistent across codebase
- [ ] Structure mirrors similar modules elsewhere
- [ ] "One way to do it" - no arbitrary variation

### 2. EXPLICITNESS
- [ ] All side effects visible (no hidden mutations)
- [ ] Imports/dependencies explicit (no implicit globals)
- [ ] Control flow obvious (no magic, no surprises)
- [ ] Configuration explicit (not scattered across files)

### 3. DENSITY
- [ ] One idea per line
- [ ] No unnecessary ceremony or boilerplate
- [ ] Concise but not cryptic (clarity > brevity, but both matter)
- [ ] Remove comments that just restate code

### 4. LOCALITY
- [ ] Related concepts close together (same file/section)
- [ ] No jumping across files to understand a flow
- [ ] Cohesive modules (high cohesion, low coupling)
- [ ] Temporal locality: setup/use/teardown close together

## Defensive Structure

### 5. FAIL FAST
- [ ] Guard clauses at function entry (validate early)
- [ ] Assertions for invariants (Effect.assert, not comments)
- [ ] No silent failures (all errors explicit)
- [ ] Invalid states prevented, not handled

### 6. IMMUTABILITY
- [ ] Prefer `const` over `let`
- [ ] Mutations explicit and localized
- [ ] Data transformations return new values
- [ ] No shared mutable state (use Effect's concurrency primitives)

### 7. TYPE SAFETY
- [ ] Branded types for domain values (no primitive obsession)
- [ ] Phantom types for state machines (invalid states unrepresentable)
- [ ] No `any` (use `unknown` with validation if needed)
- [ ] Exhaustive matching for all unions

## Composability

### 8. FUNCTION COMPOSITION
- [ ] Functions return Effects for chaining
- [ ] Single responsibility (do one thing, do it well)
- [ ] Pure functions where possible (testable, predictable)
- [ ] Dependencies injected, not hardcoded

### 9. RESOURCE SAFETY
- [ ] Resources acquired and released properly
- [ ] Scope management for lifecycles
- [ ] No resource leaks (connections, file handles)
- [ ] Cleanup in error paths (Effect.acquireRelease)

### 10. OBSERVABILITY
- [ ] Errors typed (not thrown exceptions)
- [ ] Tracing/debugging possible without breakpoints
- [ ] Context preserved in error chains

## Severity Levels

- `CRITICAL`: Type safety violation, hidden mutation, resource leak
- `WARNING`: Consistency issue, density problem
- `SUGGESTION`: Style preference

Flag ANY Tigerstyle violation as `changes_requested` with specific line references.
