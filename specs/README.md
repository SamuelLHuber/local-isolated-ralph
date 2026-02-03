# Specs Workflow (Human Guide)

This repo follows a strict, test-driven flow for all features.

## Flow
1) **Interview → Spec**
   - A human prompts an interview agent.
   - Agent drafts `spec.json`.
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
Interview → spec.json → todo.json → Smithers workflow → report.json
                       (minify)      (tasks, TDD, DOD)   (per task)
```

## Files
- Specs (human): `specs/*.json`
- Specs (Smithers input): `specs/*.min.json`
- TODOs (human): `specs/*.todo.json`
- TODOs (Smithers input): `specs/*.todo.min.json`

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
- Read `specs/000-base.json` and `specs/000-base.todo.json`.
- Implement in order, with tests first.
