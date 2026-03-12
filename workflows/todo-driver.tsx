import {
  Branch,
  Parallel,
  PiAgent,
  Ralph,
  Sequence,
  Task,
  Workflow,
  createSmithers,
} from "smithers-orchestrator";
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { runVerificationJob } from "./utils/k8s-jobs";
import { pushBookmark, snapshotChange } from "./utils/jj-shell";
import { parseTodoItems, todoItemSchema, type TodoItem } from "./utils/todo-plan";
import { markTodoItemDone } from "./utils/todo-status";

const WORKDIR_ROOT = process.cwd();
const CONTROL_ROOT = "/workspace/.fabrik";
const REPO_ROOT = WORKDIR_ROOT;
const TODO_PATH = resolve(REPO_ROOT, "todo.md");
const DB_DIR = resolve(REPO_ROOT, ".smithers");
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = resolve(DB_DIR, "todo-driver.db");
const jjRepo = process.env.SMITHERS_JJ_REPO?.trim() ?? "";
const jjBookmark = process.env.SMITHERS_JJ_BOOKMARK?.trim() ?? "";

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? "80");
const MAX_REVIEW_ROUNDS = Number(process.env.MAX_REVIEW_ROUNDS ?? "8");
const MAX_TODO_ITEMS = Number(process.env.MAX_TODO_ITEMS ?? "1");
const TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 60 * 60 * 1000;
const FEATURE_BOOKMARK = jjBookmark || "feat/todo-driver";
const PI_PROVIDER = "fireworks";
const PI_MODEL = "accounts/fireworks/models/kimi-k2p5";
const PI_ENV = {
  XDG_CACHE_HOME: "/tmp/pi-cache",
  XDG_STATE_HOME: "/tmp/pi-state",
  XDG_CONFIG_HOME: "/tmp/pi-config",
  PI_CODING_AGENT_DIR: "/tmp/pi-agent",
};
const VERIFY_SPEC_PATH = "specs/051-k3s-orchestrator.md";

const todoPlanSchema = z.object({
  todoPath: z.string(),
  totalItems: z.number().int().nonnegative(),
  selectedItems: z.number().int().nonnegative(),
  items: z.array(todoItemSchema),
});

const implementSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  verification: z.array(z.string()),
  documentation: z.array(z.string()),
});

const validateSchema = z.object({
  allPassed: z.boolean(),
  commands: z.array(z.string()),
  evidence: z.array(z.string()),
  failingSummary: z.string().nullable(),
});

const reviewSchema = z.object({
  reviewer: z.string(),
  approved: z.boolean(),
  issues: z.array(z.string()),
  requiredFollowUps: z.array(z.string()),
});

const reviewFixSchema = z.object({
  summary: z.string(),
  fixesMade: z.array(z.string()),
  unresolvedIssues: z.array(z.string()),
});

const reportSchema = z.object({
  ticketId: z.string(),
  status: z.enum(["done", "partial", "blocked"]),
  summary: z.string(),
});

const { smithers, outputs } = createSmithers(
  {
    todoPlan: todoPlanSchema,
    implement: implementSchema,
    validate: validateSchema,
    review: reviewSchema,
    reviewFix: reviewFixSchema,
    report: reportSchema,
  },
  { dbPath: DB_PATH },
);

type Review = z.infer<typeof reviewSchema>;
type ReviewFix = z.infer<typeof reviewFixSchema>;
type Validate = z.infer<typeof validateSchema>;
type WorkflowCtx = Parameters<Parameters<typeof smithers>[0]>[0];

type Reviewer = {
  id: string;
  title: string;
  prompt: string;
};

type OutputTableKey = keyof WorkflowCtx["outputs"];

type OutputRowWithNodeId = {
  nodeId?: unknown;
  iteration?: unknown;
};

const REVIEWERS: Reviewer[] = [
  {
    id: "spec-alignment",
    title: "Spec Alignment",
    prompt:
      "Reject if the change fails the task guarantees, skips a higher-priority todo obligation, or drifts from the referenced specs.",
  },
  {
    id: "maintainability",
    title: "Maintainability",
    prompt:
      "Reject if the change adds avoidable complexity, weak boundaries, or code that will be expensive to maintain.",
  },
  {
    id: "verification",
    title: "Verification",
    prompt:
      "Reject if required verification is missing, weakened, ambiguous, or not supported by concrete evidence from the run.",
  },
];

const SYSTEM_PROMPT = [
  "You are the Fabrik todo execution agent working inside a cloned Git/JJ repository.",
  "Todo work is verification-first: build or update the required checks before claiming the feature is complete.",
  "Do not run jj or git commands. Deterministic repository state transitions are handled by the workflow helpers.",
  "Keep changes aligned to repo instructions, specs, and maintainable boundaries.",
].join("\n");

function piReadAt(workdir: string): PiAgent {
  return new PiAgent({
    provider: PI_PROVIDER,
    model: PI_MODEL,
    mode: "json",
    noTools: false,
    tools: ["read", "bash"],
    noSession: true,
    systemPrompt: SYSTEM_PROMPT,
    cwd: workdir,
    env: PI_ENV,
  });
}

function piWriteAt(workdir: string): PiAgent {
  return new PiAgent({
    provider: PI_PROVIDER,
    model: PI_MODEL,
    mode: "json",
    noTools: false,
    tools: ["read", "edit", "write", "bash"],
    noSession: true,
    systemPrompt: SYSTEM_PROMPT,
    cwd: workdir,
    env: PI_ENV,
  });
}

function itemWorkspace(itemId: string): string {
  void itemId;
  return REPO_ROOT;
}

export function repoResetCommand(rootDir: string): string {
  return `find ${rootDir} -mindepth 1 -maxdepth 1 ! -name .smithers -exec rm -rf -- {} +`;
}

function sanitizeK8sName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment setting ${name}.`);
  }
  return value;
}

function verifierBuildCommands(workdir: string): string[] {
  return [
    `cd ${workdir}/src/fabrik-cli`,
    "go build -o /tmp/fabrik-verify .",
  ];
}

export function verifierCommands(item: TodoItem, workdir: string): string[] {
  const base = verifierBuildCommands(workdir);

  if (item.id === "runs-inspection") {
    return [
      ...base,
      "go test ./cmd ./internal/runs",
      "VERIFY_RUN_ID=fabrik-verify-runs-$(date +%s)",
      `/tmp/fabrik-verify run --run-id "$VERIFY_RUN_ID" --spec ${VERIFY_SPEC_PATH} --project verify --image "$FABRIK_RUN_IMAGE" --namespace "$KUBERNETES_NAMESPACE" --pvc-size 1Gi --job-command 'echo cluster-verify' --interactive=false`,
      "kubectl -n \"$KUBERNETES_NAMESPACE\" wait --for=condition=complete \"job/fabrik-$VERIFY_RUN_ID\" --timeout=180s",
      "/tmp/fabrik-verify runs list --namespace \"$KUBERNETES_NAMESPACE\"",
      "/tmp/fabrik-verify runs show --run-id \"$VERIFY_RUN_ID\" --namespace \"$KUBERNETES_NAMESPACE\"",
      "/tmp/fabrik-verify run logs --run-id \"$VERIFY_RUN_ID\" --namespace \"$KUBERNETES_NAMESPACE\"",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" delete job \"fabrik-$VERIFY_RUN_ID\" --ignore-not-found",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" delete pvc \"data-fabrik-$VERIFY_RUN_ID\" --ignore-not-found",
    ];
  }

  if (item.id === "resume") {
    return [
      ...base,
      "VERIFY_RUN_ID=fabrik-verify-resume-$(date +%s)",
      `/tmp/fabrik-verify run --run-id "$VERIFY_RUN_ID" --spec ${VERIFY_SPEC_PATH} --project verify --image "$FABRIK_RUN_IMAGE" --namespace "$KUBERNETES_NAMESPACE" --pvc-size 1Gi --job-command 'sleep 300' --interactive=false`,
      "kubectl -n \"$KUBERNETES_NAMESPACE\" wait --for=jsonpath='{.status.phase}'=Running pod -l fabrik.sh/run-id=\"$VERIFY_RUN_ID\" --timeout=180s",
      "POD_NAME=$(kubectl -n \"$KUBERNETES_NAMESPACE\" get pods -l fabrik.sh/run-id=\"$VERIFY_RUN_ID\" -o jsonpath='{.items[0].metadata.name}')",
      "test -n \"$POD_NAME\"",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" delete pod \"$POD_NAME\" --grace-period=0 --force --ignore-not-found",
      "/tmp/fabrik-verify run resume --id \"$VERIFY_RUN_ID\" --namespace \"$KUBERNETES_NAMESPACE\"",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" wait --for=jsonpath='{.status.phase}'=Running pod -l fabrik.sh/run-id=\"$VERIFY_RUN_ID\" --timeout=180s",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" delete job \"fabrik-$VERIFY_RUN_ID\" --ignore-not-found",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" delete pvc \"data-fabrik-$VERIFY_RUN_ID\" --ignore-not-found",
    ];
  }

  if (item.id === "cancel") {
    return [
      ...base,
      "VERIFY_RUN_ID=fabrik-verify-cancel-$(date +%s)",
      `/tmp/fabrik-verify run --run-id "$VERIFY_RUN_ID" --spec ${VERIFY_SPEC_PATH} --project verify --image "$FABRIK_RUN_IMAGE" --namespace "$KUBERNETES_NAMESPACE" --pvc-size 1Gi --job-command 'sleep 300' --interactive=false`,
      "kubectl -n \"$KUBERNETES_NAMESPACE\" wait --for=jsonpath='{.status.phase}'=Running pod -l fabrik.sh/run-id=\"$VERIFY_RUN_ID\" --timeout=180s",
      "/tmp/fabrik-verify run cancel --id \"$VERIFY_RUN_ID\" --namespace \"$KUBERNETES_NAMESPACE\"",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" wait --for=delete \"job/fabrik-$VERIFY_RUN_ID\" --timeout=180s",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" delete pvc \"data-fabrik-$VERIFY_RUN_ID\" --ignore-not-found",
    ];
  }

  if (item.id === "verification-map") {
    return [
      ...base,
      `cd ${workdir}`,
      "rg -n \"## Verification Ladder|## Definition Of Done Template|## Priority Order\" todo.md",
      "rg -n \"Workflow Validation In Clusters\" src/fabrik-cli/docs/getting-started.md",
      "rg -n \"same-cluster verifier Jobs\" workflows/README.md",
    ];
  }

  throw new Error(
    `No deterministic same-cluster verifier is wired for todo item ${item.id}. Add one before dispatching this task to a cluster that does not provide nested k3d.`,
  );
}

async function runTodoValidation(item: TodoItem): Promise<Validate> {
  const workdir = itemWorkspace(item.id);
  const namespace = requiredSetting("KUBERNETES_NAMESPACE");
  const nodeName = requiredSetting("KUBERNETES_NODE_NAME");
  const image = requiredSetting("FABRIK_RUN_IMAGE");
  const pvcName = requiredSetting("FABRIK_WORKSPACE_PVC");
  const runID = requiredSetting("SMITHERS_RUN_ID");
  const serviceAccountName = sanitizeK8sName(`fabrik-runner-${runID}`);
  const commands = verifierCommands(item, workdir);
  const jobName = sanitizeK8sName(`${runID}-${item.id}-verify`);

  const verification = await runVerificationJob({
    name: jobName,
    image,
    namespace,
    serviceAccountName,
    pvcName,
    nodeName,
    workspacePath: workdir,
    commands,
    labels: {
      "fabrik.sh/run-id": runID,
      "fabrik.sh/verify-target": item.id,
    },
  });

  const evidence = [
    `Verification job: ${verification.jobName}`,
    `Verification pod: ${verification.podName || "pending"}`,
    verification.summary,
  ];
  if (verification.logs.trim() !== "") {
    evidence.push(`Verifier logs:\n${verification.logs.trim()}`);
  }

  return {
    allPassed: verification.passed,
    commands,
    evidence,
    failingSummary: verification.passed ? null : verification.summary,
  };
}

function latestPlannedItems(ctx: WorkflowCtx): TodoItem[] {
  const planRows = (ctx.outputs as { todoPlan?: unknown[] }).todoPlan ?? [];
  const plan = planRows.length > 0 ? planRows[planRows.length - 1] : null;
  if (!plan || typeof plan !== "object") return [];
  const row = plan as { items?: unknown };
  if (!Array.isArray(row.items)) return [];

  const items: TodoItem[] = [];
  for (const item of row.items) {
    const parsed = todoItemSchema.safeParse(item);
    if (parsed.success && parsed.data.status !== "done") items.push(parsed.data);
  }
  return items;
}

function currentTodoItemsFromFile(): TodoItem[] {
  if (!existsSync(TODO_PATH)) return [];
  const parsedItems = parseTodoItems(TODO_PATH);
  const pendingItems = parsedItems.filter((item) => item.status !== "done");
  return MAX_TODO_ITEMS > 0 ? pendingItems.slice(0, MAX_TODO_ITEMS) : pendingItems;
}

function latestFinishingItem(ctx: WorkflowCtx): TodoItem | null {
  for (const item of latestPlannedItems(ctx)) {
    if (!latestReportDone(ctx, `${item.id}:complete-report`)) return item;
  }
  return null;
}

function currentTodoItem(ctx: WorkflowCtx): TodoItem | null {
  return currentTodoItemsFromFile()[0] ?? latestFinishingItem(ctx);
}

function todoLoopComplete(ctx: WorkflowCtx): boolean {
  if (!existsSync(TODO_PATH)) return false;
  return currentTodoItem(ctx) === null;
}

function latestOutputRow<T>(
  ctx: WorkflowCtx,
  table: OutputTableKey,
  nodeId: string,
): (T & { iteration?: number }) | undefined {
  const rows = (ctx.outputs[table] as unknown[] | undefined) ?? [];
  let latest: (T & { iteration?: number }) | undefined;
  let latestIteration = -1;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as OutputRowWithNodeId & T;
    if (record.nodeId !== nodeId) continue;
    const iteration =
      typeof record.iteration === "number" ? record.iteration : -1;
    if (iteration >= latestIteration) {
      latest = record as T & { iteration?: number };
      latestIteration = iteration;
    }
  }

  return latest;
}

function latestOutputIteration(
  ctx: WorkflowCtx,
  table: OutputTableKey,
  nodeId: string,
): number | null {
  return latestOutputRow(ctx, table, nodeId)?.iteration ?? null;
}

function collectReviewIssues(
  ctx: WorkflowCtx,
  itemId: string,
  reviewers: Reviewer[],
  minimumIteration: number | null = null,
): string[] {
  const issues: string[] = [];
  for (const reviewer of reviewers) {
    const review = latestOutputRow<Review>(
      ctx,
      "review",
      `${itemId}:review:${reviewer.id}`,
    );
    if (
      minimumIteration !== null &&
      (review?.iteration ?? -1) < minimumIteration
    ) {
      continue;
    }
    if (review?.issues?.length) issues.push(...review.issues);
  }
  return issues;
}

function allReviewersApproved(
  ctx: WorkflowCtx,
  itemId: string,
  reviewers: Reviewer[],
  minimumIteration: number | null = null,
): boolean {
  return reviewers.every((reviewer) => {
    const review = latestOutputRow<Review>(
      ctx,
      "review",
      `${itemId}:review:${reviewer.id}`,
    );
    if (
      minimumIteration !== null &&
      (review?.iteration ?? -1) < minimumIteration
    ) {
      return false;
    }
    return review?.approved === true;
  });
}

function latestValidationPassed(ctx: WorkflowCtx, itemId: string): boolean {
  return latestValidation(ctx, itemId)?.allPassed === true;
}

function latestValidation(ctx: WorkflowCtx, itemId: string): Validate | undefined {
  return latestOutputRow<Validate>(ctx, "validate", `${itemId}:validate`);
}

function latestReviewFix(ctx: WorkflowCtx, itemId: string): ReviewFix | undefined {
  return latestOutputRow<ReviewFix>(ctx, "reviewFix", `${itemId}:review-fix`);
}

function latestReportDone(ctx: WorkflowCtx, taskId: string): boolean {
  const report = ctx.latest("report", taskId) as
    | z.infer<typeof reportSchema>
    | undefined;
  return report?.status === "done";
}

function hasImplementation(ctx: WorkflowCtx, itemId: string): boolean {
  return Boolean(ctx.latest("implement", `${itemId}:implement`));
}

function ReviewGroup({
  item,
  ctx,
}: {
  item: TodoItem;
  ctx: WorkflowCtx;
}) {
  const workdir = itemWorkspace(item.id);
  const latestImplement = latestOutputRow<z.infer<typeof implementSchema>>(
    ctx,
    "implement",
    `${item.id}:implement`,
  );
  const latestValidate = latestValidation(ctx, item.id);

  if (!latestValidate?.allPassed) return null;

  return Parallel({
    children: REVIEWERS.map((reviewer) =>
      Task({
        key: `${item.id}:review:${reviewer.id}`,
        id: `${item.id}:review:${reviewer.id}`,
        output: outputs.review,
        agent: piReadAt(itemWorkspace(item.id)),
        timeoutMs: REVIEW_TIMEOUT_MS,
        retries: 1,
        continueOnFail: true,
        children: `Reviewer: ${reviewer.title}

Use this reviewer rubric:
${reviewer.prompt}

Todo item:
${item.title}

Task:
${item.task}

Spec tie-in:
${item.specTieIn.map((entry) => `- ${entry}`).join("\n")}

Guarantees:
${item.guarantees.map((entry) => `- ${entry}`).join("\n")}

Verification that must exist:
${item.verificationToBuildFirst.map((entry) => `- ${entry}`).join("\n")}

Required checks:
${item.requiredChecks.map((entry) => `- ${entry}`).join("\n")}

Latest implementation summary:
${latestImplement?.summary ?? "- none"}

Latest changed files:
${latestImplement?.changes?.length ? latestImplement.changes.map((entry) => `- ${entry}`).join("\n") : "- none"}

Latest validation evidence:
${latestValidate.evidence.length > 0 ? latestValidate.evidence.map((entry) => `- ${entry}`).join("\n") : "- validation passed without extra evidence"}

Review the repository state at ${workdir}.
Do not claim missing context. Use the repository files, implementation summary, and validation evidence above as the complete review context.
Only report issues you can defend from the repository state or validation evidence.
If the change is acceptable, set approved=true and issues=[].

Return ONLY a JSON object with these fields:
- reviewer: string
- approved: boolean
- issues: string[]
- requiredFollowUps: string[]`,
      }),
    ),
  });
}

function ReviewFixStep({
  item,
  ctx,
}: {
  item: TodoItem;
  ctx: WorkflowCtx;
}) {
  const latestValidate = latestValidation(ctx, item.id);
  const latestValidationIteration = latestOutputIteration(
    ctx,
    "validate",
    `${item.id}:validate`,
  );
  const latestImplement = latestOutputRow<z.infer<typeof implementSchema>>(
    ctx,
    "implement",
    `${item.id}:implement`,
  );
  const issues = collectReviewIssues(
    ctx,
    item.id,
    REVIEWERS,
    latestValidationIteration,
  );
  const allApproved = allReviewersApproved(
    ctx,
    item.id,
    REVIEWERS,
    latestValidationIteration,
  );

  return Task({
    id: `${item.id}:review-fix`,
    output: outputs.reviewFix,
    agent: piWriteAt(itemWorkspace(item.id)),
    timeoutMs: TASK_TIMEOUT_MS,
    retries: 1,
    skipIf: !latestValidate?.allPassed || allApproved || issues.length === 0,
    children: `Address the reviewer feedback for this todo item:
${itemWorkspace(item.id)}

Todo item:
${item.title}

Current implementation summary:
${latestImplement?.summary ?? "- none"}

Current changed files:
${latestImplement?.changes?.length ? latestImplement.changes.map((entry) => `- ${entry}`).join("\n") : "- none"}

Validation evidence:
${latestValidate?.evidence?.length ? latestValidate.evidence.map((entry) => `- ${entry}`).join("\n") : "- none"}

Reviewer issues to fix:
${issues.map((entry) => `- ${entry}`).join("\n")}

Rules:
- Fix the repository directly.
- Do not ask for more context.
- Do not run jj or git commands.
- If an issue is invalid, make the repository state and verification evidence clearer instead of arguing.

Return ONLY a JSON object with these fields:
- summary: string
- fixesMade: string[]
- unresolvedIssues: string[]`,
  });
}

function itemLoopApproved(ctx: WorkflowCtx, itemId: string): boolean {
  const latestValidationIteration = latestOutputIteration(
    ctx,
    "validate",
    `${itemId}:validate`,
  );
  return latestValidationPassed(ctx, itemId) &&
    allReviewersApproved(ctx, itemId, REVIEWERS, latestValidationIteration);
}

function TodoItemPipeline({
  item,
  ctx,
}: {
  item: TodoItem;
  ctx: WorkflowCtx;
}) {
  const workdir = itemWorkspace(item.id);
  const latestImplement = latestOutputRow<z.infer<typeof implementSchema>>(
    ctx,
    "implement",
    `${item.id}:implement`,
  );
  const latestValidate = latestValidation(ctx, item.id);
  const latestFix = latestReviewFix(ctx, item.id);
  const issues = collectReviewIssues(ctx, item.id, REVIEWERS);
  const approved = itemLoopApproved(ctx, item.id);
  const todoMarkedDone = latestReportDone(ctx, `${item.id}:mark-todo-done`);
  const completionSnapshotted = latestReportDone(
    ctx,
    `${item.id}:snapshot-complete`,
  );
  const bookmarkPushed =
    !jjBookmark || latestReportDone(ctx, `${item.id}:push-bookmark`);
  const completionReported = latestReportDone(
    ctx,
    `${item.id}:complete-report`,
  );
  const blocked = item.blockedReason !== null;
  const readyToFinalize = !blocked && approved;
  const needsMarkTodoDone = readyToFinalize && !todoMarkedDone;
  const needsCompletionSnapshot =
    readyToFinalize && todoMarkedDone && !completionSnapshotted;
  const needsBookmarkPush =
    readyToFinalize &&
    todoMarkedDone &&
    completionSnapshotted &&
    !bookmarkPushed;
  const needsCompletionReport =
    readyToFinalize &&
    todoMarkedDone &&
    completionSnapshotted &&
    bookmarkPushed &&
    !completionReported;

  return Sequence({
    key: item.id,
    children: [
      Branch({
        if: blocked,
        then: Task({
          id: `${item.id}:blocked-report`,
          output: outputs.report,
          children: {
            ticketId: item.id,
            status: "blocked",
            summary: item.blockedReason ?? `Todo item ${item.id} is blocked.`,
          },
        }),
      }),

      Branch({
        if: !blocked && !readyToFinalize,
        then: Sequence({
          children: [
            Ralph({
              id: `${item.id}:implement-review-loop`,
              until: itemLoopApproved(ctx, item.id),
              maxIterations: MAX_REVIEW_ROUNDS,
              onMaxReached: "return-last",
              children: Sequence({
                children: [
                  Task({
                    id: `${item.id}:implement`,
                    output: outputs.implement,
                    agent: piWriteAt(workdir),
                    timeoutMs: TASK_TIMEOUT_MS,
                    retries: 1,
                    children: `Implement the next todo item in this repository:
${workdir}

Todo item:
${item.title}

Task:
${item.task}

Spec tie-in:
${item.specTieIn.map((entry) => `- ${entry}`).join("\n")}

Guarantees:
${item.guarantees.map((entry) => `- ${entry}`).join("\n")}

Verification to build first:
${item.verificationToBuildFirst.map((entry) => `- ${entry}`).join("\n")}

Required checks:
${item.requiredChecks.map((entry) => `- ${entry}`).join("\n")}

Documentation updates:
${item.documentationUpdates.length > 0 ? item.documentationUpdates.map((entry) => `- ${entry}`).join("\n") : "- none"}

Reviewer feedback from the previous loop:
${issues.length > 0 ? issues.map((entry) => `- ${entry}`).join("\n") : "- none"}

Latest validation result:
${latestValidate
  ? latestValidate.allPassed
    ? "- last validation passed"
    : [
        latestValidate.failingSummary
          ? `- failure: ${latestValidate.failingSummary}`
          : "- failure: validation did not pass",
        ...latestValidate.evidence.map((entry) => `- ${entry}`),
      ].join("\n")
  : "- validation has not run yet"}

Latest implementation summary:
${latestImplement?.summary ?? "- none"}

Latest review-fix summary:
${latestFix?.summary ?? "- none"}

Rules:
- Build or update the required verification before claiming completion.
- Do not run jj or git commands.
- Work only on this todo item.
- Make the smallest maintainable change that satisfies the guarantees.
- Update docs and code comments only where the todo item requires them.
- If a guarantee cannot be completed safely in this run, say so clearly in the JSON output.
- Do not spend a loop only restating the schema or apologizing.
- Use the latest validation failure to decide the next code change.
- Make real repository changes before returning unless the task is genuinely blocked.
- If you return an empty changes array, the summary must explain the concrete blocker preventing further edits.

Return ONLY JSON matching the schema.`,
                  }),

                  Task({
                    id: `${item.id}:snapshot-implement`,
                    output: outputs.report,
                    timeoutMs: 60_000,
                    children: () => snapshotChange(workdir, item.id, "implement"),
                  }),

                  Task({
                    id: `${item.id}:validate`,
                    output: outputs.validate,
                    timeoutMs: TASK_TIMEOUT_MS,
                    retries: 1,
                    children: () => runTodoValidation(item),
                  }),

                  ReviewGroup({ item, ctx }),
                  ReviewFixStep({ item, ctx }),
                ],
              }),
            }),
          ],
        }),
      }),

      Branch({
        if: needsMarkTodoDone,
        then: Sequence({
          children: [
            Task({
              id: `${item.id}:mark-todo-done`,
              output: outputs.report,
              timeoutMs: 60_000,
              children: () => {
              const validate = latestValidation(ctx, item.id);
              markTodoItemDone(resolve(workdir, "todo.md"), item.id, {
                runID: process.env.SMITHERS_RUN_ID?.trim() ?? "",
                verificationSummary:
                  validate?.evidence?.[2] ??
                  `In-cluster verification passed for ${item.id}.`,
              });
              return {
                ticketId: item.id,
                status: "done",
                summary: `Marked ${item.id} as done in todo.md after validation.`,
              };
              },
            }),
          ],
        }),
      }),

      Branch({
        if: needsCompletionSnapshot,
        then: Sequence({
          children: [
            Task({
              id: `${item.id}:snapshot-complete`,
              output: outputs.report,
              timeoutMs: 60_000,
              children: () => snapshotChange(workdir, item.id, "complete"),
            }),
          ],
        }),
      }),

      Branch({
        if: needsBookmarkPush,
        then: Sequence({
          children: [
            Task({
              id: `${item.id}:push-bookmark`,
              output: outputs.report,
              timeoutMs: TASK_TIMEOUT_MS,
              skipIf: !jjBookmark,
              children: () => pushBookmark(workdir, FEATURE_BOOKMARK, item.id),
            }),
          ],
        }),
      }),

      Branch({
        if: needsCompletionReport,
        then: Sequence({
          children: [
            Task({
              id: `${item.id}:complete-report`,
              output: outputs.report,
              children: {
                ticketId: item.id,
                status: "done",
                summary: `Completed ${item.id} with required verification, reviewer approval, and todo.md updated.`,
              },
            }),
          ],
        }),
      }),
    ],
  });
}

export default smithers((ctx) => {
  const currentItem = currentTodoItem(ctx);

  return Workflow({
    name: "todo-driver",
    cache: true,
    children: Sequence({
      children: [
        Task({
          id: "prepare-repo",
          output: outputs.report,
          children: async () => {
            const gitDir = resolve(REPO_ROOT, ".git");
            const jjDir = resolve(REPO_ROOT, ".jj");
            if (existsSync(gitDir) || existsSync(jjDir)) {
              return {
                ticketId: "prepare-repo",
                status: "done",
                summary: `Using existing repo at ${REPO_ROOT}`,
              };
            }
            if (!jjRepo) {
              throw new Error(
                "Missing SMITHERS_JJ_REPO. Dispatch this workflow with `fabrik run --jj-repo <repo-url>` so the target repository is cloned into /workspace/workdir.",
              );
            }
            if (!process.env.FIREWORKS_API_KEY?.trim()) {
              throw new Error(
                "Missing FIREWORKS_API_KEY. Sync the workflow's model credential through `--env-file` before dispatch.",
              );
            }
            const tempCloneRoot = resolve(CONTROL_ROOT, "tmp");
            const tempClone = resolve(tempCloneRoot, `repo-${Date.now()}`);
            await $`mkdir -p ${tempCloneRoot}`;
            if (jjBookmark) {
              await $`jj git clone --branch ${jjBookmark} ${jjRepo} ${tempClone}`.cwd(CONTROL_ROOT);
            } else {
              await $`jj git clone ${jjRepo} ${tempClone}`.cwd(CONTROL_ROOT);
            }
            await $`sh -lc ${repoResetCommand(REPO_ROOT)}`.quiet().nothrow();
            await $`sh -lc 'cd "$1" && tar -cf - . | (cd "$2" && tar -xf -)' sh ${tempClone} ${REPO_ROOT}`;
            await $`rm -rf ${tempClone}`;
            return {
              ticketId: "prepare-repo",
              status: "done",
              summary: jjBookmark
                ? `Cloned ${jjRepo} into ${REPO_ROOT} and checked out ${jjBookmark}`
                : `Cloned ${jjRepo} into ${REPO_ROOT}`,
            };
          },
        }),

        Task({
          id: "ensure-todo",
          output: outputs.report,
          children: () => {
            if (!existsSync(TODO_PATH)) {
              throw new Error(
                `Missing todo.md in ${REPO_ROOT}. This workflow expects the cloned repo to contain a verification-first todo file at the repo root.`,
              );
            }
            return {
              ticketId: "ensure-todo",
              status: "done",
              summary: `Found todo.md at ${TODO_PATH}`,
            };
          },
        }),

        Ralph({
          id: "todo-loop",
          until: todoLoopComplete(ctx),
          maxIterations: MAX_ITERATIONS,
          onMaxReached: "fail",
          children: Sequence({
            children: [
              Task({
                id: "plan-todo-loop",
                output: outputs.todoPlan,
                children: () => {
                const parsedItems = parseTodoItems(TODO_PATH);
                const pendingItems = parsedItems.filter((item) => item.status !== "done");
                const limitedItems =
                  MAX_TODO_ITEMS > 0
                    ? pendingItems.slice(0, MAX_TODO_ITEMS)
                    : pendingItems;

                return {
                  todoPath: TODO_PATH,
                  totalItems: parsedItems.length,
                  selectedItems: limitedItems.length,
                  items: limitedItems,
                };
                },
              }),

              Branch({
                if: currentItem === null,
                then: Task({
                  id: "todo-loop-complete",
                  output: outputs.report,
                  children: {
                    ticketId: "todo-loop",
                    status: "done",
                    summary: "No pending todo items remain.",
                  },
                }),
                else: Sequence({
                  children: currentItem?.blockedReason
                    ? [
                        Task({
                          id: `${currentItem.id}:blocked`,
                          output: outputs.report,
                          children: {
                            ticketId: currentItem.id,
                            status: "blocked",
                            summary: currentItem.blockedReason,
                          },
                        }),
                      ]
                    : [currentItem ? TodoItemPipeline({ item: currentItem, ctx }) : null],
                }),
              }),
            ],
          }),
        }),
      ],
    }),
  });
});
