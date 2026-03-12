import { expect, test } from "bun:test";
import workflow, {
  chooseCurrentTodoItem,
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

function findTaskNode(node: unknown, id: string): { props?: Record<string, unknown> } | null {
  let match: { props?: Record<string, unknown> } | null = null;

  const visit = (value: unknown) => {
    if (match || !value || typeof value !== "object") return;
    const element = value as { props?: Record<string, unknown> };
    const props = element.props ?? {};
    if (props.id === id) {
      match = element;
      return;
    }

    const children = props.children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
      return;
    }
    visit(children);
  };

  visit(node);
  return match;
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

test("chooseCurrentTodoItem prioritizes the active planned item before the next file item", () => {
  const activeItem = {
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
  } as const;
  const nextFileItem = {
    id: "resume",
    title: "Resume",
    status: "pending",
    task: "Resume runs.",
    specTieIn: ["orchestrator metadata"],
    guarantees: ["resume preserves PVC and image digest"],
    verificationToBuildFirst: ["resume command tests"],
    requiredChecks: ["`make verify-cli`"],
    documentationUpdates: [],
    blockedReason: null,
  } as const;

  expect(
    chooseCurrentTodoItem([activeItem, nextFileItem], activeItem.id, [nextFileItem]),
  ).toEqual(
    activeItem,
  );
  expect(chooseCurrentTodoItem([nextFileItem], null, [nextFileItem])).toEqual(
    nextFileItem,
  );
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

test("todo-driver wraps planning in a backlog Ralph loop", () => {
  const ctx = buildContext({
    runId: "preview",
    iteration: 0,
    iterations: {},
    input: {},
    outputs: {},
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("todo-backlog-loop");
  expect(ids).toContain("plan-todo-loop");
});

test("repo reset command preserves smithers state", () => {
  const command = repoResetCommand("/workspace/workdir");
  expect(command).toContain("! -name .smithers");
  expect(command).toContain("! -name .fabrik");
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
  expect(commands).toHaveLength(3);
  expect(commands.join("\n")).not.toContain("fabrik-verify-runs");
  expect(commands.join("\n")).not.toContain("run logs --id");
  expect(commands.join("\n")).not.toContain("runs show --id");
  expect(commands.join("\n")).not.toContain("./internal/runs");
  expect(commands.join("\n")).not.toContain("./internal/inspect");
  expect(commands.join("\n")).not.toContain("make verify-cli");
});

test("verification-map verifier uses portable search commands", () => {
  const commands = verifierCommands(
    {
      id: "verification-map",
      title: "Verification Map",
      status: "pending",
      task: "Document the verification map.",
      specTieIn: ["orchestrator verification"],
      guarantees: ["verification guidance is documented"],
      verificationToBuildFirst: ["doc checks"],
      requiredChecks: ["`make verify-cli`"],
      documentationUpdates: [],
      blockedReason: null,
    },
    "/workspace/workdir",
  );

  expect(commands[0]).toBe("cd /workspace/workdir/src/fabrik-cli");
  expect(commands[2]).toBe("cd /workspace/workdir");
  expect(commands[3]).toContain("command -v rg");
  expect(commands[3]).toContain("grep -En");
  expect(commands[4]).toContain("Workflow Validation In Clusters");
  expect(commands[5]).toContain("same-cluster verifier Jobs");
});

test("remaining todo items fall back to deterministic repo-wide verification", () => {
  for (const id of [
    "env-promotion-protected-environments",
    "retention-cleanup",
    "security-hardening-alignment",
    "observability-loki",
    "rootserver-k3s-parity",
    "sample-contract",
  ] as const) {
    const commands = verifierCommands(
      {
        id,
        title: id,
        status: "pending",
        task: "todo",
        specTieIn: ["spec"],
        guarantees: ["guarantee"],
        verificationToBuildFirst: ["verification"],
        requiredChecks: ["`make verify-cli`"],
        documentationUpdates: [],
        blockedReason: null,
      },
      "/workspace/workdir",
    );

    expect(commands).toEqual([
      "cd /workspace/workdir/src/fabrik-cli",
      "go build -o /tmp/fabrik-verify .",
      "cd /workspace/workdir",
      "make verify-cli",
    ]);
  }
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
  expect(ids).toContain("runs-inspection:review-context");
  expect(ids).not.toContain("runs-inspection:implement");
});

test("todo-driver ignores stale planned validate phase after validation passes", () => {
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
          activeItemId: "runs-inspection",
          activePhase: "validate",
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
          iteration: 1,
          allPassed: true,
          commands: [],
          evidence: ["all good"],
          failingSummary: null,
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:review-context");
  expect(ids).toContain("runs-inspection:review:spec-alignment");
  expect(ids).not.toContain("runs-inspection:validate");
});

test("todo-driver review prompt uses diff summary instead of embedding the full patch", () => {
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
          changes: ["src/fabrik-cli/cmd/runs.go"],
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
          evidence: ["unit tests passed"],
          failingSummary: null,
        },
      ],
      reviewContext: [
        {
          nodeId: "runs-inspection:review-context",
          iteration: 0,
          changedFiles: ["src/fabrik-cli/cmd/runs.go"],
          diffSummary: ["M src/fabrik-cli/cmd/runs.go"],
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const built = workflow.build(ctx);
  const reviewNode = findTaskNode(built, "runs-inspection:review:verification");
  expect(reviewNode).not.toBeNull();
  expect(typeof reviewNode?.props?.children).toBe("string");
  expect(reviewNode?.props?.children).toContain("Relevant JJ diff summary");
  expect(reviewNode?.props?.children).not.toContain("Relevant JJ patch");
  expect(reviewNode?.props?.children).toContain("jj diff --summary -r @-");
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
  expect(ids).not.toContain("runs-inspection:implement");
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
  expect(ids).not.toContain("runs-inspection:implement");
  expect(ids).not.toContain("runs-inspection:review:spec-alignment");
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

test("todo-driver ignores bogus missing-context review complaints when review context exists", () => {
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
          iteration: 1,
          summary: "implemented",
          changes: ["src/fabrik-cli/cmd/runs.go"],
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
          evidence: ["Verifier logs: ok\tfabrik-cli/cmd"],
          failingSummary: null,
        },
      ],
      reviewContext: [
        {
          nodeId: "runs-inspection:review-context",
          iteration: 1,
          changedFiles: ["src/fabrik-cli/cmd/runs.go"],
          diffSummary: ["M src/fabrik-cli/cmd/runs.go"],
        },
      ],
      review: [
        {
          nodeId: "runs-inspection:review:spec-alignment",
          iteration: 1,
          reviewer: "Spec Alignment",
          approved: false,
          issues: [
            "Review context missing - todo item, JJ diff, and validation evidence not found in the current prompt",
          ],
          requiredFollowUps: ["Re-submit review request with explicit context"],
        },
        {
          nodeId: "runs-inspection:review:maintainability",
          iteration: 1,
          reviewer: "Maintainability",
          approved: false,
          issues: [
            "Review context missing: No todo item, changed files, JJ diff, or validation evidence provided in the prompt to perform the review.",
          ],
          requiredFollowUps: ["Provide the explicit implementation change for review."],
        },
        {
          nodeId: "runs-inspection:review:verification",
          iteration: 1,
          reviewer: "Verification",
          approved: false,
          issues: [
            "Review context missing: todo item, changed files, JJ diff, and validation evidence are not present in the current prompt",
          ],
          requiredFollowUps: ["Resubmit review request with complete context"],
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("runs-inspection:mark-todo-done");
  expect(ids).not.toContain("runs-inspection:review-fix");
});

test("todo-driver ignores broader missing-context review complaints when validation and review context exist", () => {
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
              id: "env-promotion-protected-environments",
              title: "Env Promotion / Protected Environments",
              status: "pending",
              task: "Support preview and confirmation for env promotion.",
              specTieIn: ["orchestrator env management"],
              guarantees: ["promotion flow is explicit and reviewable"],
              verificationToBuildFirst: ["deterministic checks"],
              requiredChecks: ["`make verify-cli`"],
              documentationUpdates: [],
              blockedReason: null,
            },
          ],
        },
      ],
      implement: [
        {
          nodeId: "env-promotion-protected-environments:implement",
          iteration: 2,
          summary: "implemented",
          changes: [],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "env-promotion-protected-environments:validate",
          iteration: 2,
          allPassed: true,
          commands: [],
          evidence: ["Verifier logs: ok"],
          failingSummary: null,
        },
      ],
      reviewContext: [
        {
          nodeId: "env-promotion-protected-environments:review-context",
          iteration: 2,
          changedFiles: [],
          diffSummary: ["M src/fabrik-cli/internal/run/env.go"],
        },
      ],
      review: [
        {
          nodeId: "env-promotion-protected-environments:review:spec-alignment",
          iteration: 2,
          reviewer: "Spec Alignment",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "env-promotion-protected-environments:review:maintainability",
          iteration: 2,
          reviewer: "Maintainability",
          approved: false,
          issues: [
            "No todo item or review content was provided in the prompt for evaluation.",
            "Cannot approve or reject changes without explicit implementation change and validation evidence.",
          ],
          requiredFollowUps: ["Provide the todo item and validation evidence."],
        },
        {
          nodeId: "env-promotion-protected-environments:review:verification",
          iteration: 2,
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
  expect(ids).toContain("env-promotion-protected-environments:mark-todo-done");
  expect(ids).not.toContain("env-promotion-protected-environments:review-fix");
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

test("todo-driver keeps the active item mounted through finalize even after todo.md marks it done", () => {
  const verificationMap = {
    id: "verification-map",
    title: "Verification Map",
    status: "done",
    task: "Document the verification map.",
    specTieIn: ["orchestrator verification"],
    guarantees: ["verification guidance is documented"],
    verificationToBuildFirst: ["doc checks"],
    requiredChecks: ["`make verify-cli`"],
    documentationUpdates: [],
    blockedReason: null,
  } as const;
  const envPromotion = {
    id: "env-promotion-protected-environments",
    title: "Env Promotion / Protected Environments",
    status: "pending",
    task: "Harden env promotion.",
    specTieIn: ["environment protections"],
    guarantees: ["promotion respects protection rules"],
    verificationToBuildFirst: ["deterministic checks"],
    requiredChecks: ["`make verify-cli`"],
    documentationUpdates: [],
    blockedReason: null,
  } as const;

  const ctx = buildContext({
    runId: "preview",
    iteration: 9,
    iterations: {},
    input: {},
    outputs: {
      todoPlan: [
        {
          nodeId: "plan-todo-loop",
          iteration: 8,
          todoPath: "todo.md",
          totalItems: 10,
          selectedItems: 2,
          activeItemId: "verification-map",
          activePhase: "finalize",
          items: [verificationMap, envPromotion],
        },
      ],
      implement: [
        {
          nodeId: "verification-map:implement",
          iteration: 8,
          summary: "implemented",
          changes: [],
          verification: [],
          documentation: [],
        },
      ],
      validate: [
        {
          nodeId: "verification-map:validate",
          iteration: 8,
          allPassed: true,
          commands: [],
          evidence: [],
          failingSummary: null,
        },
      ],
      review: [
        {
          nodeId: "verification-map:review:spec-alignment",
          iteration: 8,
          reviewer: "Spec Alignment",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "verification-map:review:maintainability",
          iteration: 8,
          reviewer: "Maintainability",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
        {
          nodeId: "verification-map:review:verification",
          iteration: 8,
          reviewer: "Verification",
          approved: true,
          issues: [],
          requiredFollowUps: [],
        },
      ],
      report: [
        {
          nodeId: "verification-map:mark-todo-done",
          iteration: 8,
          ticketId: "verification-map",
          status: "done",
          summary: "Marked done",
        },
      ],
    },
    zodToKeyName: workflow.zodToKeyName,
  });

  const ids = collectTaskIDs(workflow.build(ctx));
  expect(ids).toContain("verification-map:snapshot-complete");
  expect(ids).not.toContain("env-promotion-protected-environments:implement");
});
