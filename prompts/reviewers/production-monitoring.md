# Production Monitoring: Invariant Verification in Production

> **Layer 5 of the Guarantee Hierarchy: Catch what escaped all other layers.**

This guide defines how to monitor critical invariants in production using our observability stack:
- **Grafana** (Loki/Mimir/Tempo) → System health, metrics, traces
- **Sentry** → Errors, regressions, profiling
- **PostHog** → User impact, behavior, funnels

See `specs/Infrastructure-Setup.md` for full architecture.

---

## Monitoring Philosophy

### The Role of Production Monitoring

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   Layers 1-4 PREVENT bad states:                                        │
│   Types → Assertions → DB Constraints → Tests                           │
│                                                                         │
│   Layer 5 DETECTS when prevention failed:                               │
│   Monitoring → Alerts → Human intervention                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**If Layer 5 fires, something is already wrong.** The goal is:
1. **Detect fast** - Minimize time-to-detection
2. **Alert the right person** - Route to owner
3. **Provide context** - What, where, how bad
4. **Enable action** - Clear playbook to follow

### Alert Categories

| Category | Tool | Example | Response Time |
|----------|------|---------|---------------|
| **System Health** | Grafana | 5xx rate > 1%, latency p99 > 2s | < 5 min |
| **Invariant Violation** | Sentry + Grafana | Double charge detected | < 1 min |
| **Error Spike** | Sentry | New exception in billing code | < 15 min |
| **User Impact** | PostHog | Subscription funnel drop > 20% | < 1 hour |

---

## Critical Invariant Alerts

### For Subscription Billing (from `docs/guides/guarantee-hierarchy.md`)

These alerts detect violations of the three billing guarantees.

#### Alert: Double Charge Detection (Guarantee #2)

**Invariant:** No subscription should have > 1 successful charge per day.

**Implementation:**

```typescript
// In renewal cron, after recording payment event
const chargesCount = await countChargesForSubscriptionToday(subscriptionId)

if (chargesCount > 1) {
  // CRITICAL: This should be impossible if layers 1-4 work
  Sentry.captureMessage("DOUBLE_CHARGE_DETECTED", {
    level: "fatal",
    tags: {
      invariant: "NO_DOUBLE_CHARGE",
      subscriptionId,
      chargesCount,
    },
    extra: {
      chargeEvents: await getChargeEventsForToday(subscriptionId),
    },
  })

  // Also emit metric for Grafana alerting
  metrics.increment("billing.invariant_violation", {
    type: "double_charge",
    subscriptionId,
  })
}
```

**Grafana Alert Rule:**

```yaml
# grafana/alerts/billing-invariants.yaml
groups:
  - name: billing_invariants
    rules:
      - alert: DoubleChargeDetected
        expr: increase(billing_invariant_violation_total{type="double_charge"}[5m]) > 0
        for: 0m  # Alert immediately
        labels:
          severity: critical
          team: billing
        annotations:
          summary: "CRITICAL: Double charge detected"
          description: "Subscription {{ $labels.subscriptionId }} was charged multiple times"
          runbook_url: "https://docs.internal/runbooks/double-charge"
```

**Sentry Alert:**
- Create alert for issues with tag `invariant:NO_DOUBLE_CHARGE`
- Severity: Critical
- Notify: #billing-alerts + on-call

---

#### Alert: Canceled Subscription Charge Attempt (Guarantee #1)

**Invariant:** Canceled subscriptions should never reach the charge function.

**Implementation:**

```typescript
// At the start of chargeSubscription(), as defense-in-depth
const chargeSubscription = (sub: ChargeableSubscription) =>
  Effect.gen(function* () {
    // This should be impossible due to type system, but verify anyway
    if ((sub as any)._status === "CANCELED") {
      Sentry.captureMessage("CANCELED_SUBSCRIPTION_CHARGE_ATTEMPT", {
        level: "fatal",
        tags: {
          invariant: "CANCELED_NEVER_CHARGED",
          subscriptionId: sub.id,
          status: (sub as any)._status,
        },
      })

      metrics.increment("billing.invariant_violation", {
        type: "canceled_charge_attempt",
      })

      return yield* Effect.fail(new SubscriptionNotChargeableError({
        subscriptionId: sub.id,
        currentStatus: "CANCELED",
      }))
    }

    // ... rest of charge logic
  })
```

---

#### Alert: Period Not Advancing (Guarantee #3)

**Invariant:** After successful charge, period_end must be in the future.

**Implementation:**

```typescript
// After updating subscription post-charge
const updated = await updateSubscriptionPeriod(sub.id, newPeriodEnd)

// Verify the invariant
if (new Date(updated.currentPeriodEnd) <= new Date()) {
  Sentry.captureMessage("PERIOD_NOT_ADVANCED", {
    level: "error",
    tags: {
      invariant: "PERIOD_MUST_ADVANCE",
      subscriptionId: sub.id,
    },
    extra: {
      expectedPeriodEnd: newPeriodEnd,
      actualPeriodEnd: updated.currentPeriodEnd,
    },
  })
}
```

---

#### Alert: Idempotency Key Collision (Guarantee #2)

**Invariant:** Idempotency key collisions should be caught by DB constraint.

**Implementation:**

```typescript
// When recording payment event
const recordPaymentEvent = (event: PaymentEvent) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => supabase.from("subscription_payment_events").insert(event),
      catch: (error) => {
        // Check if it's an idempotency violation
        if (error.message?.includes("unique") || error.code === "23505") {
          // This is EXPECTED for retries - log but don't alert
          console.log(`Idempotent retry detected: ${event.idempotencyKey}`)

          metrics.increment("billing.idempotent_retry", {
            subscriptionId: event.userSubscriptionId,
          })

          return new IdempotencyViolationError({ existingKey: event.idempotencyKey })
        }

        // Unexpected error - alert
        Sentry.captureException(error, {
          tags: { operation: "record_payment_event" },
        })

        return new DbError({ cause: error })
      },
    })

    return result
  })
```

**Grafana Alert for Excessive Retries:**

```yaml
- alert: ExcessiveIdempotentRetries
  expr: rate(billing_idempotent_retry_total[5m]) > 10
  for: 5m
  labels:
    severity: warning
    team: billing
  annotations:
    summary: "High rate of idempotent payment retries"
    description: "May indicate cron job running too frequently or retry storm"
```

---

## System Health Alerts

### Renewal Cron Health

```yaml
# grafana/alerts/cron-health.yaml
groups:
  - name: cron_health
    rules:
      # Cron didn't run
      - alert: RenewalCronMissing
        expr: absent(cron_subscription_renewal_last_run_timestamp) or
              (time() - cron_subscription_renewal_last_run_timestamp) > 90000  # 25 hours
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Subscription renewal cron hasn't run in 25+ hours"

      # Cron failed
      - alert: RenewalCronFailed
        expr: cron_subscription_renewal_last_status != 1
        for: 0m
        labels:
          severity: critical
          team: billing
        annotations:
          summary: "Subscription renewal cron failed"

      # Cron duration anomaly
      - alert: RenewalCronSlow
        expr: cron_subscription_renewal_duration_seconds > 300  # 5 min
        for: 0m
        labels:
          severity: warning
          team: billing
        annotations:
          summary: "Renewal cron took > 5 minutes"
```

### Database Constraint Verification

```yaml
# Weekly check that constraints still exist
- alert: BillingConstraintsMissing
  expr: pg_constraint_exists{constraint="subscription_payment_events_idempotency_idx"} != 1
  for: 5m
  labels:
    severity: critical
    team: platform
  annotations:
    summary: "CRITICAL: Billing idempotency constraint missing from database"
    description: "The unique constraint that prevents double-charging is missing"
```

---

## Sentry Configuration

### Issue Alerts for Billing Code

```javascript
// sentry.config.js
Sentry.init({
  // ... other config

  beforeSend(event) {
    // Tag billing-related errors
    if (event.transaction?.includes("/api/subscriptions") ||
        event.transaction?.includes("/api/cron/subscription-renewal")) {
      event.tags = {
        ...event.tags,
        domain: "billing",
        critical: "true",
      }
    }
    return event
  },
})
```

**Sentry Alert Rules:**

1. **New Issue in Billing Code**
   - Filter: `domain:billing`
   - Trigger: New issue
   - Action: Notify #billing-alerts

2. **Invariant Violation**
   - Filter: `tags.invariant:*`
   - Trigger: Any event
   - Action: Page on-call + notify #billing-alerts

3. **Payment Provider Errors**
   - Filter: `error.type:BasePayError`
   - Trigger: > 5 events in 5 min
   - Action: Notify #billing-alerts

---

## PostHog Configuration

### Subscription Funnel Monitoring

```javascript
// Track subscription lifecycle events
posthog.capture("subscription_started", {
  subscriptionId,
  tier: "horoscope-plus",
  amount: 5.0,
})

posthog.capture("subscription_renewal_success", {
  subscriptionId,
  periodNumber: 2,
})

posthog.capture("subscription_renewal_failed", {
  subscriptionId,
  failureReason: "insufficient_funds",
})

posthog.capture("subscription_canceled", {
  subscriptionId,
  reason: "user_requested",
  periodsCompleted: 3,
})
```

**PostHog Alerts:**

1. **Subscription Start Drop**
   - Funnel: Visit subscribe page → Complete subscription
   - Alert if: Conversion drops > 20% week-over-week

2. **Renewal Failure Spike**
   - Event: `subscription_renewal_failed`
   - Alert if: Count > 2x average

3. **Cancellation Spike**
   - Event: `subscription_canceled`
   - Alert if: Count > 2x average in 24h

---

## Instrumentation Checklist

### For Every Critical Operation

```typescript
/**
 * Instrumentation template for billing operations.
 */
const billingOperation = (operationName: string) =>
  Effect.gen(function* () {
    const startTime = Date.now()
    const traceId = crypto.randomUUID()

    // 1. Log start (Grafana/Loki)
    console.log(JSON.stringify({
      level: "info",
      operation: operationName,
      traceId,
      timestamp: new Date().toISOString(),
    }))

    // 2. Start span (Grafana/Tempo via OpenTelemetry)
    const span = tracer.startSpan(operationName, {
      attributes: { "billing.operation": operationName },
    })

    try {
      // ... operation logic ...

      // 3. Record success metric (Grafana/Mimir)
      metrics.increment(`billing.${operationName}.success`)
      metrics.histogram(`billing.${operationName}.duration`, Date.now() - startTime)

      // 4. Track in PostHog if user-facing
      posthog.capture(`billing_${operationName}_success`, { traceId })

      span.setStatus({ code: SpanStatusCode.OK })
    } catch (error) {
      // 5. Record failure metric
      metrics.increment(`billing.${operationName}.failure`, {
        error_type: error.constructor.name,
      })

      // 6. Capture in Sentry with context
      Sentry.captureException(error, {
        tags: {
          operation: operationName,
          traceId,
        },
      })

      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      throw error
    } finally {
      span.end()
    }
  })
```

---

## Alert Response Playbooks

### Playbook: Double Charge Detected

**Severity:** CRITICAL - Customer impact, potential refund needed

1. **Immediate (< 5 min):**
   - Acknowledge alert
   - Check Sentry for full context
   - Identify affected subscription(s)

2. **Investigation (< 30 min):**
   - Pull payment events from DB for affected subscription
   - Check Grafana traces for the renewal cron run
   - Identify if idempotency constraint was bypassed (how?)

3. **Mitigation:**
   - If customer was charged twice: Initiate refund via Base Pay
   - If cron bug: Disable cron, deploy fix
   - If constraint missing: Restore constraint immediately

4. **Follow-up:**
   - Root cause analysis
   - Add/fix test coverage
   - Update guarantee hierarchy if needed

### Playbook: Renewal Cron Failed

**Severity:** HIGH - Subscriptions won't renew, revenue impact

1. **Immediate:**
   - Check Sentry for exception
   - Check Grafana logs for cron output

2. **Investigation:**
   - Was it a transient error (Base Pay down)?
   - Was it a code bug?
   - How many subscriptions were affected?

3. **Mitigation:**
   - If transient: Wait and monitor next run
   - If bug: Fix and manually trigger renewal for missed subscriptions
   - If Base Pay down: Wait for recovery, then catch up

---

## Dashboard Requirements

Every monitoring dashboard must have:

```yaml
Dashboard Metadata:
  owner: "@billing-team"
  purpose: "Monitor subscription billing health and invariants"
  updated: "2024-01-15"

For each panel:
  what_it_shows: "Brief description"
  what_normal_looks_like: "Expected ranges/patterns"
  what_action_to_take: "If abnormal, do X"
  related_playbook: "link to playbook"
```

### Required Dashboards

1. **Billing Health Overview**
   - Renewal success rate
   - Failed renewals by reason
   - Active subscriptions count
   - MRR (Monthly Recurring Revenue)

2. **Billing Invariant Monitor**
   - Double charge count (should be 0)
   - Canceled charge attempts (should be 0)
   - Period advancement failures (should be 0)
   - Idempotent retry rate

3. **Cron Job Health**
   - Last run timestamp
   - Run duration
   - Success/failure status
   - Subscriptions processed per run

---

## Verification: Is Monitoring Sound?

Run this checklist periodically:

```
□ All three billing invariants have alerts configured
□ Alerts fire to the correct channel/person
□ Alerts have been tested (trigger manually)
□ Playbooks exist and are up to date
□ Dashboards have owners and descriptions
□ Sampling rates are appropriate (not missing events)
□ Correlation IDs propagate across all systems
□ Sentry, Grafana, PostHog all have the same user_id
```

### Testing Alert Effectiveness

```typescript
// Periodically inject test events to verify alerting works
if (process.env.ALERT_TEST_MODE === "true") {
  // Emit a fake invariant violation
  metrics.increment("billing.invariant_violation", {
    type: "test_double_charge",
    test: "true",
  })

  Sentry.captureMessage("TEST_INVARIANT_VIOLATION", {
    level: "warning",
    tags: { test: "true", invariant: "TEST" },
  })
}
```

---

## Summary: Tool Responsibilities

| Concern | Primary Tool | What to Configure |
|---------|-------------|-------------------|
| "Is billing broken?" | Grafana | Metrics + alerts for cron health, error rates |
| "Why did billing break?" | Sentry | Exception tracking, release regression |
| "Who was affected?" | PostHog | Funnel analysis, cohort of failed renewals |
| "Was an invariant violated?" | All three | Metric in Grafana, exception in Sentry, event in PostHog |

---

🫡🇩🇪 Trust but verify. Every layer can fail. Production monitoring is the last line of defense.
