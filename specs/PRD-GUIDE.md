# PRD Guide: How to Write and Verify a High‑Quality PRD

This guide defines how to create a PRD that is precise enough for developer handoff, and how to verify it before converting into `spec.json` and `todo.json`.

---

## 1) When to Write a PRD
Write a PRD before any engineering tasks when:
- The feature affects user experience, data model, APIs, or operational workflows.
- There are cross‑team dependencies (product, design, infra, contracts).
- Ambiguity would cause rework or misalignment.

---

## 2) How to Create a PRD (Process)
1) Start from `specs/templates/PRD.template.md`.
2) Conduct a short interview with product + engineering.
3) Fill all sections, leaving no placeholders.
4) Run the “Verification Checklist” below.
5) Only after passing verification, convert into `spec.json` + `todo.json`.

---

## 3) Mandatory Content (No Exceptions)
A PRD is considered **incomplete** if any are missing:
- Clear overview in plain language.
- One‑sentence promise.
- Demo script (5–7 steps).
- Measurable success outcomes.
- User‑centered outcomes (before/after, steps reduced).
- Product character/taste assumptions (tone, visual, interaction feel).
- Explicit non‑goals (out of scope).
- Explicit no‑gos (hard avoids).
- At least one user flow and one error flow.
- Exact API interfaces or function signatures where applicable.
- Data model changes with constraints.
- Data Contracts with valid/invalid examples.
- State machines for core entities.
- Invariants with a Guarantee Hierarchy table.
- Monitoring alerts tied to invariant violations or failure modes.
- Risks with likelihood, impact, and mitigation.
- Acceptance criteria written as Given/When/Then.
- Open questions explicitly listed (even if empty).

---

## 4) The Verification Checklist (Quality Gate)
Use this to approve or reject a PRD.

### A) Clarity & Precision
- Every requirement is testable (observable result or metric).
- No ambiguous words like “fast,” “simple,” “should.” Replace with numbers or concrete behaviors.
- Every screen has exact copy and states.
- User POV is explicit: before/after journey is documented.
- Demo script reads like a product walkthrough.

### B) Completeness
- All edge cases and failure states are defined.
- External dependencies are listed with versions or identifiers.
- All environment variables are listed with scope and secrecy.
- Rollout / rollback is defined.
- Data contracts include schema + constraints + valid/invalid examples.
- State machines include forbidden transitions.

### C) Invariants & Guarantees
- Each critical invariant has a filled Guarantee Hierarchy row.
- For every invariant: at least one test and one monitoring signal.
### D) Monitoring
- At least one alert per critical invariant.
- Metrics defined for error rates and critical workflows.

### E) Traceability
- Each requirement maps to at least one acceptance criterion.
- Each acceptance criterion can map to tasks later.

### F) Feasibility
- Implementation steps are possible with current infra.
- Any missing dependencies are called out in Open Questions.

If any item above fails, return the PRD for revision.

---

## 5) How to Convert PRD → spec.json
Map PRD sections to `spec.json`:
- Overview + Goals → `goals`
- Non‑Goals → `nonGoals`
- API + Behavior → `req.api`, `req.behavior`
- Observability → `req.obs`
- Config → `cfg.env`
- Acceptance Criteria → `accept`
- Assumptions / Open Questions → `assume`

Use the PRD as source of truth, not memory.

---

## 6) How to Convert PRD → todo.json
Break into atomic, verifiable tasks:
- Each requirement maps to one or more tasks.
- Each task has a concrete `verify` step.
- Tests are first‑class tasks (TDD).

---

## 7) Recommended Review Roles
- Product: validates user value and outcomes.
- Design: validates UX flows and states.
- Engineering: validates feasibility, constraints, and invariants.
- QA/DevOps: validates monitoring and rollout.

---

## 8) Example “Good vs Bad”
### Bad
- “Make it fast.”
- “Add subscription support.”

### Good
- “P95 response time under 300ms for POST /api/subscriptions/create.”
- “Support monthly subscriptions with a 30‑day period and idempotent renewal.”

---

## 9) Final Approval Checklist (Sign‑Off)
Use this short gate before handoff:
- [ ] All mandatory sections are complete
- [ ] Invariants have full guarantee coverage
- [ ] Acceptance criteria are executable
- [ ] Data model changes include constraints
- [ ] Rollout and rollback steps are defined

If any box is unchecked, do not proceed.
