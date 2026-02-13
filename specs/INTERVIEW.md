# Compound Engineering: Spec Interview Process

> Each unit of engineering work should make subsequent units easier—not harder.

Traditional development accumulates technical debt. Every feature adds complexity.
The codebase becomes harder to work with over time.

**Compound engineering inverts this.**
- 80% in planning and review
- 20% in execution

The result: quality compounds, future changes become easier.

---

## The 80/20 Rule Applied

```
┌─────────────────────────────────────────────────────────────┐
│  80% PLANNING & REVIEW                                       │
│  ├── Interview (this document)                              │
│  ├── Spec creation with layered guarantees                  │
│  ├── Todo generation with task decomposition                │
│  └── Multi-agent review (8 reviewers)                       │
├─────────────────────────────────────────────────────────────┤
│  20% EXECUTION                                               │
│  └── Implementation with strict guardrails                  │
└─────────────────────────────────────────────────────────────┘
```

**Slow down to speed up.** Thorough planning prevents rework. Rigorous review
captures learnings. High quality makes the next feature easier.

---

## Principles

### 1. Plan Thoroughly Before Writing Code

**Spec is the contract.** Once written, the spec is the source of truth.
Changing requirements mid-flight costs 10x more than getting them right upfront.

**The Interview Process** (this document) exists to:
- Extract complete requirements before implementation
- Identify edge cases and failure modes early
- Agree on acceptance criteria (when is this "done"?)
- Document assumptions that could change

**Rule**: If you can't answer all 10 interview questions completely,
you don't understand the problem well enough to implement.

### 2. Review to Catch Issues and Capture Learnings

**Review is not gatekeeping. Review is knowledge work.**

Every review finding is an opportunity to:
- Fix the issue (immediate value)
- Document the pattern (future value)
- Update checklists (compound value)

**Our 8 Reviewer System**:
```
Layer 1: Security, Code Quality, Simplicity, Test Coverage, Maintainability
Layer 2: Tigerstyle (Consistency, Explicitness, Density, Locality)
Layer 3: NASA-10-RULES (Power of Ten, Guarantee Hierarchy)
Layer 4: Correctness & Invariant Validation (T1-T4 tiers)
```

Each reviewer is a specialist. Together they ensure:
- No security vulnerabilities slip through
- Code follows established patterns
- Invariants are verified at multiple layers
- Future maintainers can understand the code

### 3. Codify Knowledge So It's Reusable

**Every spec, todo, and review is a teaching document.**

Patterns to capture:
- **@property TSDoc comments**: Name invariants explicitly
- **Branded types**: How to avoid primitive obsession
- **Effect.assert patterns**: Where to add guard clauses
- **DB constraint recipes**: Common uniqueness patterns
- **Todo templates**: Reusable task structures

**Knowledge lives in**:
- `prompts/reviewers/*.md` - Review criteria
- `docs/guides/*.md` - Deep patterns
- `specs/*.json` + `specs/*.todo.json` - Executable specifications
- Test files with @property comments - Living documentation

### 4. Keep Quality High So Future Changes Are Easy

**Quality is a strategic asset, not a tactical cost.**

The 6 Guarantee Layers (L1-L6) exist to make changes safe:
```
L1 Types:      Compiler prevents invalid states
L2 Runtime:    Assertions catch violations immediately  
L3 Persistence: DB enforces constraints even if app has bugs
L4 Tests:      Invariants verified in CI
L5 Monitoring: Production alerts catch the impossible
L6 Simulation: 24/7 seed-based testing (T1 only)
```

**With these layers**, you can:
- Refactor confidently (types catch mistakes)
- Add features safely (tests verify invariants hold)
- Deploy continuously (monitoring catches edge cases)
- Onboard quickly (specs explain the "why")

---

## The 10-Question Interview

### Pre-Interview Checklist

Before starting, confirm:
1. [ ] **Problem clarity**: Can you state the problem in one sentence?
2. [ ] **Boundary understanding**: What's explicitly out of scope?
3. [ ] **Success criteria**: How will we know this is done?

If any unchecked, **do not proceed**. Clarify first.

---

### Q1: IDENTITY

**"What is the unique identifier for this work?"**

- Format: `kebab-case` (e.g., `user-auth-v2`, `billing-idempotency`)
- Must be unique across all specs
- Used in:
  - Filename: `specs/{id}.json`
  - Branch names: `{id}-{task-id}`
  - Commit trailers: `spec: {id}`
  - Run IDs: `{id}-{timestamp}`

**Why**: Identity enables tracking, correlation, and forensics.
Every artifact links back to its spec.

---

### Q2: TITLE

**"What is the one-sentence description?"**

Rules:
- Active voice: "Implement", "Add", "Fix", "Remove"
- NO implementation details
- NO technology names (unless the feature IS the technology)

| Bad | Good |
|-----|------|
| "Use WebAuthn API for auth" | "Enable passwordless authentication" |
| "Add Redis cache layer" | "Reduce API response time to <100ms" |
| "Refactor UserService" | "Enable user data export without downtime" |

**Why**: Titles communicate intent. Implementation changes; intent is stable.

---

### Q3: STATUS

**"What is the current state?"**

States:
- `draft` - Still being defined, not ready for work
- `ready` - Interview complete, spec approved, ready to implement
- `in-progress` - Implementation started
- `review` - Implementation complete, under review
- `done` - Accepted and merged
- `superseded` - Replaced by newer spec

Start with `draft`. Move to `ready` only after:
- All 10 questions answered
- Todo generated
- Reviewers assigned

---

### Q4: GOALS (Non-Negotiable)

**"What MUST this accomplish? List 3-7 specific outcomes."**

Each goal:
- Starts with a verb: "Enable", "Provide", "Ensure", "Prevent"
- Is measurable when possible
- Contains NO implementation details
- Would make the user/customer successful

Example:
```
Goals:
- Enable users to log in without memorizing passwords
- Provide fallback authentication for lost devices  
- Ensure account recovery is possible without support tickets
```

**Anti-pattern**: Implementation in goals
```
Bad:  "Use Passkeys API with fallbacks"
Good: "Enable passwordless authentication with fallback options"
```

**Why**: Goals are the "what". Implementation is the "how".
Separate them to allow implementation flexibility.

---

### Q5: NON-GOALS (Critical for Scope)

**"What is explicitly OUT of scope?"**

Every feature has tempting extensions. List them explicitly.
This prevents:
- Scope creep during implementation
- "While we're here..." additions
- Vague requirements

Example:
```
Non-Goals:
- Social login (Google/GitHub) - out of scope for v1
- Biometric authentication (TouchID/FaceID) - future consideration
- Enterprise SSO (SAML/OIDC) - requires separate spec
```

**Rule**: If a stakeholder might ask for it, document it as a non-goal.

---

### Q6: REQUIREMENTS - API

**"What interfaces and contracts must exist?"**

Document:
- Function signatures (inputs, outputs, errors)
- Data structures (schemas, validation rules)
- API endpoints (paths, methods, request/response)
- Configuration options (env vars, feature flags)

Effect-TS specific:
- Error channel types (what can fail?)
- Service requirements (dependencies)
- Branded types (domain value constraints)

Example:
```typescript
// authenticate: (credentials) => Effect<User, AuthError, DbService>
// Error types: InvalidCredentials | AccountLocked | RateLimited
```

---

### Q7: REQUIREMENTS - BEHAVIOR

**"What must happen functionally?"**

Document:
- Business logic rules
- State transitions and their triggers
- Error handling (what happens when things fail?)
- Edge cases (empty inputs, maximum values, race conditions)

Use: **Given/When/Then** format
```
Given: User has active subscription
When: Payment succeeds
Then: Period advances by 30 days
And:  Invoice is generated
And:  Email receipt is sent
```

---

### Q8: REQUIREMENTS - OBSERVABILITY

**"How do we know it's working?"**

Document:
- Metrics to emit (counters, histograms, gauges)
- Logs to write (events, decisions, errors)
- Alerts needed (conditions, severity, runbooks)
- Health checks (endpoints, thresholds)

Example:
```
Metrics:
- auth.attempts (counter with status label)
- auth.duration (histogram)

Alerts:
- High error rate (>5% in 5min) → P1 alert
- Latency p99 >500ms → P2 alert
```

---

### Q9: ACCEPTANCE CRITERIA

**"How do we verify this is complete?"**

Specific, testable conditions:
- [ ] Test scenarios with inputs and expected outputs
- [ ] Manual QA steps for UI flows
- [ ] Performance thresholds (latency, throughput)
- [ ] Security checks (penetration tests, audit logs)

Each criterion MUST be verifiable by:
- Automated test, OR
- Manual test with clear steps, OR
- Observability check (metric/alert exists)

---

### Q10: ASSUMPTIONS

**"What are we assuming that could change?"**

Document:
- External dependencies (APIs, libraries)
- Platform constraints (OS, hardware)
- Timing expectations (response times, SLAs)
- Volume expectations (users, requests, data size)

Example:
```
Assumptions:
- WebAuthn is available in target browsers (>95% support)
- User has hardware token or platform authenticator
- Rate limit: 100 auth attempts per IP per minute
```

**Why**: When assumptions break, we know what to revisit.

---

## Post-Interview: Generate Outputs

### 1. Spec JSON

Save to: `specs/{id}.json`

```json
{
  "v": 1,
  "id": "<Q1-answer>",
  "title": "<Q2-answer>",
  "status": "<Q3-answer>",
  "version": "1.0.0",
  "lastUpdated": "<ISO-date>",
  "goals": ["<Q4-1>", "<Q4-2>"],
  "nonGoals": ["<Q5-1>", "<Q5-2>"],
  "req": {
    "api": ["<Q6-1>", "<Q6-2>"],
    "behavior": ["<Q7-1>", "<Q7-2>"],
    "obs": ["<Q8-1>", "<Q8-2>"]
  },
  "accept": ["<Q9-1>", "<Q9-2>"],
  "assume": ["<Q10-1>", "<Q10-2>"]
}
```

### 2. Todo JSON

Generate via: `fabrik todo generate`

Save to: `specs/{id}.todo.json`

See: [prompts/COMPOUND-ENGINEERING.md](../prompts/COMPOUND-ENGINEERING.md) for detailed
todo generation guidance including:
- Criticality tier determination (T1-T4)
- Definition of Done (DoD) by tier
- Task decomposition patterns
- @property invariant naming

---

## Compound Engineering Checklist

Before marking spec as `ready`:

- [ ] **Planning Complete**: All 10 questions answered
- [ ] **Goals Clear**: No implementation details in goals
- [ ] **Scope Bounded**: Non-goals explicitly listed
- [ ] **Requirements Verifiable**: API, behavior, observability specified
- [ ] **Tier Determined**: T1/T2/T3/T4 identified
- [ ] **Todo Generated**: Tasks decomposed with DoD
- [ ] **Reviewers Assigned**: 8 reviewers configured
- [ ] **Layers Planned**: L1-L6 (or subset) mapped to tasks

After implementation complete:
- [ ] **All Tasks Done**: Each with verification
- [ ] **All Reviews Passed**: 8 reviewers approved
- [ ] **Human Gate Cleared**: Manual approval recorded
- [ ] **Knowledge Captured**: Patterns documented in prompts/

---

## The Payoff

**Month 1**: Slower than "just coding" (80% planning overhead)
**Month 3**: Same speed, fewer bugs (quality compounds)
**Month 6**: Faster than traditional (reuse patterns, safe refactoring)
**Month 12**: 2-3x velocity (compound interest on quality)

Each spec makes the next easier. Each review captures reusable knowledge.
Each layer of guarantee makes future changes safer.

**Compound engineering: Invest in quality, reap exponential returns.**
