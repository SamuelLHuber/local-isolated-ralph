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
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { prepareWorkspaces, pushBookmark, snapshotChange } from "./utils/jj-shell";

const WORKDIR_ROOT = process.cwd();
const CONTROL_ROOT = "/workspace/.fabrik";
const REPO_ROOT = WORKDIR_ROOT;
const TODO_PATH = resolve(REPO_ROOT, "todo.md");
const WORKSPACES_DIR = resolve(CONTROL_ROOT, "workspaces", ".jj-workspaces");
const DB_PATH = resolve(CONTROL_ROOT, "workflows", "todo-driver.db");
const jjRepo = process.env.SMITHERS_JJ_REPO?.trim() ?? "";
const jjBookmark = process.env.SMITHERS_JJ_BOOKMARK?.trim() ?? "";

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? "80");
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

const todoItemSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .describe("Stable lowercase kebab-case item id"),
  title: z.string(),
  task: z.string(),
  specTieIn: z.array(z.string()).min(1),
  guarantees: z.array(z.string()).min(1),
  verificationToBuildFirst: z.array(z.string()).min(1),
  requiredChecks: z.array(z.string()).min(1),
  documentationUpdates: z.array(z.string()),
  blockedReason: z.string().nullable(),
});

const discoverSchema = z.object({
  todoPath: z.string(),
  reasoning: z.string(),
  items: z.array(todoItemSchema).max(3),
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
    discover: discoverSchema,
    implement: implementSchema,
    validate: validateSchema,
    review: reviewSchema,
    reviewFix: reviewFixSchema,
    report: reportSchema,
  },
  { dbPath: DB_PATH },
);

type TodoItem = z.infer<typeof todoItemSchema>;
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

const piReadRoot = new PiAgent({
  provider: PI_PROVIDER,
  model: PI_MODEL,
  mode: "json",
  noTools: false,
  tools: ["read", "bash"],
  noSession: true,
  systemPrompt: SYSTEM_PROMPT,
  cwd: REPO_ROOT,
  env: PI_ENV,
});

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

function latestDiscoveredItems(ctx: WorkflowCtx): TodoItem[] {
  const discoverRows =
    (ctx.outputs as { discover?: unknown[] }).discover ?? ctx.outputs("discover");
  const discover =
    discoverRows.length > 0 ? discoverRows[discoverRows.length - 1] : null;
  if (!discover || typeof discover !== "object") return [];
  const row = discover as { items?: unknown };
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
            agent={piWriteAt(workdir)}
            timeoutMs={TASK_TIMEOUT_MS}
            retries={1}
          >
            {`Validate this todo item from the workspace:
${workdir}

Todo item:
${item.title}

Verification that must exist:
${item.verificationToBuildFirst.map((entry) => `- ${entry}`).join("\n")}

Required checks:
${item.requiredChecks.map((entry) => `- ${entry}`).join("\n")}

Rules:
- Execute the required checks exactly unless the repo makes one impossible, in which case fail validation and explain why.
- Confirm the verification layer required by the todo item now exists.
- Report concrete command evidence. Do not claim success without it.

Return ONLY JSON matching the schema.`}
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
  const items = latestDiscoveredItems(ctx);
  const blockedItems = items.filter((item) => item.blockedReason);
  const actionableItems = items.filter((item) => !item.blockedReason);

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
            await $`jj git clone ${jjRepo} ${basename(REPO_ROOT)}`.cwd(dirname(REPO_ROOT));
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
          id="discover"
          output={outputs.discover}
          agent={piReadRoot}
          timeoutMs={TASK_TIMEOUT_MS}
          retries={2}
        >
          {`Read ${TODO_PATH} and select the next ${MAX_TODO_ITEMS} highest-priority unfinished todo items.

Rules:
- Respect the order in todo.md. Do not skip a higher-priority item unless you can defend that it is already complete in the repo.
- Each selected item must include:
  - Task
  - Spec tie-in
  - Guarantees
  - Verification to build first
  - Required checks
- If the next unfinished item is missing any of those sections, return it with blockedReason explaining exactly what is missing and do not skip to a lower-priority item.
- Use a stable kebab-case id derived from the section title.
- documentationUpdates should be an empty array when none are listed.
- The repo itself is the source of truth for whether an item is already complete; look at tests, docs, and current command behavior before deciding.

Return ONLY JSON matching the schema.`}
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
