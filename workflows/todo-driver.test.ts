import { expect, test } from "bun:test";
import workflow from "./todo-driver";
import { buildContext } from "../node_modules/smithers-orchestrator/src/context";
import { parseTodoContent } from "./utils/todo-plan";
import { markTodoContentDone } from "./utils/todo-status";

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

test("parseTodoContent records done status from numbered headings", () => {
  const items = parseTodoContent(`
## 1. Runs Inspection [done]
Status: done
Verified by workflow run: run-123

### Task

Inspect runs from Kubernetes.

### Spec tie-in

- orchestrator metadata

### Guarantees

- list reflects cluster state

### Verification to build first

- add deterministic tests

### Required checks

- \`make verify-cli\`
`);

  expect(items).toHaveLength(1);
  expect(items[0]?.id).toBe("runs-inspection");
  expect(items[0]?.status).toBe("done");
  expect(items[0]?.task).toBe("Inspect runs from Kubernetes.");
});

test("markTodoContentDone marks the heading and injects verification metadata", () => {
  const updated = markTodoContentDone(
    `
## 1. Runs Inspection

### Task

Inspect runs from Kubernetes.

### Spec tie-in

- orchestrator metadata

### Guarantees

- list reflects cluster state

### Verification to build first

- add deterministic tests

### Required checks

- \`make verify-cli\`
`,
    "runs-inspection",
    {
      runID: "run-456",
      verificationSummary: "Verification passed in-cluster.",
    },
  );

  expect(updated).toContain("## 1. Runs Inspection [done]");
  expect(updated).toContain("Status: done");
  expect(updated).toContain("Verified by workflow run: run-456");
  expect(updated).toContain("Verification summary: Verification passed in-cluster.");

  const reparsed = parseTodoContent(updated);
  expect(reparsed[0]?.status).toBe("done");
});

test("todo-driver builds a Smithers workflow from context", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 0,
    iterations: {},
    input: {},
    outputs: {},
    zodToKeyName: workflow.zodToKeyName,
  });

  const tree = workflow.build(ctx);
  expect(tree).toBeTruthy();
});
