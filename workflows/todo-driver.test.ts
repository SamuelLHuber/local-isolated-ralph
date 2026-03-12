import { expect, test } from "bun:test";
import workflow, {
  filterRelevantRepoPaths,
  repoResetCommand,
  verifierCommands,
} from "./todo-driver";
import { buildContext } from "../node_modules/smithers-orchestrator/src/context";
import { parseTodoContent } from "./utils/todo-plan";
import { markTodoContentDone } from "./utils/todo-status";

function collectTaskIDs(node: unknown): string[] {
  const ids: string[] = [];

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const element = value as { props?: Record<string, unknown> };
    const props = element.props ?? {};
    const id = props.id;
    if (typeof id === "string") ids.push(id);

    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
      return;
    }
    visit(children);
  };

  visit(node);
  return ids;
}

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

test("repo reset command preserves smithers state", () => {
  const command = repoResetCommand("/workspace/workdir");
  expect(command).toContain("! -name .smithers");
  expect(command).toContain("/workspace/workdir");
});

test("review path filtering removes smithers runtime artifacts", () => {
  expect(
    filterRelevantRepoPaths([
      ".smithers/todo-driver.db-wal",
      ".fabrik/tmp/repo-123",
      "src/fabrik-cli/cmd/runs.go",
      "workflows/todo-driver.tsx",
      "src/fabrik-cli/cmd/runs.go",
    ]),
  ).toEqual([
    "src/fabrik-cli/cmd/runs.go",
    "workflows/todo-driver.tsx",
  ]);
});

test("runs-inspection verifier uses focused checks instead of full verify-cli", () => {
  const commands = verifierCommands(
    {
      id: "runs-inspection",
      title: "Runs Inspection",
      status: "pending",
      task: "Inspect runs from Kubernetes.",
      specTieIn: ["orchestrator metadata"],
      guarantees: ["list reflects cluster state"],
      verificationToBuildFirst: ["add deterministic tests"],
      requiredChecks: ["`make verify-cli`"],
      documentationUpdates: [],
      blockedReason: null,
    },
    "/workspace/workdir",
  );

  expect(commands[0]).toBe("cd /workspace/workdir/src/fabrik-cli");
  expect(commands).toContain("go test ./cmd -run 'Runs|Logs'");
  expect(commands).toContain("if [ -d ./internal/runs ]; then go test ./internal/runs; fi");
  expect(commands).toContain("if [ -d ./internal/inspect ]; then go test ./internal/inspect; fi");
  expect(commands.join("\n")).not.toContain("make verify-cli");
});

test("todo-driver schedules review after a successful validation pass", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 1,
    iterations: {},
    input: {},
    outputs: {
      todoPlan: [
        {
          nodeId: "plan-todo-loop",
          iteration: 1,
          items: [
            {
              id: "runs-inspection",
              title: "Runs Inspection",
              status: "pending",
              task: "Inspect runs from Kubernetes.",
              specTieIn: ["orchestrator metadata"],
              guarantees: ["list reflects cluster state"],
              verificationToBuildFirst: ["add deterministic tests"],
              requiredChecks: ["`make verify-cli`"],
              documentationUpdates: [],
              blockedReason: null,
            },
          ],
        },
      ],
      implement: [
        {
          nodeId: "runs-inspection:implement",
          iteration: 0,
          summary: "implemented",
          changes: [],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "runs-inspection:validate",
          iteration: 0,
          allPassed: true,
          commands: [],
          evidence: [],
          failingSummary: null,
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:review:spec-alignment");
  expect(ids).toContain("runs-inspection:implement");
});

test("todo-driver schedules finalization after reviewers approve", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 2,
    iterations: {},
    input: {},
    outputs: {
      todoPlan: [
        {
          nodeId: "plan-todo-loop",
          iteration: 2,
          items: [
            {
              id: "runs-inspection",
              title: "Runs Inspection",
              status: "pending",
              task: "Inspect runs from Kubernetes.",
              specTieIn: ["orchestrator metadata"],
              guarantees: ["list reflects cluster state"],
              verificationToBuildFirst: ["add deterministic tests"],
              requiredChecks: ["`make verify-cli`"],
              documentationUpdates: [],
              blockedReason: null,
            },
          ],
        },
      ],
      implement: [
        {
          nodeId: "runs-inspection:implement",
          iteration: 0,
          summary: "implemented",
          changes: [],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "runs-inspection:validate",
          iteration: 0,
          allPassed: true,
          commands: [],
          evidence: [],
          failingSummary: null,
        },
      ],
      review: [
        {
          nodeId: "runs-inspection:review:spec-alignment",
          iteration: 1,
          reviewer: "Spec Alignment",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:maintainability",
          iteration: 1,
          reviewer: "Maintainability",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:verification",
          iteration: 1,
          reviewer: "Verification",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:mark-todo-done");
  expect(ids).not.toContain("runs-inspection:implement");
});

test("todo-driver re-runs validation after a failed validation and new implementation", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 2,
    iterations: {},
    input: {},
    outputs: {
      todoPlan: [
        {
          nodeId: "plan-todo-loop",
          iteration: 2,
          items: [
            {
              id: "runs-inspection",
              title: "Runs Inspection",
              status: "pending",
              task: "Inspect runs from Kubernetes.",
              specTieIn: ["orchestrator metadata"],
              guarantees: ["list reflects cluster state"],
              verificationToBuildFirst: ["add deterministic tests"],
              requiredChecks: ["`make verify-cli`"],
              documentationUpdates: [],
              blockedReason: null,
            },
          ],
        },
      ],
      implement: [
        {
          nodeId: "runs-inspection:implement",
          iteration: 2,
          summary: "revised implementation",
          changes: ["src/fabrik-cli/cmd/runs.go"],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "runs-inspection:validate",
          iteration: 0,
          allPassed: false,
          commands: [],
          evidence: ["previous validation failed"],
          failingSummary: "validation failed",
        },
      ],
      report: [
        {
          nodeId: "runs-inspection:snapshot-implement",
          iteration: 2,
          ticketId: "runs-inspection",
          status: "partial",
          summary: "snapshotted revised implementation",
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:validate");
  expect(ids).toContain("runs-inspection:implement");
});

test("todo-driver ignores stale review issues after a new implementation and revalidates", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 3,
    iterations: {},
    input: {},
    outputs: {
      todoPlan: [
        {
          nodeId: "plan-todo-loop",
          iteration: 3,
          items: [
            {
              id: "runs-inspection",
              title: "Runs Inspection",
              status: "pending",
              task: "Inspect runs from Kubernetes.",
              specTieIn: ["orchestrator metadata"],
              guarantees: ["list reflects cluster state"],
              verificationToBuildFirst: ["add deterministic tests"],
              requiredChecks: ["`make verify-cli`"],
              documentationUpdates: [],
              blockedReason: null,
            },
          ],
        },
      ],
      implement: [
        {
          nodeId: "runs-inspection:implement",
          iteration: 3,
          summary: "implemented review feedback",
          changes: ["src/fabrik-cli/internal/runs/inspect.go"],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "runs-inspection:validate",
          iteration: 1,
          allPassed: true,
          commands: [],
          evidence: [],
          failingSummary: null,
        },
      ],
      review: [
        {
          nodeId: "runs-inspection:review:spec-alignment",
          iteration: 1,
          reviewer: "spec-alignment",
          approved: false,
          issues: ["close the metadata gap"],
          requiredFollowUps: [],
        },
      ],
      report: [
        {
          nodeId: "runs-inspection:snapshot-review-fix",
          iteration: 2,
          ticketId: "runs-inspection",
          status: "partial",
          summary: "snapshotted review fix",
        },
        {
          nodeId: "runs-inspection:snapshot-implement",
          iteration: 3,
          ticketId: "runs-inspection",
          status: "partial",
          summary: "snapshotted revised implementation",
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:validate");
  expect(ids).toContain("runs-inspection:implement");
  expect(ids).toContain("runs-inspection:review:spec-alignment");
});

test("todo-driver requires fresh reviews after a new validation pass", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 3,
    iterations: {},
    input: {},
    outputs: {
      todoPlan: [
        {
          nodeId: "plan-todo-loop",
          iteration: 3,
          items: [
            {
              id: "runs-inspection",
              title: "Runs Inspection",
              status: "pending",
              task: "Inspect runs from Kubernetes.",
              specTieIn: ["orchestrator metadata"],
              guarantees: ["list reflects cluster state"],
              verificationToBuildFirst: ["add deterministic tests"],
              requiredChecks: ["`make verify-cli`"],
              documentationUpdates: [],
              blockedReason: null,
            },
          ],
        },
      ],
      implement: [
        {
          nodeId: "runs-inspection:implement",
          iteration: 2,
          summary: "implemented",
          changes: ["src/fabrik-cli/cmd/runs.go"],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "runs-inspection:validate",
          iteration: 3,
          allPassed: true,
          commands: [],
          evidence: [],
          failingSummary: null,
        },
      ],
      review: [
        {
          nodeId: "runs-inspection:review:spec-alignment",
          iteration: 1,
          reviewer: "Spec Alignment",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:maintainability",
          iteration: 1,
          reviewer: "Maintainability",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:verification",
          iteration: 1,
          reviewer: "Verification",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
      ],
      report: [
        {
          nodeId: "runs-inspection:snapshot-implement",
          iteration: 2,
          ticketId: "runs-inspection",
          status: "partial",
          summary: "snapshotted implementation",
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:review:spec-alignment");
  expect(ids).toContain("runs-inspection:review:maintainability");
  expect(ids).toContain("runs-inspection:review:verification");
  expect(ids).not.toContain("runs-inspection:mark-todo-done");
});

test("todo-driver snapshots completion after marking todo done", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 5,
    iterations: {},
    input: {},
    outputs: {
      todoPlan: [
        {
          nodeId: "plan-todo-loop",
          iteration: 4,
          items: [
            {
              id: "runs-inspection",
              title: "Runs Inspection",
              status: "pending",
              task: "Inspect runs from Kubernetes.",
              specTieIn: ["orchestrator metadata"],
              guarantees: ["list reflects cluster state"],
              verificationToBuildFirst: ["add deterministic tests"],
              requiredChecks: ["`make verify-cli`"],
              documentationUpdates: [],
              blockedReason: null,
            },
          ],
        },
      ],
      implement: [
        {
          nodeId: "runs-inspection:implement",
          iteration: 4,
          summary: "implemented",
          changes: [],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "runs-inspection:validate",
          iteration: 4,
          allPassed: true,
          commands: [],
          evidence: [],
          failingSummary: null,
        },
      ],
      review: [
        {
          nodeId: "runs-inspection:review:spec-alignment",
          iteration: 4,
          reviewer: "Spec Alignment",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:maintainability",
          iteration: 4,
          reviewer: "Maintainability",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:verification",
          iteration: 4,
          reviewer: "Verification",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
      ],
      report: [
        {
          nodeId: "runs-inspection:mark-todo-done",
          iteration: 4,
          ticketId: "runs-inspection",
          status: "done",
          summary: "Marked done",
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:snapshot-complete");
  expect(ids).not.toContain("runs-inspection:mark-todo-done");
});

test("todo-driver emits a completion report after completion snapshot when no bookmark is configured", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 6,
    iterations: {},
    input: {},
    outputs: {
      todoPlan: [
        {
          nodeId: "plan-todo-loop",
          iteration: 4,
          items: [
            {
              id: "runs-inspection",
              title: "Runs Inspection",
              status: "pending",
              task: "Inspect runs from Kubernetes.",
              specTieIn: ["orchestrator metadata"],
              guarantees: ["list reflects cluster state"],
              verificationToBuildFirst: ["add deterministic tests"],
              requiredChecks: ["`make verify-cli`"],
              documentationUpdates: [],
              blockedReason: null,
            },
          ],
        },
      ],
      implement: [
        {
          nodeId: "runs-inspection:implement",
          iteration: 4,
          summary: "implemented",
          changes: [],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "runs-inspection:validate",
          iteration: 4,
          allPassed: true,
          commands: [],
          evidence: [],
          failingSummary: null,
        },
      ],
      review: [
        {
          nodeId: "runs-inspection:review:spec-alignment",
          iteration: 4,
          reviewer: "Spec Alignment",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:maintainability",
          iteration: 4,
          reviewer: "Maintainability",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:verification",
          iteration: 4,
          reviewer: "Verification",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
      ],
      report: [
        {
          nodeId: "runs-inspection:mark-todo-done",
          iteration: 4,
          ticketId: "runs-inspection",
          status: "done",
          summary: "Marked done",
        },
        {
          nodeId: "runs-inspection:snapshot-complete",
          iteration: 5,
          ticketId: "runs-inspection",
          status: "done",
          summary: "Snapshotted completion",
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:complete-report");
  expect(ids).not.toContain("runs-inspection:snapshot-complete");
});

test("todo-driver emits a completion report after bookmark push", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 7,
    iterations: {},
    input: {},
    outputs: {
      todoPlan: [
        {
          nodeId: "plan-todo-loop",
          iteration: 4,
          items: [
            {
              id: "runs-inspection",
              title: "Runs Inspection",
              status: "pending",
              task: "Inspect runs from Kubernetes.",
              specTieIn: ["orchestrator metadata"],
              guarantees: ["list reflects cluster state"],
              verificationToBuildFirst: ["add deterministic tests"],
              requiredChecks: ["`make verify-cli`"],
              documentationUpdates: [],
              blockedReason: null,
            },
          ],
        },
      ],
      implement: [
        {
          nodeId: "runs-inspection:implement",
          iteration: 4,
          summary: "implemented",
          changes: [],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "runs-inspection:validate",
          iteration: 4,
          allPassed: true,
          commands: [],
          evidence: [],
          failingSummary: null,
        },
      ],
      review: [
        {
          nodeId: "runs-inspection:review:spec-alignment",
          iteration: 4,
          reviewer: "Spec Alignment",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:maintainability",
          iteration: 4,
          reviewer: "Maintainability",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "runs-inspection:review:verification",
          iteration: 4,
          reviewer: "Verification",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
      ],
      report: [
        {
          nodeId: "runs-inspection:mark-todo-done",
          iteration: 4,
          ticketId: "runs-inspection",
          status: "done",
          summary: "Marked done",
        },
        {
          nodeId: "runs-inspection:snapshot-complete",
          iteration: 5,
          ticketId: "runs-inspection",
          status: "done",
          summary: "Snapshotted completion",
        },
        {
          nodeId: "runs-inspection:push-bookmark",
          iteration: 6,
          ticketId: "runs-inspection",
          status: "done",
          summary: "Pushed bookmark",
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:complete-report");
  expect(ids).not.toContain("runs-inspection:push-bookmark");
});
