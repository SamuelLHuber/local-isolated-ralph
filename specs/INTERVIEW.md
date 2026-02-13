# Human Interview Instructions (Spec/TODO Pipeline)

## Workflow
1) **Human prompts an interview agent** to capture intent and constraints.
2) **Agent drafts `spec.json`** from the interview.
3) **Human reviews/edits `spec.json`.**
4) **Agent generates `todo.json`** from the approved spec.
5) **Human dispatches the run** (Fabrik auto-minifies spec/todo for token efficiency).
6) **Execution agents implement** tasks from `todo.json` (minified in the run workdir) and emit `task_report` rows in the Smithers db.

## Frontmatter (Spec Metadata)
Each spec includes metadata fields:
- **Status** (e.g., Implemented, Draft, Proposed)
- **Version** (e.g., 1.0)
- **Last Updated** (YYYY-MM-DD)
- **Supersedes** (array of spec IDs)
- **DependsOn** (array of spec IDs)

## Interview Stages
### Stage A: Problem & Scope (Idea → Interviews)
Ask to capture intent, constraints, and success.
- What problem are we solving, and for whom?
- What outcomes define success?
- What is explicitly out of scope?
- What constraints are non‑negotiable (time, data sources, privacy, infra)?
- What existing systems must we integrate with?

### Stage B: Requirements (Interviews → Spec)
Translate answers into structured requirements.
- Required API endpoints and behaviors?
- Must‑have observability and error handling?
- Security expectations (auth, idempotency, retention)?
- Config/ENV requirements?
- Acceptance criteria in concrete terms?
- What does this spec supersede, and what does it depend on?

### Stage C: Execution Plan (Spec → TODO)
Break spec into atomic, verifiable tasks.
- What are the minimal test cases per requirement?
- What is the dependency order?
- What is the Definition of Done (tests/typecheck)?

## Mapping Interviews to JSON
### Spec JSON (`spec.json`)
Fill fields from Stage A/B:
- `status`, `version`, `lastUpdated`, `supersedes`, `dependsOn`
- `goals`: success outcomes
- `nonGoals`: explicit exclusions
- `req.api`: required endpoints
- `req.behavior`: required behaviors (async, idempotent, retries)
- `req.obs`: observability requirements
- `cfg.env`: required env vars
- `accept`: measurable acceptance criteria
- `assume`: explicit assumptions

### TODO JSON (`todo.json`)
Fill fields from Stage C:
- `tasks[]`: atomic steps with `do` and `verify`
- `dod`: global checks (tests/typecheck)
- `tdd`: set true

## Token-Optimized Storage
- Source of truth: `*.json` (human-reviewed)
- Runtime/agent: minified copies generated automatically on dispatch (gitignored)

## Output Artifacts
- `spec.json`
- `todo.json`
- `task_report` rows in the Smithers db
- Minified copies live in the run workdir only.

## Prompt Templates (Token-Efficient)
### Interview → Spec Prompt
```
You are interviewing a human to produce spec.json.
Ask only the minimum questions required to fill: status, version, lastUpdated, supersedes, dependsOn, goals, nonGoals, req.api, req.behavior, req.obs, cfg.env, accept, assume.
Confirm missing fields. Then output spec.json.
```

### Spec → TODO Prompt
```
You are converting spec.json into todo.json.
Every task must be atomic, verifiable, and test-first.
Return todo.json only.
```

### Execution Prompt
```
You are executing todo.json with TDD.
Complete tasks in order. After each task, output a task_report row with rootCause/reasoning/fix/error/commit.
Stop if blocked.
```

### Review Prompt
```
You are reviewing task_report entries against spec.json and todo.json.
Confirm requirements and tests. Output a review_summary row with status approved/changes_requested and issues/next as needed.
```
