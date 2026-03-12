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
import React from "react";
import { z } from "zod";
import { runVerificationJob } from "./utils/k8s-jobs";
import { pushBookmark, snapshotChange } from "./utils/jj-shell";
import { parseTodoItems, todoItemSchema, type TodoItem } from "./utils/todo-plan";
import { markTodoItemDone } from "./utils/todo-status";

const WORKDIR_ROOT = process.cwd();
const CONTROL_ROOT = resolve(WORKDIR_ROOT, ".fabrik");
const REPO_ROOT = WORKDIR_ROOT;
const TODO_PATH = resolve(REPO_ROOT, "todo.md");
const DB_DIR = resolve(CONTROL_ROOT, "smithers");
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = resolve(DB_DIR, "todo-driver.db");
const jjRepo = process.env.SMITHERS_JJ_REPO?.trim() ?? "";
const jjBookmark = process.env.SMITHERS_JJ_BOOKMARK?.trim() ?? "";

const MAX_REVIEW_ROUNDS = Number(process.env.MAX_REVIEW_ROUNDS ?? "8");
const MAX_TODO_ITEMS = Number(process.env.MAX_TODO_ITEMS ?? "1");
const MAX_TODO_LOOP_ITERATIONS = Number(
  process.env.MAX_TODO_LOOP_ITERATIONS ?? "64",
);
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
const RUNTIME_ARTIFACT_PREFIXES = [
  ".smithers/",
  ".fabrik/",
  ".jj/",
  ".git/",
];

const todoPlanSchema = z.object({
  todoPath: z.string().default(TODO_PATH),
  totalItems: z.number().int().nonnegative().default(0),
  selectedItems: z.number().int().nonnegative().default(0),
  activeItemId: z.string().nullable().default(null),
  activePhase: z
    .enum(["implement", "validate", "review", "finalize", "done", "blocked"])
    .nullable()
    .default(null),
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

const reviewContextSchema = z.object({
  changedFiles: z.array(z.string()),
  diffSummary: z.array(z.string()),
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
    reviewContext: reviewContextSchema,
    report: reportSchema,
  },
  { dbPath: DB_PATH },
);

type Review = z.infer<typeof reviewSchema>;
type ReviewFix = z.infer<typeof reviewFixSchema>;
type ReviewContext = z.infer<typeof reviewContextSchema>;
type Validate = z.infer<typeof validateSchema>;
type WorkflowCtx = Parameters<Parameters<typeof smithers>[0]>[0];
type TodoPlanRow = z.infer<typeof todoPlanSchema>;
type TodoLoopPhase = NonNullable<TodoPlanRow["activePhase"]>;

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
  "You may use in-cluster Kubernetes inspection as supporting evidence during implementation, for example kubectl get/describe/logs against Jobs, Pods, PVCs, CronJobs, and related resources in the current namespace.",
  "You may also exercise the CLI itself against the cluster to confirm intended behavior, for example fabrik runs list, fabrik runs show, fabrik run logs, fabrik run resume, or fabrik run cancel against real cluster state when that helps implementation.",
  "Use those cluster checks to understand behavior and confirm your changes, but do not replace the deterministic validation contract with ad hoc cluster-only verifier steps.",
].join("\n");

const REVIEW_SYSTEM_PROMPT = [
  "You are the Fabrik review agent.",
  "Review only the explicit implementation change and validation evidence provided in the prompt.",
  "Do not ask for missing context when the prompt already includes the todo item, changed files, JJ diff, and validation evidence.",
  "Ignore transient runtime artifacts under .smithers, .fabrik, .jj, and .git.",
  "You may consider supporting Kubernetes evidence gathered from the live cluster, such as kubectl output, pod logs, Job state, and PVC state, when it is included in the review context.",
  "You may also consider evidence from exercising the CLI itself against the cluster, such as runs list/show/logs or resume/cancel behavior against real cluster resources.",
  "Use cluster evidence to support or question the change, but do not demand new brittle cluster-only gates beyond the deterministic validation contract unless the todo item explicitly requires them.",
  "Return only the requested JSON.",
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

function piReviewAt(workdir: string): PiAgent {
  return new PiAgent({
    provider: PI_PROVIDER,
    model: PI_MODEL,
    mode: "json",
    noTools: false,
    tools: ["read", "bash"],
    noSession: true,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    cwd: workdir,
    env: PI_ENV,
  });
}

function itemWorkspace(itemId: string): string {
  void itemId;
  return REPO_ROOT;
}

export function repoResetCommand(rootDir: string): string {
  return `find ${rootDir} -mindepth 1 -maxdepth 1 ! -name .smithers ! -name .fabrik -exec rm -rf -- {} +`;
}

export function isRuntimeArtifactPath(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^a\//, "")
    .replace(/^b\//, "")
    .replace(/^"+|"+$/g, "");
  return RUNTIME_ARTIFACT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function filterRelevantRepoPaths(paths: readonly string[]): string[] {
  const filtered: string[] = [];
  for (const path of paths) {
    const normalized = path.trim();
    if (!normalized || isRuntimeArtifactPath(normalized)) continue;
    if (!filtered.includes(normalized)) filtered.push(normalized);
  }
  return filtered;
}

function parseSummaryPath(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(?:[A-Z?]+\s+)(.+)$/);
  if (!match?.[1]) return null;
  return match[1].trim();
}

async function latestSnapshotDiffSummary(workdir: string): Promise<string[]> {
  const result = await $`jj diff --summary -r @-`.cwd(workdir).nothrow().quiet();
  if (result.exitCode !== 0) return [];
  const lines = result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.filter((line) => {
    const path = parseSummaryPath(line);
    return path ? !isRuntimeArtifactPath(path) : true;
  });
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
  const repoWideChecks = [
    ...base,
    `cd ${workdir}`,
    "make verify-cli",
  ];

  if (item.id === "runs-inspection") {
    return [
      ...base,
      "go test ./cmd -run 'Runs|Logs'",
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
      "(command -v rg >/dev/null 2>&1 && rg -n \"## Verification Ladder|## Definition Of Done Template|## Priority Order\" todo.md) || grep -En \"## Verification Ladder|## Definition Of Done Template|## Priority Order\" todo.md",
      "(command -v rg >/dev/null 2>&1 && rg -n \"Workflow Validation In Clusters\" src/fabrik-cli/docs/getting-started.md) || grep -En \"Workflow Validation In Clusters\" src/fabrik-cli/docs/getting-started.md",
      "(command -v rg >/dev/null 2>&1 && rg -n \"same-cluster verifier Jobs\" workflows/README.md) || grep -En \"same-cluster verifier Jobs\" workflows/README.md",
    ];
  }

  if (
    item.id === "env-promotion-protected-environments" ||
    item.id === "retention-cleanup" ||
    item.id === "security-hardening-alignment" ||
    item.id === "observability-loki" ||
    item.id === "rootserver-k3s-parity" ||
    item.id === "sample-contract"
  ) {
    return repoWideChecks;
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
  const row = latestTodoPlan(ctx);
  return row?.items ?? [];
}

function currentTodoItemsFromFile(): TodoItem[] {
  if (!existsSync(TODO_PATH)) return [];
  const parsedItems = parseTodoItems(TODO_PATH);
  const pendingItems = parsedItems.filter((item) => item.status !== "done");
  return MAX_TODO_ITEMS > 0 ? pendingItems.slice(0, MAX_TODO_ITEMS) : pendingItems;
}

function latestTodoPlan(ctx: WorkflowCtx): TodoPlanRow | null {
  const planRows = (ctx.outputs as { todoPlan?: unknown[] }).todoPlan ?? [];
  const row = planRows.length > 0 ? planRows[planRows.length - 1] : null;
  const parsed = todoPlanSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export function chooseCurrentTodoItem(
  plannedItems: readonly TodoItem[],
  activeItemId: string | null,
  fallbackFileItems: readonly TodoItem[],
): TodoItem | null {
  if (activeItemId) {
    return plannedItems.find((item) => item.id === activeItemId) ?? null;
  }
  return plannedItems[0] ?? fallbackFileItems[0] ?? null;
}

function currentTodoItem(ctx: WorkflowCtx): TodoItem | null {
  const latestPlan = latestTodoPlan(ctx);
  return chooseCurrentTodoItem(
    latestPlan?.items ?? [],
    latestPlan?.activeItemId ?? null,
    currentTodoItemsFromFile(),
  );
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

function isIgnorableContextComplaint(issue: string): boolean {
  const normalized = issue.toLowerCase();
  return (
    normalized.includes("missing context") ||
    normalized.includes("context missing") ||
    normalized.includes("context not provided") ||
    normalized.includes("context not visible") ||
    normalized.includes("review content not provided") ||
    normalized.includes("review material not provided") ||
    normalized.includes("no review content provided") ||
    normalized.includes("todo item, changed files, jj diff, and validation evidence are not present") ||
    normalized.includes("todo item, jj diff, and validation evidence not found") ||
    normalized.includes("cannot verify implementation changes without explicit diff and validation evidence")
  );
}

function reviewContextIsAvailable(
  ctx: WorkflowCtx,
  itemId: string,
  minimumIteration: number | null = null,
): boolean {
  const reviewContext = latestOutputRow<ReviewContext>(
    ctx,
    "reviewContext",
    `${itemId}:review-context`,
  );
  const validate = latestValidation(ctx, itemId);
  if (
    minimumIteration !== null &&
    (reviewContext?.iteration ?? -1) < minimumIteration
  ) {
    return false;
  }
  return Boolean(
    reviewContext &&
      (reviewContext.changedFiles.length > 0 || reviewContext.diffSummary.length > 0) &&
      validate &&
      validate.evidence.length > 0,
  );
}

function normalizedReviewIssues(
  ctx: WorkflowCtx,
  itemId: string,
  review: Review | undefined,
  minimumIteration: number | null,
): string[] {
  const issues = review?.issues ?? [];
  if (!reviewContextIsAvailable(ctx, itemId, minimumIteration)) return issues;
  return issues.filter((issue) => !isIgnorableContextComplaint(issue));
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
    issues.push(...normalizedReviewIssues(ctx, itemId, review, minimumIteration));
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
    const issues = normalizedReviewIssues(ctx, itemId, review, minimumIteration);
    return review?.approved === true || (review !== undefined && issues.length === 0);
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

function todoLoopState(
  ctx: WorkflowCtx,
  item: TodoItem,
): {
  phase: TodoLoopPhase;
  approved: boolean;
  blocked: boolean;
  latestImplementIteration: number;
  latestValidationIteration: number;
  latestReviewIteration: number;
  reviewIssuesForLatestValidation: string[];
  latestValidate: Validate | undefined;
  readyToFinalize: boolean;
  needsImplementation: boolean;
  needsValidation: boolean;
  needsReview: boolean;
  needsMarkTodoDone: boolean;
  needsCompletionSnapshot: boolean;
  needsBookmarkPush: boolean;
  needsCompletionReport: boolean;
} {
  const latestValidate = latestValidation(ctx, item.id);
  const latestImplementIteration =
    latestOutputIteration(ctx, "implement", `${item.id}:implement`) ?? -1;
  const latestValidationIteration =
    latestOutputIteration(ctx, "validate", `${item.id}:validate`) ?? -1;
  const latestReviewIteration = Math.max(
    ...REVIEWERS.map(
      (reviewer) =>
        latestOutputIteration(ctx, "review", `${item.id}:review:${reviewer.id}`) ??
        -1,
    ),
  );
  const reviewIssuesForLatestValidation =
    latestValidationIteration >= 0
      ? collectReviewIssues(ctx, item.id, REVIEWERS, latestValidationIteration)
      : [];
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
  const latestImplementationValidated =
    latestImplementIteration >= 0 &&
    latestValidationIteration >= latestImplementIteration &&
    latestValidate?.allPassed === true;
  const latestImplementationNeedsReview =
    latestImplementationValidated &&
    latestReviewIteration < latestValidationIteration;
  const latestImplementationHasReviewIssues =
    latestImplementationValidated &&
    latestReviewIteration >= latestValidationIteration &&
    reviewIssuesForLatestValidation.length > 0;
  const needsImplementation =
    !blocked &&
    !readyToFinalize &&
    (
      latestImplementIteration < 0 ||
      (latestValidationIteration >= latestImplementIteration &&
        latestValidate?.allPassed === false) ||
      latestImplementationHasReviewIssues
    );
  const needsValidation =
    !blocked &&
    !readyToFinalize &&
    !needsImplementation &&
    latestImplementIteration > latestValidationIteration;
  const needsReview =
    !blocked &&
    !readyToFinalize &&
    !needsImplementation &&
    !needsValidation &&
    latestImplementationNeedsReview;

  const phase: TodoLoopPhase = blocked
    ? "blocked"
    : needsMarkTodoDone ||
        needsCompletionSnapshot ||
        needsBookmarkPush ||
        needsCompletionReport
      ? "finalize"
      : needsReview
        ? "review"
        : needsValidation
          ? "validate"
          : needsImplementation
            ? "implement"
            : completionReported
              ? "done"
              : readyToFinalize
                ? "finalize"
                : latestImplementationValidated
                  ? "review"
                  : latestImplementIteration >= 0
                    ? "validate"
                    : "implement";

  return {
    phase,
    approved,
    blocked,
    latestImplementIteration,
    latestValidationIteration,
    latestReviewIteration,
    reviewIssuesForLatestValidation,
    latestValidate,
    readyToFinalize,
    needsImplementation,
    needsValidation,
    needsReview,
    needsMarkTodoDone,
    needsCompletionSnapshot,
    needsBookmarkPush,
    needsCompletionReport,
  };
}

function withNodeKey<T extends React.ReactElement>(
  element: T | null,
  key: string,
): T | null {
  if (!element) return null;
  return React.cloneElement(element, { key });
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
  const reviewContext = latestOutputRow<ReviewContext>(
    ctx,
    "reviewContext",
    `${item.id}:review-context`,
  );

  if (!latestValidate?.allPassed) return null;

  return Parallel({
    children: REVIEWERS.map((reviewer) =>
      Task({
        key: `${item.id}:review:${reviewer.id}`,
        id: `${item.id}:review:${reviewer.id}`,
        output: outputs.review,
        agent: piReviewAt(itemWorkspace(item.id)),
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
${reviewContext?.changedFiles?.length ? reviewContext.changedFiles.map((entry) => `- ${entry}`).join("\n") : "- none"}

Relevant JJ diff summary for the latest snapshotted change (@-):
${reviewContext?.diffSummary?.length ? reviewContext.diffSummary.map((entry) => `- ${entry}`).join("\n") : "- none"}

Latest validation evidence:
${latestValidate.evidence.length > 0 ? latestValidate.evidence.map((entry) => `- ${entry}`).join("\n") : "- validation passed without extra evidence"}

Review the latest snapshotted JJ change (@-) in ${workdir}.
Ignore transient runtime artifacts under .smithers, .fabrik, .jj, and .git.
If you need more detail than the summary above, inspect the repository directly with read/bash tools, for example:
- read todo.md and the changed files
- run \`jj diff --summary -r @-\`
- run \`jj show -r @- --stat\`
Do not claim missing context. Use the todo item, changed files, JJ diff, and validation evidence above as the complete review context.
If cluster evidence is available in the repository state, logs, or validation notes, you may use it as supporting evidence.
If evidence from exercising the CLI itself against the cluster is available, you may use that as supporting evidence too.
Do not require new ad hoc cluster-only verification steps unless the todo item explicitly calls for them.
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
  const relevantChangedFiles = filterRelevantRepoPaths(latestImplement?.changes ?? []);
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
${relevantChangedFiles.length > 0 ? relevantChangedFiles.map((entry) => `- ${entry}`).join("\n") : "- none"}

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
  const loopState = todoLoopState(ctx, item);
  const effectivePhase = loopState.phase;
  const {
    approved,
    blocked: loopBlocked,
    readyToFinalize: loopReadyToFinalize,
    needsMarkTodoDone: loopNeedsMarkTodoDone,
    needsCompletionSnapshot: loopNeedsCompletionSnapshot,
    needsBookmarkPush: loopNeedsBookmarkPush,
    needsCompletionReport: loopNeedsCompletionReport,
  } = loopState;
  const blocked = loopBlocked || effectivePhase === "blocked";
  const readyToFinalize =
    effectivePhase === "finalize" && loopReadyToFinalize;
  const needsImplementation = effectivePhase === "implement";
  const needsValidation = effectivePhase === "validate";
  const needsReview = effectivePhase === "review";
  const needsMarkTodoDone =
    effectivePhase === "finalize" && loopNeedsMarkTodoDone;
  const needsCompletionSnapshot =
    effectivePhase === "finalize" && loopNeedsCompletionSnapshot;
  const needsBookmarkPush =
    effectivePhase === "finalize" && loopNeedsBookmarkPush;
  const needsCompletionReport =
    effectivePhase === "finalize" && loopNeedsCompletionReport;
  return Sequence({
    key: item.id,
    children: [
      Branch({
        key: `${item.id}:blocked-branch`,
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
        key: `${item.id}:implement-branch`,
        if: needsImplementation,
        then: Sequence({
          key: `${item.id}:implement-sequence`,
          children: [
            Task({
              key: `${item.id}:implement`,
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
- You may run in-cluster kubectl checks in the current namespace to gather supporting evidence about behavior, logs, and resource state when that helps implementation.
- You may also run the CLI itself against the cluster to confirm intended behavior against real resources when that helps implementation.
- Treat those cluster checks as supporting evidence, not as a replacement for the deterministic validation gate.

Return ONLY JSON matching the schema.`,
            }),
            Task({
              key: `${item.id}:snapshot-implement`,
              id: `${item.id}:snapshot-implement`,
              output: outputs.report,
              timeoutMs: 60_000,
              children: () => snapshotChange(workdir, item.id, "implement"),
            }),
          ],
        }),
      }),

      Branch({
        key: `${item.id}:validate-branch`,
        if: needsValidation,
        then: Task({
          key: `${item.id}:validate`,
          id: `${item.id}:validate`,
          output: outputs.validate,
          timeoutMs: TASK_TIMEOUT_MS,
          retries: 1,
          children: () => runTodoValidation(item),
        }),
      }),

      Branch({
        key: `${item.id}:review-branch`,
        if: needsReview,
        then: Sequence({
          key: `${item.id}:review-sequence`,
          children: [
            Task({
              key: `${item.id}:review-context`,
              id: `${item.id}:review-context`,
              output: outputs.reviewContext,
              timeoutMs: 60_000,
              children: async () => {
                const diffSummary = await latestSnapshotDiffSummary(workdir);
                const changedFiles = filterRelevantRepoPaths(
                  latestOutputRow<z.infer<typeof implementSchema>>(
                    ctx,
                    "implement",
                    `${item.id}:implement`,
                  )?.changes ?? [],
                );
                return {
                  changedFiles,
                  diffSummary,
                };
              },
            }),
            withNodeKey(ReviewGroup({ item, ctx }), `${item.id}:review-group`),
          ],
        }),
      }),

      Branch({
        key: `${item.id}:idle-branch`,
        if:
          !blocked &&
          !readyToFinalize &&
          !needsImplementation &&
          !needsValidation &&
          !needsReview,
        then: Task({
          key: `${item.id}:idle-report`,
          id: `${item.id}:idle-report`,
          output: outputs.report,
          children: {
            ticketId: item.id,
            status: "partial",
            summary: `No executable step selected for ${item.id}; waiting for the next backlog iteration.`,
          },
        }),
      }),

      Branch({
        key: `${item.id}:mark-done-branch`,
        if: needsMarkTodoDone,
        then: Sequence({
          key: `${item.id}:mark-done-sequence`,
          children: [
            Task({
              key: `${item.id}:mark-todo-done`,
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
        key: `${item.id}:completion-snapshot-branch`,
        if: needsCompletionSnapshot,
        then: Sequence({
          key: `${item.id}:completion-snapshot-sequence`,
          children: [
            Task({
              key: `${item.id}:snapshot-complete`,
              id: `${item.id}:snapshot-complete`,
              output: outputs.report,
              timeoutMs: 60_000,
              children: () => snapshotChange(workdir, item.id, "complete"),
            }),
          ],
        }),
      }),

      Branch({
        key: `${item.id}:push-bookmark-branch`,
        if: needsBookmarkPush,
        then: Sequence({
          key: `${item.id}:push-bookmark-sequence`,
          children: [
            Task({
              key: `${item.id}:push-bookmark`,
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
        key: `${item.id}:completion-report-branch`,
        if: needsCompletionReport,
        then: Sequence({
          key: `${item.id}:completion-report-sequence`,
          children: [
            Task({
              key: `${item.id}:complete-report`,
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
          key: "prepare-repo",
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
          key: "ensure-todo",
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
          key: "todo-backlog-loop",
          id: "todo-backlog-loop",
          until: currentItem === null,
          maxIterations: MAX_TODO_LOOP_ITERATIONS,
          onMaxReached: "return-last",
          children: Sequence({
            key: "todo-backlog-sequence",
            children: [
              Task({
                key: "plan-todo-loop",
                id: "plan-todo-loop",
                output: outputs.todoPlan,
                children: () => {
                  const parsedItems = parseTodoItems(TODO_PATH);
                  const pendingItems = parsedItems.filter(
                    (item) => item.status !== "done",
                  );
                  const limitedItems =
                    MAX_TODO_ITEMS > 0
                      ? pendingItems.slice(0, MAX_TODO_ITEMS)
                      : pendingItems;
                  const previousPlan = latestTodoPlan(ctx);
                  const previousActive =
                    previousPlan?.activeItemId
                      ? parsedItems.find(
                          (item) => item.id === previousPlan.activeItemId,
                        ) ??
                        previousPlan.items.find(
                          (item) => item.id === previousPlan.activeItemId,
                        ) ??
                        null
                      : null;
                  const previousActivePhase = previousActive
                    ? todoLoopState(ctx, previousActive).phase
                    : null;
                  const activeItem =
                    previousActive &&
                      previousActivePhase !== "done" &&
                      previousActivePhase !== "blocked"
                      ? previousActive
                      : limitedItems[0] ?? null;
                  const selectedItems = activeItem &&
                      !limitedItems.some((item) => item.id === activeItem.id)
                    ? [activeItem, ...limitedItems]
                    : limitedItems;

                  return {
                    todoPath: TODO_PATH,
                    totalItems: parsedItems.length,
                    selectedItems: selectedItems.length,
                    activeItemId: activeItem?.id ?? null,
                    activePhase: activeItem
                      ? todoLoopState(ctx, activeItem).phase
                      : null,
                    items: selectedItems,
                  };
                },
              }),

              Branch({
                key: "todo-loop-branch",
                if: currentItem === null,
                then: null,
                else: Sequence({
                  key: "todo-item-sequence",
                  children: currentItem?.blockedReason
                    ? [
                        Task({
                          key: `${currentItem.id}:blocked`,
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

        Branch({
          key: "todo-loop-complete-branch",
          if: currentItem === null,
          then: Task({
            key: "todo-loop-complete",
            id: "todo-loop-complete",
            output: outputs.report,
            children: {
              ticketId: "todo-loop",
              status: "done",
              summary: "No pending todo items remain.",
            },
          }),
        }),
      ],
    }),
  });
});
