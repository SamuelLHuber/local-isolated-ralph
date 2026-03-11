# PRD: <Feature/Project Name>

## One‑Sentence Promise
It lets users <primary outcome> in <time or steps>.

Version: v0.0.0
Date: YYYY-MM-DD
Author: <Name/Team>
Stakeholders: <Names/Roles>
Refs: <docs/... or spec IDs>

---

## 1) Overview (Plain Language)
Describe in 2-4 sentences:
- What we are building
- Who it is for
- Why it matters
- What changes for the user

## 1.1) Demo Script (User POV)
Write a 5–7 step demo story with exact UI copy where relevant.
1) User opens ...
2) Sees "..."
3) Taps "..."
4) Success state: "..."

## 2) Success Outcomes (Measurable)
List concrete outcomes with numbers or observable facts.
- Outcome 1: <metric/behavior>
- Outcome 2: <metric/behavior>
- Outcome 3: <metric/behavior>

## 3) User‑Centered Outcomes (Explicit)
Define end‑to‑end user outcomes in plain language.
- After this ships, users can: ...
- Before vs After: <what changes in their journey>
- Time/effort reduced: <what steps are removed>

Example:
- After this ships, users can subscribe in one tap and immediately unlock daily access.
- Before: pay $0.25 per horoscope. After: pay $5/month with one tap.
- Time reduced: from 3 steps to 1 step.

## 4) Product Character and Taste (Implicit Style Assumptions)
Describe how the product should feel to the user.
- Tone: <e.g., calm, authoritative, playful, luxurious>
- Visual character: <e.g., minimal, bold, high‑contrast, organic>
- Interaction feel: <e.g., one‑tap, frictionless, “no surprises”>
- What it must never feel like: <e.g., spammy, confusing, salesy>

Example:
- Tone: calm, confident, quietly premium.
- Visual character: warm neutrals, high contrast CTA, airy layout.
- Interaction feel: “one‑tap and done,” no surprise confirmations.
- Never: cluttered, transactional, or crypto‑bro branding.

## 4.1) Focus List (Steve‑Style “Yes/No”)
Top 3 things we will do:
1) ...
2) ...
3) ...

Top 3 things we will refuse to do:
1) ...
2) ...
3) ...

## 5) Non-Goals (Out of Scope)
Be explicit about what this is NOT doing (scope exclusions).
- Non-goal 1: ...
- Non-goal 2: ...
- Non-goal 3: ...

## 6) No‑Gos (Hard Avoids)
These are behaviors or outcomes we must actively avoid.
- No‑go 1: ...
- No‑go 2: ...
- No‑go 3: ...

## 7) User Stories and Flows
### Primary User Story
- As a <user>, I want <thing>, so that <benefit>.

### Flow Diagram (ASCII)
```
Entry Point
   |
   v
Step A ----> Step B ----> Step C
   |             |
   v             v
Error A        Error B
```

### Happy Path Steps
1) ...
2) ...
3) ...

### Edge / Failure Paths
- If X fails, user sees Y and system does Z.
- If X is missing, we do Y.

## 8) UI/UX Requirements (If Applicable)
### Screens / Components
- Screen: <name>
- Entry point: <where>
- Copy (exact):
  - Title: "..."
  - Body: "..."
  - CTA: "[...]"

### States
| State | What user sees | Allowed actions |
|------|----------------|-----------------|
| Default | ... | ... |
| Loading | ... | ... |
| Error | ... | ... |
| Success | ... | ... |

### Visual/Interaction Notes
- <Design direction, motion, constraints>

## 9) Functional Requirements
### APIs / Interfaces
List required endpoints or function interfaces with exact input/output.

Example:
```
POST /api/feature/do-thing
Request:
{
  "id": "string",
  "amount": 123
}
Response:
{
  "status": "ok",
  "result": { ... }
}
Error cases: 400, 401, 409, 500
```

### Business Logic Rules
- Rule 1: ...
- Rule 2: ...

## 10) Data Model / Storage
### New Tables or Fields
```sql
CREATE TABLE ...
```

### Constraints / Indexes
- UNIQUE: ...
- CHECK: ...
- FK: ...

### Data Contracts (Required)
Define precise payloads, schemas, and constraints used across services.

#### Contract: <Name>
Purpose: <What this contract is used for>
Producer: <Service/Module>
Consumer(s): <Service/Module>
Version: vX

Schema (JSON):
```
{
  "id": "string",
  "status": "active|inactive",
  "amount": 123.45,
  "createdAt": "2026-02-03T12:00:00Z"
}
```

Constraints:
- `id` is unique per producer.
- `amount` must be positive.
- `createdAt` must be ISO-8601 UTC.

Example payload (valid):
```
{
  "id": "abc123",
  "status": "active",
  "amount": 5,
  "createdAt": "2026-02-03T12:00:00Z"
}
```

Example payload (invalid) + reason:
```
{
  "id": "",
  "status": "pending",
  "amount": -1,
  "createdAt": "yesterday"
}
```
Reason: empty id, status not in enum, amount negative, invalid timestamp.

## 11) State Machines (Required)
Define core state machines and transitions. Include forbidden transitions.

### State Machine: <Name>
States: `STATE_A`, `STATE_B`, `STATE_C`

Transitions:
| From | To | Trigger | Guard | Side Effects |
|------|----|---------|-------|--------------|
| A | B | <event> | <condition> | <effects> |
| B | C | <event> | <condition> | <effects> |

Forbidden transitions:
- C -> A (reason: ...).
- B -> A (reason: ...).

ASCII:
```
A --> B --> C
^     |
|     v
X  (forbidden)
```

## 12) Invariants and Guarantees (Required)
List the critical properties that must always hold.

Example Invariants:
- INV-1: Canceled subscriptions are never charged.
- INV-2: No double charges per period.

### Guarantee Hierarchy (per invariant)
For each invariant, fill this table:

| Invariant | Types | Runtime | Persistence | Tests | Monitoring |
|----------|-------|---------|-------------|-------|------------|
| INV-1 | <type-level rule> | <assert/precondition> | <db constraint> | <tests> | <alerts> |

## 13) Observability
- Logs: what fields must be logged
- Metrics: counters, gauges, histograms
- Traces: what spans are required
- Alerts: what conditions trigger alerts

### Monitoring Alerts (Required)
Define alerts tied to invariants and failure modes.

| Alert | Signal | Threshold | Action |
|-------|--------|-----------|--------|
| NO_DOUBLE_CHARGE | metric: billing.double_charge | > 0 in 24h | page on-call |
| FAILED_WEBHOOKS | metric: webhook.fail | > 5/min | notify slack |

## 14) Security and Privacy
- Auth / permission requirements
- Secrets handling
- Data access policy
- Rate limiting / abuse handling

## 15) Configuration / Environment
List all env vars and config toggles.
- ENV_VAR_NAME: purpose, scope (frontend/backend), secret?

## 16) Dependencies and Integrations
- External APIs
- Internal services
- Libraries / SDKs
- Version constraints

## 17) Rollout / Migration Plan
- Feature flags (if any)
- Migration steps
- Rollback plan
- Backfill steps (if any)

## 18) Testing Plan
### Required Tests
- Unit tests: ...
- Integration tests: ...
- Property tests: ...
- Contract tests: ...

### Definition of Done (DOD)
- `bun test`
- `bun run typecheck`
- Manual QA steps: ...

## 19) Acceptance Criteria
Write as observable outcomes (Given/When/Then).
- Given ..., when ..., then ...
- Given ..., when ..., then ...

## 20) Risks and Mitigations (Required)
List risks with likelihood/impact and mitigations.

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| <risk> | Low/Med/High | Low/Med/High | <plan> | <name> |

## 21) Open Questions
- Q1: ...
- Q2: ...

## 22) Files to Modify / Create (Optional)
| File | Change |
|------|--------|
| `src/...` | ... |

## 23) Appendices

### C) Announcement Draft (User‑Facing)
One paragraph + bullet list:
```
We’re introducing <feature> so you can <benefit>.
Starting <date>, you’ll notice <what changes>.

What’s new:
- <bullet>
- <bullet>
```

### D) Before/After Journey (User POV)
```
Before: Step 1 → Step 2 → Step 3
After: Step 1 → Done
```

### E) Support FAQ (User‑Facing)
- Q: ...
  A: ...
### A) Glossary
- Term: definition

### B) Wireframes / Diagrams
Include ASCII or references to internal files.
