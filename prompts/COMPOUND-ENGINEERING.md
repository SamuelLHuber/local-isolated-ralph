# Compound Engineering: Todo Generation Guide

> Plan thoroughly. Review rigorously. Codify knowledge. Compound quality.

This guide helps you convert a completed Spec Interview into a structured
Todo JSON file that enables compound engineering.

---

## The Process

```
Spec Interview → Todo Generation → Task Decomposition → 8-Layer Review → Human Gate
     (80%)            (15%)             (5%)
```

**Heavy planning, light execution.** The todo encodes all decisions
so implementation is straightforward.

---

## Step 1: Determine Criticality Tier

Based on the spec's domain and risk, classify as:

| Tier | Examples | Guarantee Layers Required |
|------|----------|--------------------------|
| **T1 (Critical)** | Money, auth, signing, irreversible state | **ALL 6** (L1-L5 + Simulation) |
| **T2 (Important)** | User data, business logic, state machines | **L1-L5** (Simulation optional) |
| **T3 (Standard)** | Features, UI state, caching | **L1-L4** |
| **T4 (Low)** | Analytics, logging, metrics | **L1, L4** |

**Compound Engineering Rule**: When in doubt, tier up.
Better to have extra guarantees than miss critical ones.

---

## Step 2: Define Definition of Done (DoD)

Each tier has required DoD items. These become checklist items in the todo.

### T1 (Critical) - Required DoD

```json
{
  "dod": [
    "L1: Branded types implemented (no primitive string/number usage)",
    "L2: Effect.assert for all preconditions and postconditions",
    "L3: DB migration with UNIQUE/CHECK constraints created",
    "L4: @property TSDoc on every invariant test (named invariants)",
    "L4: Property-based tests (conservation, idempotency, commutativity)",
    "L4: 90%+ line coverage, 85%+ branch coverage",
    "L5: TODO comments for production alerts with severity levels",
    "L5: Metrics emission points documented and implemented",
    "L6: Seed-based simulation plan documented (T1 only)",
    "Review: All 8 reviewers approved (including NASA-10-RULES)",
    "VCS: Code pushed to GitHub branch, CI passes",
    "Human: Gate cleared with manual approval"
  ]
}
```

### T2 (Important) - Required DoD

```json
{
  "dod": [
    "L1: Branded types for domain values",
    "L2: Assertions for key invariants",
    "L3: DB constraints for uniqueness/referential integrity",
    "L4: Unit tests + property tests for core invariants",
    "L4: 85%+ line coverage, 70%+ branch coverage",
    "L5: Monitoring TODOs with alert conditions",
    "Review: All applicable reviewers passed",
    "VCS: Pushed to branch, CI passes"
  ]
}
```

### T3-T4 (Standard/Low) - Required DoD

```json
{
  "dod": [
    "L1: Basic typing (strict mode, no any)",
    "L2: Input validation at boundaries",
    "L4: Unit tests for happy path and error cases",
    "L4: 80%+ line coverage",
    "VCS: Pushed, CI passes"
  ]
}
```

---

## Step 3: Determine TDD Mode

```json
{
  "tdd": true  // or false
}
```

**TDD = true** when:
- Logic-heavy code (calculations, transformations)
- State machines with transitions
- Algorithmic work (sorting, searching, parsing)
- Financial calculations
- Authorization logic

**TDD = false** when:
- Glue/config code (wiring services together)
- UI layout/styling
- Simple CRUD without business logic
- Infrastructure setup

**Compound Engineering**: Even with TDD=false, you MUST have tests.
Just that they don't need to be written first.

---

## Step 4: Decompose Into Tasks

### Task Sizing Rules

- **Max 4 hours** of focused work per task
- **Independent** where possible (can parallelize)
- **Verifiable** with clear "verify" criteria
- **Atomic** (all-or-nothing completion)

### Task Ordering

Order by **dependency**, not necessarily execution:
1. Foundation (types, schemas, constraints)
2. Core logic (domain rules, invariants)
3. Integration (APIs, external services)
4. Observability (metrics, alerts, logging)

### Task Templates by Type

#### Type: Domain Model (Foundation)

```json
{
  "id": "1",
  "do": "Define branded types: {DomainId}, {AmountType}, {StatusType}",
  "verify": "Types compile; Schema validates; No primitive string/number in domain code"
}
```

Creates L1 guarantees. Makes invalid states unrepresentable.

---

#### Type: State Machine (Foundation)

```json
{
  "id": "2",
  "do": "Implement phantom types for {Entity}<Status> state machine",
  "verify": "Invalid transitions cause compile-time errors; Match.exhaustive covers all states"
}
```

Encodes valid transitions in type system. Compile-time guarantees.

---

#### Type: Database Schema (Persistence)

```json
{
  "id": "3",
  "do": "Create migration with constraints: UNIQUE({field}), CHECK({condition})",
  "verify": "Tests confirm constraint rejection at DB level; Schema matches spec requirements"
}
```

L3 guarantees. DB is last line of defense even if app has bugs.

---

#### Type: Core Logic (with Invariants)

```json
{
  "id": "4",
  "do": "Implement {operation} with Effect.assert pre/postconditions",
  "verify": "@property tests: {INVARIANT_1}, {INVARIANT_2}, {INVARIANT_3}; All assertions pass"
}
```

Example for billing:
```json
{
  "id": "4",
  "do": "Implement chargeSubscription with Effect.assert pre/postconditions",
  "verify": "@property tests: CANCELED_NEVER_CHARGED, NO_DOUBLE_CHARGE, PERIOD_ADVANCES_ONCE"
}
```

L2 guarantees. Runtime assertions catch violations immediately.

---

#### Type: API Layer (Integration)

```json
{
  "id": "5",
  "do": "Add {method} {endpoint} endpoint with input validation",
  "verify": "Integration tests pass; Input validation rejects malformed requests; Error responses typed"
}
```

Boundary validation. All external input checked at entry.

---

#### Type: Idempotency (Critical Operations)

```json
{
  "id": "6",
  "do": "Implement idempotency key generation and storage",
  "verify": "Duplicate requests with same key return same result; No double side effects; DB UNIQUE constraint prevents duplicates"
}
```

Essential for T1/T2. Enables safe retries.

---

#### Type: Observability (L5)

```json
{
  "id": "7",
  "do": "Add production TODOs for alerts: {condition} → {severity}",
  "verify": "TODOs include: alert condition, severity, runbook link; Metrics emission points implemented"
}
```

Example:
```json
{
  "id": "7",
  "do": "Add production TODOs for billing alerts",
  "verify": "TODOs: double_charge_detected→P1, renewal_failure_rate>5%→P2, latency_p99>500ms→P2"
}
```

Captures monitoring requirements. Makes operationalizing explicit.

---

#### Type: Simulation (L6, T1 only)

```json
{
  "id": "8",
  "do": "Document seed-based simulation plan for {invariants}",
  "verify": "Plan includes: seed generation, operations_per_seed, invariant_checks, failure_injection_scenarios"
}
```

24/7 deterministic testing. Catches edge cases unit tests miss.

---

## Step 5: Map Tasks to Guarantee Layers

Ensure ALL required layers have corresponding tasks:

| Layer | Task Type | Verification |
|-------|-----------|------------|
| L1 Types | Domain Model, State Machine | Compile-time errors for invalid states |
| L2 Runtime | Core Logic | Effect.assert passes, @property tests |
| L3 Persistence | DB Schema | Constraint tests pass |
| L4 Tests | Core Logic, API | Coverage thresholds met |
| L5 Monitoring | Observability | TODOs present, metrics implemented |
| L6 Simulation | Simulation | Plan documented (T1 only) |

**Compound Engineering**: Each layer is a teaching opportunity.
Document the patterns in `docs/guides/` for reuse.

---

## Complete Todo Example (T1 Billing)

```json
{
  "v": 1,
  "id": "billing-renewal",
  "tdd": true,
  "dod": [
    "L1: Branded types: SubscriptionId, PositiveAmount",
    "L2: Effect.assert for all pre/postconditions",
    "L3: DB UNIQUE on (provider, subscription_id, idempotency_key)",
    "L4: @property: CANCELED_NEVER_CHARGED, NO_DOUBLE_CHARGE, PERIOD_ADVANCES_ONCE",
    "L4: 90%+ line, 85%+ branch coverage",
    "L5: TODOs for double_charge→P1, renewal_fail→P2",
    "L6: Seed-based simulation plan documented",
    "Review: All 8 reviewers approved",
    "VCS: Pushed to branch, CI passes",
    "Human: Gate cleared"
  ],
  "tasks": [
    {
      "id": "1",
      "do": "Define branded types: SubscriptionId, PositiveAmount, IdempotencyKey",
      "verify": "Types compile; Schema validates; No primitive usage"
    },
    {
      "id": "2",
      "do": "Implement phantom types Subscription<'ACTIVE'|'PAST_DUE'|'CANCELED'>",
      "verify": "Invalid state transitions cause compile errors"
    },
    {
      "id": "3",
      "do": "Create DB migration with UNIQUE constraint for idempotency",
      "verify": "Tests confirm duplicate key rejection at DB level"
    },
    {
      "id": "4",
      "do": "Implement renewal query filtering CANCELED subscriptions",
      "verify": "@property CANCELED_NEVER_CHARGED: CANCELED subs excluded from results"
    },
    {
      "id": "5",
      "do": "Implement chargeSubscription with idempotency check",
      "verify": "@property NO_DOUBLE_CHARGE: Same idempotency key returns cached result"
    },
    {
      "id": "6",
      "do": "Implement period advancement with postcondition asserts",
      "verify": "@property PERIOD_ADVANCES_ONCE: newPeriodEnd > oldPeriodEnd verified"
    },
    {
      "id": "7",
      "do": "Add conservation property test for money",
      "verify": "@property MONEY_CONSERVED: Total in = Total out for all test cases"
    },
    {
      "id": "8",
      "do": "Add API endpoint POST /subscriptions/:id/charge",
      "verify": "Integration tests pass; Input validation rejects bad requests"
    },
    {
      "id": "9",
      "do": "Add production TODOs for billing alerts",
      "verify": "TODOs documented for double_charge→P1, renewal_fail→P2, latency→P2"
    },
    {
      "id": "10",
      "do": "Document seed-based simulation plan",
      "verify": "Plan: 1000 seeds/hour, 10000 ops/seed, invariant validation, failure injection"
    }
  ]
}
```

---

## Quality Checklist

Before finalizing todo:

- [ ] **Tier Correct**: T1/T2/T3/T4 appropriate for risk
- [ ] **DoD Complete**: All required items for tier present
- [ ] **TDD Appropriate**: True for logic, false for glue
- [ ] **Tasks Sized**: Max 4 hours each
- [ ] **Verifiable**: Every task has clear "verify" criteria
- [ ] **Layer Coverage**: All L1-L6 (or subset) have tasks
- [ ] **Invariant Named**: @property comments on all critical tests
- [ ] **Ordered**: Dependencies first, parallel where possible

---

## Compound Engineering Impact

**This Todo is a teaching document:**

- New team member reads it → understands codebase architecture
- Future spec references it → reuses patterns
- Reviewer checks against it → consistent quality
- Operations uses it → knows what to monitor

**Each todo makes the next easier:**
- Task templates get refined
- Common patterns emerge
- Reviews get faster (known checklists)
- Implementation gets safer (proven guarantees)

---

## Next Steps

After todo generation:

1. **Review Todo**: Does it encode all spec decisions?
2. **Run Workflow**: `fabrik run --spec specs/{id}.json --todo specs/{id}.todo.json`
3. **Capture Learnings**: Update this guide with new patterns
4. **Document**: Add @property patterns to `docs/guides/`

**Compound engineering is a flywheel.**
Each cycle makes the next faster, safer, and easier.
