import { expect, test } from "bun:test";
import { parseTodoContent } from "./utils/todo-plan";

test("parseTodoContent stops at non-task level-two headings", () => {
  const items = parseTodoContent(`
# Fabrik CLI Todo

## 10. Sample Contract

### Task

Keep the sample repeatable.

### Spec tie-in

- orchestrator operator UX goals

### Guarantees

- bundle only contains workflow code

### Verification to build first

- direct tests for workflow bundle contents

### Required checks

- \`make verify-cli\`
- \`make verify-cli-k3d\`

## Ongoing Rule For Future Work

Before starting any new major CLI feature:

1. add the task here,
2. state the spec tie-in,
3. define the guarantees.
`);

  expect(items).toHaveLength(1);
  expect(items[0]?.id).toBe("sample-contract");
  expect(items[0]?.requiredChecks).toEqual([
    "`make verify-cli`",
    "`make verify-cli-k3d`",
  ]);
});
