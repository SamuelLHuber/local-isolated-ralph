# Specs Workflow (Human Guide)

This repo follows a strict, test-driven flow for all features.

## Flow
1) **PRD → Spec**
   - Human drafts `PRD.md` using `specs/templates/PRD.template.md`.
   - Human verifies PRD with `specs/PRD-GUIDE.md`.
   - Agent drafts `spec.json` from the approved PRD.
   - Human reviews and edits `spec.json`.

2) **Spec → TODO**
   - Agent generates `todo.json` from the approved spec.

3) **TODO → Implementation (Smithers)**
   - Smithers runs tasks in order with tests first.
   - Emit `report.json` per task (includes root-cause fields).

4) **Manual Review Checkpoints**
   - Review after each spec before proceeding to the next.

## Diagram

```
PRD.md → spec.json → todo.json → Smithers workflow → report.json
          (minify)      (tasks, TDD, DOD)   (per task)
```

## Files
- Specs (human): `specs/*.json`
- Specs (Smithers input): `specs/*.min.json`
- TODOs (human): `specs/*.todo.json`
- TODOs (Smithers input): `specs/*.todo.min.json`

## Current Specs
- `000-base`
- `020-fabrik-v0-2-0`
- `021-fabrik-run-persistence`
- `022-fabrik-doctor`

## Report Format (per task)
`reports/<task>.report.json` fields include:
- `status`, `work`, `files`, `tests`, `issues`, `next`
- `rootCause`, `reasoning`, `fix`, `error`, `commit`

## Minified Inputs (Smithers)
- Humans generate minified JSON for token-efficient runs.
- Smithers consumes `*.min.json` and does **not** regenerate them.

Generate minified files:

```bash
bun run scripts/minify-specs.ts
```

## Testing Requirements
- TDD is mandatory.
- Use `@effect/vitest` and Effect DI for external services.
- Definition of Done: `bun test`, `bun run typecheck`.

## Start Here
- Read `specs/templates/PRD.template.md` and `specs/PRD-GUIDE.md`.
- Read `specs/000-base.md`, `specs/000-base.json`, and `specs/000-base.todo.json`.
- Implement in order, with tests first.
