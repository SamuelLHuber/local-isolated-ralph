# Correctness & Invariant Validation Reviewer

Review for code correctness through layered guarantees. Applies to ALL critical invariants, not just billing (which is one example of T1 code).

## Step 1: Classify Criticality Tier

| Tier | Examples | Layers Required |
|------|----------|-----------------|
| **T1 (Critical)** | Money, access control, signing, auth tokens, irreversible state changes | **ALL 6** (L1-L5 + Simulation) |
| **T2 (Important)** | User data, business logic, state machines, queues | **L1-L5** (Simulation optional) |
| **T3 (Standard)** | Features, UI state, caching | **L1-L4** |
| **T4 (Low)** | Analytics, logging, metrics | **L1, L4** |

**REQUIREMENT**: For T1/T2 code, ALL applicable guarantee layers MUST be present.

## Step 2: Verify the 6 Guarantee Layers

### L1 - TYPES (Compile-time enforcement)
- [ ] Branded types for domain values (no primitive obsession: `string`/`number`)
- [ ] Phantom types for state machines (invalid transitions unrepresentable)
- [ ] Error channel explicit (all failure modes in Effect type)
- [ ] Exhaustive matching (`Match.exhaustive` for all unions)

### L2 - RUNTIME (Fail-fast assertions)
- [ ] Preconditions: `Effect.assert` before operations (guard clauses)
- [ ] Postconditions: `Effect.assert` after operations (invariants hold)
- [ ] Smart constructors: Schema validation returning `Effect<T, ValidationError>`
- [ ] Boundary validation: All external input validated at entry points

### L3 - PERSISTENCE (Last line of defense)
- [ ] DB constraints: UNIQUE for idempotency, CHECK for valid ranges
- [ ] Partial indexes: State-dependent constraints (e.g., only one ACTIVE per user)
- [ ] Foreign keys: Referential integrity enforced
- [ ] Triggers: Auto-maintained invariants where app logic might fail

### L4 - TESTS (Behavioral verification)
- [ ] `@property` TSDoc comments: Every invariant has a name and description
- [ ] Unit tests: Happy path and specific edge cases covered
- [ ] Property-based tests: Randomized inputs verify invariants (conservation, idempotency)
- [ ] Constraint tests: DB schema actually has the constraints

### L5 - MONITORING (Production defense)
- [ ] Alerts: Impossible states trigger alerts (e.g., "double X detected")
- [ ] Metrics: Key invariants tracked (e.g., operation count per period)
- [ ] Anomaly detection: Unusual patterns flagged automatically

### L6 - SIMULATION (T1 only)
- [ ] Seed-based: Deterministic, reproducible 24/7 simulation plan
- [ ] Invariant checking: Simulation validates all guarantees
- [ ] Failure injection: Network, DB, external API failures tested

## Step 3: Verify Domain-Specific Invariants

### Example: Billing (T1)
- [ ] Idempotency: Deterministic keys + temporal uniqueness + DB UNIQUE constraint
- [ ] State exclusion: CANCELED items never processed (type + runtime + DB filter)
- [ ] Exactly-once: Period advancement with postcondition asserts
- [ ] Conservation: Money neither created nor destroyed (property test)

### Example: Auth/Access Control (T1)
- [ ] RBAC: Phantom types for permission levels
- [ ] Token expiry: Temporal assertions + DB cleanup
- [ ] Audit logging: Immutable append-only records

### Example: State Machines (T2)
- [ ] Phantom types preventing invalid transitions
- [ ] `Match.exhaustive` for all state + event combinations
- [ ] DB check constraints on status fields

### Example: Distributed Operations (T1/T2)
- [ ] Determinism: Same inputs always produce same outputs
- [ ] Commutativity: Order of independent ops doesn't matter
- [ ] Idempotency: Duplicate requests are safely ignored
- [ ] Observability: All operations traceable end-to-end

## Verification Checklists

### For T1 Code:
- [ ] All 6 layers present (Types, Runtime, Persistence, Tests, Monitoring, Simulation)
- [ ] Invariants documented with `@property` TSDoc
- [ ] No primitive obsession (branded types everywhere)
- [ ] DB constraints exist and are tested
- [ ] Effect.assert for pre/postconditions
- [ ] Seed-based simulation plan documented

### For T2 Code:
- [ ] Layers 1-5 present (Simulation optional)
- [ ] State machine phantom types
- [ ] Property tests for core invariants
- [ ] Monitoring TODOs in place

### For T3/T4 Code:
- [ ] Layers 1-4 (L5/L6 optional)
- [ ] Basic property tests for complex logic

## Severity

- `CRITICAL`: Missing guarantee layer for T1/T2 code
- `HIGH`: Missing L5 monitoring for T1
- `WARNING`: Incomplete property test coverage

Mark `changes_requested` if ANY required layer is missing for the criticality tier.

## Confidence Calculation

```
T1 Confidence = L1 × L2 × L3 × L4 × L5 × L6
             ≈ 0.65 × 0.95 × 0.99 × 0.95 × 0.98 × 0.99
             ≈ 99.5%

Each missing layer multiplies risk. No single layer is sufficient.
```
