/** @jsxImportSource smithers-orchestrator */
import {
  Parallel,
  PiAgent,
  Ralph,
  Sequence,
  Task,
  Workflow,
  createSmithers,
} from "smithers-orchestrator";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { runVerificationJob } from "./utils/k8s-jobs";
import { prepareWorkspaces, pushBookmark, snapshotChange } from "./utils/jj-shell";
import { parseTodoItems, todoItemSchema, type TodoItem } from "./utils/todo-plan";

const WORKDIR_ROOT = process.cwd();
const CONTROL_ROOT = "/workspace/.fabrik";
const REPO_ROOT = WORKDIR_ROOT;
const TODO_PATH = resolve(REPO_ROOT, "todo.md");
const WORKSPACES_DIR = resolve(CONTROL_ROOT, "workspaces", ".jj-workspaces");
const DB_PATH = resolve(CONTROL_ROOT, "workflows", "todo-driver.db");
const jjRepo = process.env.SMITHERS_JJ_REPO?.trim() ?? "";
const jjBookmark = process.env.SMITHERS_JJ_BOOKMARK?.trim() ?? "";

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? "80");
const MAX_TODO_ITEMS = Number(process.env.MAX_TODO_ITEMS ?? "0");
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
  fixes: z.array(z.string()),
  allResolved: z.boolean(),
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
type Validate = z.infer<typeof validateSchema>;
type WorkflowCtx = Parameters<Parameters<typeof smithers>[0]>[0];

type Reviewer = {
  id: string;
  title: string;
  prompt: string;
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
  return resolve(WORKSPACES_DIR, itemId);
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

function verifierCommands(item: TodoItem, workdir: string): string[] {
  if (item.id === "runs-inspection") {
    return [
      `cd ${workdir}/src/fabrik-cli`,
      "go test ./...",
      "go build -o /tmp/fabrik-verify .",
      "VERIFY_RUN_ID=fabrik-verify-runs-$(date +%s)",
      "/tmp/fabrik-verify run --run-id \"$VERIFY_RUN_ID\" --spec specs/verify-runs.yaml --project verify --image \"$FABRIK_RUN_IMAGE\" --namespace \"$KUBERNETES_NAMESPACE\" --pvc-size 1Gi --job-command 'echo cluster-verify' --interactive=false",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" wait --for=condition=complete \"job/fabrik-$VERIFY_RUN_ID\" --timeout=180s",
      "/tmp/fabrik-verify runs list --namespace \"$KUBERNETES_NAMESPACE\"",
      "/tmp/fabrik-verify runs show --run-id \"$VERIFY_RUN_ID\" --namespace \"$KUBERNETES_NAMESPACE\"",
      "/tmp/fabrik-verify run logs --run-id \"$VERIFY_RUN_ID\" --namespace \"$KUBERNETES_NAMESPACE\"",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" delete job \"fabrik-$VERIFY_RUN_ID\" --ignore-not-found",
      "kubectl -n \"$KUBERNETES_NAMESPACE\" delete pvc \"data-fabrik-$VERIFY_RUN_ID\" --ignore-not-found",
    ];
  }

  throw new Error(`No deterministic verifier is wired for todo item ${item.id}.`);
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
  const planRows =
    (ctx.outputs as { todoPlan?: unknown[] }).todoPlan ?? ctx.outputs("todoPlan");
  const plan = planRows.length > 0 ? planRows[planRows.length - 1] : null;
  if (!plan || typeof plan !== "object") return [];
  const row = plan as { items?: unknown };
  if (!Array.isArray(row.items)) return [];

  const items: TodoItem[] = [];
  for (const item of row.items) {
    const parsed = todoItemSchema.safeParse(item);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

function collectReviewIssues(
  ctx: WorkflowCtx,
  itemId: string,
  reviewers: Reviewer[],
): string[] {
  const issues: string[] = [];
  for (const reviewer of reviewers) {
    const review = ctx.latest("review", `${itemId}:review:${reviewer.id}`) as
      | Review
      | undefined;
    if (review?.issues?.length) issues.push(...review.issues);
  }
  return issues;
}

function allReviewersApproved(
  ctx: WorkflowCtx,
  itemId: string,
  reviewers: Reviewer[],
): boolean {
  return reviewers.every((reviewer) => {
    const review = ctx.latest("review", `${itemId}:review:${reviewer.id}`) as
      | Review
      | undefined;
    return review?.approved === true;
  });
}

function latestValidationPassed(ctx: WorkflowCtx, itemId: string): boolean {
  const validate = ctx.latest("validate", `${itemId}:validate`) as
    | Validate
    | undefined;
  return validate?.allPassed === true;
}

function ReviewGroup({
  item,
  ctx,
}: {
  item: TodoItem;
  ctx: WorkflowCtx;
}) {
  if (!latestValidationPassed(ctx, item.id)) return null;

  return (
    <Parallel>
      {REVIEWERS.map((reviewer) => (
        <Task
          key={`${item.id}:review:${reviewer.id}`}
          id={`${item.id}:review:${reviewer.id}`}
          output={outputs.review}
          agent={piReadAt(itemWorkspace(item.id))}
          timeoutMs={REVIEW_TIMEOUT_MS}
          retries={1}
          continueOnFail
        >
          {`Reviewer: ${reviewer.title}

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

Reject if the implementation cannot be defended from the repo state, tests, and command evidence.

Return ONLY JSON matching the schema.`}
        </Task>
      ))}
    </Parallel>
  );
}

function TodoItemPipeline({
  item,
  ctx,
}: {
  item: TodoItem;
  ctx: WorkflowCtx;
}) {
  const workdir = itemWorkspace(item.id);
  const issues = collectReviewIssues(ctx, item.id, REVIEWERS);
  const approved = allReviewersApproved(ctx, item.id, REVIEWERS);

  return (
    <Sequence key={item.id}>
      <Ralph
        id={`${item.id}:implementation-loop`}
        until={approved}
        maxIterations={MAX_ITERATIONS}
        onMaxReached="return-last"
      >
        <Sequence>
          <Task
            id={`${item.id}:implement`}
            output={outputs.implement}
            agent={piWriteAt(workdir)}
            timeoutMs={TASK_TIMEOUT_MS}
            retries={1}
          >
            {`Implement the next todo item in this workspace:
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

Existing review issues:
${issues.length > 0 ? issues.map((entry) => `- ${entry}`).join("\n") : "- none"}

Rules:
- Build or update the required verification before claiming completion.
- Do not run jj or git commands.
- Make the smallest maintainable change that satisfies the guarantees.
- Update docs and code comments only where the todo item requires them.
- If a guarantee cannot be completed safely in this run, say so clearly in the JSON output.

Return ONLY JSON matching the schema.`}
          </Task>

          <Task
            id={`${item.id}:snapshot-implement`}
            output={outputs.report}
            timeoutMs={60_000}
          >
            {() => snapshotChange(workdir, item.id, "implement")}
          </Task>

          <Task
            id={`${item.id}:validate`}
            output={outputs.validate}
            timeoutMs={TASK_TIMEOUT_MS}
            retries={1}
          >
            {() => runTodoValidation(item)}
          </Task>

          <ReviewGroup item={item} ctx={ctx} />

          <Task
            id={`${item.id}:review-fix`}
            output={outputs.reviewFix}
            agent={piWriteAt(workdir)}
            timeoutMs={TASK_TIMEOUT_MS}
            skipIf={approved || issues.length === 0}
          >
            {`Fix the reviewer issues for this todo item in:
${workdir}

Issues:
${issues.map((entry) => `- ${entry}`).join("\n")}

Rules:
- Do not run jj or git commands.
- Resolve the issues without weakening the verification expectations.

Return ONLY JSON matching the schema.`}
          </Task>

          <Task
            id={`${item.id}:snapshot-review-fix`}
            output={outputs.report}
            timeoutMs={60_000}
            skipIf={approved || issues.length === 0}
          >
            {() => snapshotChange(workdir, item.id, "review-fix")}
          </Task>
        </Sequence>
      </Ralph>

      <Task
        id={`${item.id}:final-report`}
        output={outputs.report}
      >
        {{
          ticketId: item.id,
          status:
            latestValidationPassed(ctx, item.id) &&
            allReviewersApproved(ctx, item.id, REVIEWERS)
              ? "done"
              : "partial",
          summary:
            latestValidationPassed(ctx, item.id) &&
            allReviewersApproved(ctx, item.id, REVIEWERS)
              ? `Completed ${item.id} with required verification and reviewer approval.`
              : `Stopped ${item.id} without clearing every verification or review gate.`,
        }}
      </Task>

      <Task
        id={`${item.id}:push-bookmark`}
        output={outputs.report}
        timeoutMs={TASK_TIMEOUT_MS}
        skipIf={
          !jjBookmark ||
          !latestValidationPassed(ctx, item.id) ||
          !allReviewersApproved(ctx, item.id, REVIEWERS)
        }
      >
        {() => pushBookmark(workdir, FEATURE_BOOKMARK, item.id)}
      </Task>
    </Sequence>
  );
}

export default smithers((ctx) => {
  const items = latestPlannedItems(ctx);
  const firstBlockedIndex = items.findIndex((item) => item.blockedReason);
  const visibleItems =
    firstBlockedIndex >= 0 ? items.slice(0, firstBlockedIndex + 1) : items;
  const blockedItems = visibleItems.filter((item) => item.blockedReason);
  const actionableItems = visibleItems.filter((item) => !item.blockedReason);

  return (
    <Workflow name="todo-driver" cache>
      <Sequence>
        <Task
          id="prepare-repo"
          output={outputs.report}
        >
          {async () => {
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
            await $`git clone ${jjRepo} ${tempClone}`.cwd(CONTROL_ROOT);
            await $`jj git init`.cwd(tempClone);
            await $`find ${REPO_ROOT} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`.quiet().nothrow();
            await $`sh -lc 'cd "$1" && tar -cf - . | (cd "$2" && tar -xf -)' sh ${tempClone} ${REPO_ROOT}`;
            await $`rm -rf ${tempClone}`;
            if (jjBookmark) {
              const checkout = await $`git checkout ${jjBookmark}`.cwd(REPO_ROOT).nothrow().quiet();
              if (checkout.exitCode !== 0) {
                const track = await $`git checkout -b ${jjBookmark} --track origin/${jjBookmark}`.cwd(REPO_ROOT).nothrow().quiet();
                if (track.exitCode !== 0) {
                  throw new Error(
                    `Failed to check out JJ bookmark '${jjBookmark}' after cloning ${jjRepo}. Ensure the remote branch exists before dispatch.`,
                  );
                }
              }
            }
            return {
              ticketId: "prepare-repo",
              status: "done",
              summary: jjBookmark
                ? `Cloned ${jjRepo} into ${REPO_ROOT} and checked out ${jjBookmark}`
                : `Cloned ${jjRepo} into ${REPO_ROOT}`,
            };
          }}
        </Task>

        <Task
          id="ensure-todo"
          output={outputs.report}
        >
          {() => {
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
          }}
        </Task>

        <Task
          id="plan-todo"
          output={outputs.todoPlan}
        >
          {() => {
            const parsedItems = parseTodoItems(TODO_PATH);
            const limitedItems =
              MAX_TODO_ITEMS > 0
                ? parsedItems.slice(0, MAX_TODO_ITEMS)
                : parsedItems;

            return {
              todoPath: TODO_PATH,
              totalItems: parsedItems.length,
              selectedItems: limitedItems.length,
              items: limitedItems,
            };
          }}
        </Task>

        <Sequence>
          {blockedItems.map((item) => (
            <Task
              key={`${item.id}:blocked`}
              id={`${item.id}:blocked`}
              output={outputs.report}
            >
              {{
                ticketId: item.id,
                status: "blocked",
                summary: item.blockedReason ?? `Blocked ${item.id}`,
              }}
            </Task>
          ))}
        </Sequence>

        <Task
          id="prepare-workspaces"
          output={outputs.report}
          timeoutMs={TASK_TIMEOUT_MS}
          skipIf={actionableItems.length === 0}
        >
          {() =>
            prepareWorkspaces(
              REPO_ROOT,
              WORKSPACES_DIR,
              actionableItems.map((item) => item.id),
            )}
        </Task>

        <Sequence>
          {actionableItems.map((item) => (
            <TodoItemPipeline key={item.id} item={item} ctx={ctx} />
          ))}
        </Sequence>
      </Sequence>
    </Workflow>
  );
});
