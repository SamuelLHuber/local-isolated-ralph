# Guarantee Hierarchy: Layered Safety for Critical Systems

> **Principle:** No single layer provides sufficient safety. Layer guarantees for exponential confidence.

---

## The Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   Layer 5: MONITORING         (Production Defense)                      │
│   ├─ Alerts on invariant violations                                     │
│   ├─ Anomaly detection                                                  │
│   └─ Confidence: Catches what escaped all other layers                  │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Layer 4: TESTS              (Behavioral Verification)                 │
│   ├─ Unit tests: specific cases                                         │
│   ├─ Property tests: randomized inputs                                  │
│   ├─ Integration tests: real system behavior                            │
│   └─ Confidence: ~95% with layers 1-3                                   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Layer 3: PERSISTENCE        (Database Constraints)                    │
│   ├─ UNIQUE constraints                                                 │
│   ├─ CHECK constraints                                                  │
│   ├─ Foreign keys                                                       │
│   ├─ Triggers for complex invariants                                    │
│   └─ Confidence: ~90% with layers 1-2                                   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Layer 2: RUNTIME            (Effect Assertions & Schema)              │
│   ├─ Effect.assert for preconditions/postconditions                     │
│   ├─ Schema validation at boundaries                                    │
│   ├─ Smart constructors returning Effect<T, ValidationError>            │
│   └─ Confidence: ~80% with layer 1                                      │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Layer 1: TYPES              (Compile-Time Guarantees)                 │
│   ├─ Branded/nominal types                                              │
│   ├─ Phantom types for state machines                                   │
│   ├─ Error channel typing                                               │
│   ├─ Exhaustive pattern matching                                        │
│   └─ Confidence: ~65% (TypeScript limitations)                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Types (Compile-Time)

**Goal:** Make invalid states unrepresentable.

### Pattern 1.1: Branded Types

Use for values that have domain meaning beyond their primitive type.

```typescript
import { Schema } from "effect"

// ❌ BAD: Primitive obsession
const charge = (amount: number, subscriptionId: string) => ...

// ✅ GOOD: Branded types enforce valid construction
const PositiveAmount = Schema.Number.pipe(
  Schema.positive(),
  Schema.brand("PositiveAmount")
)
type PositiveAmount = Schema.Schema.Type<typeof PositiveAmount>

const SubscriptionId = Schema.String.pipe(
  Schema.pattern(/^sub_[a-zA-Z0-9]{24}$/),
  Schema.brand("SubscriptionId")
)
type SubscriptionId = Schema.Schema.Type<typeof SubscriptionId>

const charge = (amount: PositiveAmount, subscriptionId: SubscriptionId) => ...
```

**When to use:**
- IDs (UserId, SubscriptionId, OrderId)
- Monetary values (PositiveAmount, NonNegativeBalance)
- Validated strings (Email, PhoneNumber, IdempotencyKey)
- Constrained numbers (Percentage, PortNumber)

### Pattern 1.2: Phantom Types for State Machines

Use when operations are only valid in certain states.

```typescript
// State encoded in the type parameter
interface Subscription<Status extends "ACTIVE" | "PAST_DUE" | "CANCELED"> {
  readonly _status: Status
  readonly id: SubscriptionId
  readonly userId: UserId
  readonly currentPeriodEnd: Date
}

// Type aliases for clarity
type ActiveSubscription = Subscription<"ACTIVE">
type CanceledSubscription = Subscription<"CANCELED">

// Operations constrained by state
const charge = (sub: Subscription<"ACTIVE" | "PAST_DUE">) =>
  Effect<ChargeResult, ChargeError, BasePayService>

const cancel = (sub: ActiveSubscription) =>
  Effect<CanceledSubscription, never, DbService>

// ❌ COMPILE ERROR: Can't charge canceled subscription
const badCharge = (sub: CanceledSubscription) => charge(sub) // Type error!
```

**When to use:**
- Subscription states (Active, Canceled, Suspended)
- Order states (Pending, Paid, Shipped, Delivered)
- Document states (Draft, Published, Archived)
- Connection states (Disconnected, Connecting, Connected)

### Pattern 1.3: Error Channel Typing

Explicit about what can fail.

```typescript
// ❌ BAD: Unknown failure modes
const processPayment = (amount: number): Promise<Result> => ...

// ✅ GOOD: Every failure mode is typed
class InsufficientFundsError extends Data.TaggedError("InsufficientFundsError")<{
  readonly available: PositiveAmount
  readonly required: PositiveAmount
}> {}

class IdempotencyError extends Data.TaggedError("IdempotencyError")<{
  readonly existingEventId: string
  readonly attemptedKey: IdempotencyKey
}> {}

class SubscriptionNotActiveError extends Data.TaggedError("SubscriptionNotActiveError")<{
  readonly subscriptionId: SubscriptionId
  readonly currentStatus: string
}> {}

const processPayment = (
  sub: ActiveSubscription,
  amount: PositiveAmount
): Effect<
  PaymentResult,
  InsufficientFundsError | IdempotencyError | SubscriptionNotActiveError,
  BasePayService | DbService
> => ...
```

### Pattern 1.4: Exhaustive Matching

No missed cases.

```typescript
import { Match } from "effect"

const handleSubscriptionStatus = Match.type<Subscription<any>>().pipe(
  Match.when({ _status: "ACTIVE" }, (s) => processActive(s)),
  Match.when({ _status: "PAST_DUE" }, (s) => processPastDue(s)),
  Match.when({ _status: "CANCELED" }, (s) => processCanceled(s)),
  Match.when({ _status: "EXPIRED" }, (s) => processExpired(s)),
  Match.exhaustive // ❌ Compile error if case missing!
)
```

---

## Layer 2: Runtime (Assertions & Validation)

**Goal:** Catch violations at runtime before they cause damage.

### Pattern 2.1: Preconditions with Effect.assert

```typescript
const chargeSubscription = (sub: ActiveSubscription) =>
  Effect.gen(function* () {
    const now = new Date()

    // PRECONDITION: Period must have ended (can't charge early)
    yield* Effect.assert(
      sub.currentPeriodEnd <= now,
      () => new PrematureChargeError({
        subscriptionId: sub.id,
        periodEnd: sub.currentPeriodEnd,
        attemptedAt: now,
      })
    )

    // ... charge logic ...
  })
```

### Pattern 2.2: Postconditions

```typescript
const advancePeriod = (sub: ActiveSubscription, days: number) =>
  Effect.gen(function* () {
    const oldPeriodEnd = sub.currentPeriodEnd
    const newPeriodEnd = new Date(oldPeriodEnd.getTime() + days * 86400000)

    // ... update logic ...

    // POSTCONDITION: Period must have advanced
    yield* Effect.assert(
      newPeriodEnd > oldPeriodEnd,
      () => new InvariantViolationError({
        invariant: "PERIOD_MUST_ADVANCE",
        old: oldPeriodEnd,
        new: newPeriodEnd,
      })
    )

    return { ...sub, currentPeriodEnd: newPeriodEnd }
  })
```

### Pattern 2.3: Smart Constructors

Only way to create a type is through validated Effect.

```typescript
const makeIdempotencyKey = (
  subscriptionId: SubscriptionId,
  date: Date
): Effect<IdempotencyKey, ValidationError, never> =>
  Effect.gen(function* () {
    const dateStr = date.toISOString().slice(0, 10)
    const key = `renewal-${subscriptionId}-${dateStr}`

    // Validate the constructed key
    return yield* Schema.decode(IdempotencyKeySchema)(key)
  })

// Usage - must handle ValidationError
const key = yield* makeIdempotencyKey(subId, today)
```

### Pattern 2.4: Boundary Validation

Validate ALL external input at system boundaries.

```typescript
// API route handler
export const POST = (request: Request) =>
  Effect.gen(function* () {
    const body = yield* Effect.tryPromise(() => request.json())

    // BOUNDARY: Validate external input
    const input = yield* Schema.decodeUnknown(CreateSubscriptionSchema)(body)

    // Now `input` is fully typed and validated
    return yield* createSubscription(input)
  }).pipe(
    Effect.catchTag("ParseError", (e) =>
      Effect.succeed(Response.json({ error: "Invalid input" }, { status: 400 }))
    )
  )
```

---

## Layer 3: Persistence (Database Constraints)

**Goal:** Last line of defense. Even if application logic has bugs, database prevents invalid states.

### Pattern 3.1: Unique Constraints for Idempotency

```sql
-- Prevents duplicate payment records even if app logic fails
CREATE UNIQUE INDEX subscription_payment_events_idempotency_idx
ON subscription_payment_events (provider, user_subscription_id, idempotency_key);
```

### Pattern 3.2: Partial Unique Index for State Constraints

```sql
-- Only one ACTIVE subscription per user per provider
CREATE UNIQUE INDEX user_subscriptions_single_active_idx
ON user_subscriptions (user_id, provider)
WHERE status IN ('ACTIVE', 'IN_TRIAL');
```

### Pattern 3.3: Check Constraints

```sql
-- Amount must be positive
ALTER TABLE subscription_payment_events
ADD CONSTRAINT positive_amount CHECK (amount > 0);

-- Status must be valid
ALTER TABLE user_subscriptions
ADD CONSTRAINT valid_status CHECK (
  status IN ('ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'IN_TRIAL')
);
```

### Pattern 3.4: Triggers for Complex Invariants

```sql
-- Auto-populate charge amount from plan (immutable after creation)
CREATE TRIGGER user_subscriptions_apply_plan_defaults
BEFORE INSERT ON user_subscriptions
FOR EACH ROW EXECUTE FUNCTION apply_plan_defaults();
```

---

## Layer 4: Tests (Behavioral Verification)

**Goal:** Verify that the system behaves correctly for specific scenarios.

### Pattern 4.1: Property Tests with TSDoc

```typescript
/**
 * @property IDEMPOTENCY_DETERMINISM
 * Same inputs MUST produce same output (pure function).
 */
it("same subscription + same day = same key", () => {
  fc.assert(
    fc.property(fc.uuid(), fc.date(), (subId, date) => {
      const key1 = generateIdempotencyKey(subId, date)
      const key2 = generateIdempotencyKey(subId, date)
      expect(key1).toBe(key2)
    })
  )
})
```

### Pattern 4.2: Invariant Tests

```typescript
/**
 * @property CANCELED_NEVER_CHARGED
 * A CANCELED subscription must NEVER appear in renewal results.
 */
it("CANCELED subscription excluded from renewal query", async () => {
  // Setup: Create subscription, cancel it
  const sub = await createTestSubscription({ status: "CANCELED" })

  // Execute: Run renewal query
  const renewals = await getSubscriptionsForRenewal()

  // Verify: Canceled subscription not included
  expect(renewals.map(r => r.id)).not.toContain(sub.id)
})
```

### Pattern 4.3: Constraint Verification Tests

```typescript
/**
 * @property DATABASE_CONSTRAINT_EXISTS
 * Verify the unique constraint exists at SQL level.
 */
it("idempotency constraint exists on payment_events", async () => {
  const constraints = await getTableConstraints("subscription_payment_events")
  const idempotencyConstraint = constraints.find(c =>
    c.name.includes("idempotency")
  )

  expect(idempotencyConstraint).toBeDefined()
  expect(idempotencyConstraint.type).toBe("UNIQUE")
})
```

---

## Layer 5: Monitoring (Production Defense)

**Goal:** Catch violations that escaped all other layers.

> **Full guide:** `docs/guides/production-monitoring.md`
>
> Covers: Grafana alerts, Sentry configuration, PostHog funnels, incident playbooks

### Pattern 5.1: Invariant Violation Alerts

```typescript
const chargeSubscription = (sub: ActiveSubscription) =>
  Effect.gen(function* () {
    // ... charge logic ...

    // Count charges for this subscription today
    const chargesCount = yield* countChargesForDay(sub.id, today)

    // MONITORING: Alert if impossible state
    if (chargesCount > 1) {
      // Sentry for debugging context
      Sentry.captureMessage("DOUBLE_CHARGE_DETECTED", {
        level: "fatal",
        tags: { invariant: "NO_DOUBLE_CHARGE", subscriptionId: sub.id },
      })

      // Grafana metric for alerting
      yield* metrics.increment("billing.invariant_violation", {
        type: "double_charge",
      })
    }
  })
```

### Pattern 5.2: Anomaly Detection

```typescript
// Track in metrics (flows to Grafana/Mimir)
const recordChargeAttempt = (sub: ActiveSubscription) =>
  Effect.gen(function* () {
    yield* metrics.increment("subscription.charge.attempt", {
      subscriptionId: sub.id,
      status: sub._status,
    })
  })

// Grafana alert rules (defined in grafana/alerts/)
// - Alert if charge attempts > 2 per subscription per day
// - Alert if canceled subscription has charge attempt
// - Alert if payment events exceed expected count
```

### Pattern 5.3: Tool Routing

| Concern | Tool | Why |
|---------|------|-----|
| "Is it broken?" | Grafana | System metrics, traces, logs |
| "Why is it broken?" | Sentry | Stack traces, releases, profiling |
| "Who was affected?" | PostHog | Funnels, cohorts, user impact |

---

## Applying the Hierarchy: Decision Framework

For each critical invariant, work through this checklist:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ INVARIANT: [Describe the property that must hold]                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ 1. TYPE LAYER                                                           │
│    □ Can this be encoded in types? (branded, phantom, union)            │
│    □ Can invalid states be made unrepresentable?                        │
│    □ Are all error cases typed in the Effect error channel?             │
│                                                                         │
│ 2. RUNTIME LAYER                                                        │
│    □ Are there preconditions to assert?                                 │
│    □ Are there postconditions to verify?                                │
│    □ Is input validated at boundaries?                                  │
│                                                                         │
│ 3. PERSISTENCE LAYER                                                    │
│    □ Can a database constraint enforce this?                            │
│    □ Is there a unique constraint needed?                               │
│    □ Should a trigger maintain the invariant?                           │
│                                                                         │
│ 4. TEST LAYER                                                           │
│    □ Is there a unit test for the happy path?                           │
│    □ Is there a test for the violation case?                            │
│    □ Is there a property test for the invariant?                        │
│    □ Is the database constraint tested?                                 │
│                                                                         │
│ 5. MONITORING LAYER                                                     │
│    □ Would a violation be detectable in production?                     │
│    □ Is there an alert for this failure mode?                           │
│    □ Are metrics tracking this behavior?                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Example: Subscription Billing Guarantees

### Guarantee: "Canceled subscriptions are never charged"

| Layer | Implementation |
|-------|---------------|
| **Types** | `charge(sub: Subscription<"ACTIVE" \| "PAST_DUE">)` - Canceled not in union |
| **Runtime** | `Effect.assert(sub.status !== "CANCELED", ...)` |
| **Persistence** | Renewal query: `WHERE status IN ('ACTIVE', 'PAST_DUE')` |
| **Tests** | `it("CANCELED subscription excluded from renewal")` |
| **Monitoring** | Alert if charge attempt on canceled subscription |

### Guarantee: "No double-charging"

| Layer | Implementation |
|-------|---------------|
| **Types** | `IdempotencyKey` branded type - can't use arbitrary string |
| **Runtime** | Smart constructor validates key format |
| **Persistence** | `UNIQUE INDEX (provider, subscription_id, idempotency_key)` |
| **Tests** | `it("duplicate idempotency key rejected by constraint")` |
| **Monitoring** | Alert if payment_events count > 1 per subscription per day |

### Guarantee: "Exactly once per period"

| Layer | Implementation |
|-------|---------------|
| **Types** | `PositiveDays` branded type for period advancement |
| **Runtime** | Postcondition: `newPeriodEnd > oldPeriodEnd` |
| **Persistence** | `current_period_end` only updated on successful charge |
| **Tests** | `it("period advances only on success")` |
| **Monitoring** | Alert if charge count > 1 while period unchanged |

---

## TypeScript Limitations (Honest Assessment)

Effect-TS cannot provide:

| Property | Why Not | Mitigation |
|----------|---------|------------|
| "x + y = z" (arithmetic) | No dependent types | Unit tests |
| "List is sorted" | No refinement proofs | Runtime assertion |
| "True for ALL inputs" | No theorem prover | Property tests |
| "Happens before Y" | No temporal logic | Integration tests |
| "DB constraint exists" | Types don't know SQL | Schema tests |

**Bottom line:** Effect gives ~65% safety through types. Layers 2-5 provide the remaining ~30%. The last ~5% requires human vigilance and good engineering culture.

---

🫡🇩🇪 Prussian virtues: Defense in depth, multiple barriers, assume each can fail.
