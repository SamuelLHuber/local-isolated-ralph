/** @jsxImportSource smithers-orchestrator */
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
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { prepareWorkspaces, pushBookmark, snapshotChange } from "./utils/jj-shell";

const WORKDIR_ROOT = process.cwd();
const REPO_ROOT = resolve(WORKDIR_ROOT, "repo");
const WORKSPACES_DIR = resolve(WORKDIR_ROOT, "workspaces", ".jj-workspaces");
const DB_PATH = resolve(WORKDIR_ROOT, "workflows", "pi-spec-implementation.db");
const jjRepo = process.env.SMITHERS_JJ_REPO?.trim() ?? "";
const jjBookmark = process.env.SMITHERS_JJ_BOOKMARK?.trim() ?? "";

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? "200");
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? "5");
const TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 60 * 60 * 1000;
const REVIEW_RETRIES = 2;
const FEATURE_BOOKMARK = jjBookmark || "feat/fabrik-pi-sample";
const PI_PROVIDER = "fireworks";
const PI_MODEL = "accounts/fireworks/models/kimi-k2p5";
const PI_ENV = {
  XDG_CACHE_HOME: "/tmp/pi-cache",
  XDG_STATE_HOME: "/tmp/pi-state",
  XDG_CONFIG_HOME: "/tmp/pi-config",
  PI_CODING_AGENT_DIR: "/tmp/pi-agent",
};

const ticketBaseSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .describe("Unique slug identifier (lowercase kebab-case)"),
    title: z.string(),
    description: z.string(),
    category: z.string().optional(),
    priority: z.enum(["critical", "high", "medium", "low"]).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    relevantFiles: z.array(z.string()).optional(),
    referenceFiles: z.array(z.string()).optional(),
    dependencies: z.array(z.string()).nullable(),
  })
  .passthrough();

const ticketSchema = z.discriminatedUnion("scope", [
  ticketBaseSchema.extend({
    scope: z.literal("vertical"),
    userJourney: z.string(),
    layers: z.array(z.string()).min(2),
    apiSurface: z.array(z.string()).min(1),
    dataImpact: z.string(),
    testPlan: z.array(z.string()).min(1),
  }),
  ticketBaseSchema.extend({
    scope: z.literal("single"),
    layer: z.string(),
    testPlan: z.array(z.string()).min(1),
    userJourney: z.string().optional(),
    layers: z.array(z.string()).optional(),
    apiSurface: z.array(z.string()).optional(),
    dataImpact: z.string().optional(),
  }),
]);

const discoverSchema = z.object({
  tickets: z.array(ticketSchema).max(5),
  reasoning: z.string(),
});

const implementSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  tests: z.array(z.string()),
  jj: z.array(z.string()),
});

const validateSchema = z.object({
  allPassed: z.boolean(),
  failingSummary: z.string().nullable(),
  commands: z.array(z.string()),
});

const reviewSchema = z.object({
  reviewer: z.string(),
  approved: z.boolean(),
  issues: z.array(z.string()),
  nextSteps: z.array(z.string()),
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

type Ticket = z.infer<typeof ticketSchema>;
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
    id: "baseline",
    title: "Baseline",
    prompt:
      "Review for spec alignment, correctness, missing acceptance criteria coverage, and obvious behavioral regressions.",
  },
  {
    id: "security",
    title: "Security",
    prompt:
      "Review for unsafe input handling, secret exposure, shell misuse, auth regressions, and weakened safety invariants.",
  },
  {
    id: "maintainability",
    title: "Maintainability",
    prompt:
      "Review for unnecessary complexity, weak boundaries, poor testability, and changes that make the repo harder to evolve.",
  },
];

const MIN_REVIEWERS = REVIEWERS.filter(
  (reviewer) => reviewer.id === "baseline" || reviewer.id === "security",
);

const PI_JSON_SCHEMA_PATH = resolve(tmpdir(), "pi-super-schema.json");
{
  const ticketProperties = {
    id: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    category: { type: "string" },
    priority: { type: "string" },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    relevantFiles: { type: "array", items: { type: "string" } },
    referenceFiles: { type: "array", items: { type: "string" } },
    dependencies: { type: ["array", "null"], items: { type: "string" } },
    scope: { type: "string" },
    userJourney: { type: "string" },
    layers: { type: "array", items: { type: "string" } },
    apiSurface: { type: "array", items: { type: "string" } },
    dataImpact: { type: "string" },
    testPlan: { type: "array", items: { type: "string" } },
    layer: { type: "string" },
  };

  const ticketSchemaJson = {
    type: "object",
    additionalProperties: false,
    properties: ticketProperties,
    required: Object.keys(ticketProperties),
  };

  const rootProperties = {
    tickets: { type: "array", items: ticketSchemaJson },
    reasoning: { type: "string" },
    summary: { type: "string" },
    changes: { type: "array", items: { type: "string" } },
    tests: { type: "array", items: { type: "string" } },
    jj: { type: "array", items: { type: "string" } },
    allPassed: { type: "boolean" },
    failingSummary: { type: ["string", "null"] },
    commands: { type: "array", items: { type: "string" } },
    reviewer: { type: "string" },
    approved: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
    fixes: { type: "array", items: { type: "string" } },
    allResolved: { type: "boolean" },
    ticketId: { type: "string" },
    status: { type: "string" },
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: rootProperties,
    required: Object.keys(rootProperties),
  };
  writeFileSync(PI_JSON_SCHEMA_PATH, JSON.stringify(schema), "utf8");
}

const SYSTEM_PROMPT = [
  "You are the PI implementation agent for a repository dispatched through Fabrik.",
  "Work directly in the cloned repo and follow its local specs, repo instructions, and existing architecture.",
  "Use minimal dependencies, keep changes precise, and verify behavior with repo-local tests when possible.",
].join("\n");

// PI Agent with Fireworks provider and kimi-k2p5 model for read-only operations
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

// PI Agent with Fireworks provider and kimi-k2p5 model for write operations
const piWriteRoot = new PiAgent({
  provider: PI_PROVIDER,
  model: PI_MODEL,
  mode: "json",
  noTools: false,
  tools: ["read", "edit", "write", "bash"],
  noSession: true,
  systemPrompt: SYSTEM_PROMPT,
  cwd: REPO_ROOT,
  env: PI_ENV,
});

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

function workspacePath(ticketId: string): string {
  return resolve(WORKSPACES_DIR, ticketId);
}

function TicketsFromDiscover(discover: unknown): Ticket[] {
  if (!discover || typeof discover !== "object") return [];
  const row = discover as { tickets?: unknown };
  const raw = row.tickets;
  let items: unknown[] = [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
  } else if (raw instanceof Uint8Array) {
    try {
      const parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
  } else if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === "object") {
    const maybeArray = raw as { length?: number };
    if (Array.isArray(maybeArray)) {
      items = maybeArray;
    }
  }

  const tickets: Ticket[] = [];
  for (const item of items) {
    const parsed = ticketSchema.safeParse(item);
    if (parsed.success) tickets.push(parsed.data);
  }
  return tickets;
}

function collectReviewIssues(
  ctx: WorkflowCtx,
  ticketId: string,
  reviewers: Reviewer[],
  prefix: string,
): string[] {
  const issues: string[] = [];
  for (const reviewer of reviewers) {
    const review = ctx.latest("review", `${ticketId}:${prefix}:${reviewer.id}`) as
      | Review
      | undefined;
    if (review?.issues?.length) {
      issues.push(...review.issues);
    }
  }
  return issues;
}

function allReviewersApproved(
  ctx: WorkflowCtx,
  ticketId: string,
  reviewers: Reviewer[],
  prefix: string,
): boolean {
  return reviewers.every((reviewer) => {
    const review = ctx.latest("review", `${ticketId}:${prefix}:${reviewer.id}`) as
      | Review
      | undefined;
    return review?.approved === true;
  });
}

function ReviewGroup({
  ticket,
  ctx,
  reviewers,
  prefix,
  validateId,
}: {
  ticket: Ticket;
  ctx: WorkflowCtx;
  reviewers: Reviewer[];
  prefix: string;
  validateId: string;
}) {
  const validate = ctx.latest("validate", `${ticket.id}:${validateId}`) as
    | Validate
    | undefined;

  if (!validate?.allPassed) return null;

  const reviewerTasks = reviewers.map((reviewer) => {
    const agent = piReadAt(workspacePath(ticket.id));
    return (
      <Task
        key={`${ticket.id}:${prefix}:${reviewer.id}`}
        id={`${ticket.id}:${prefix}:${reviewer.id}`}
        output={outputs.review}
        agent={agent}
        timeoutMs={REVIEW_TIMEOUT_MS}
        retries={REVIEW_RETRIES}
        continueOnFail
      >
        {`Reviewer: ${reviewer.title}

Use this reviewer rubric:
${reviewer.prompt}

Ticket:
${ticket.title}

${ticket.description}

Acceptance criteria:
${ticket.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

Return ONLY JSON matching the schema.`}
      </Task>
    );
  });

  return <Parallel>{reviewerTasks}</Parallel>;
}

function ValidationLoop({ ticket, ctx }: { ticket: Ticket; ctx: WorkflowCtx }) {
  const ticketId = ticket.id;
  const approved = allReviewersApproved(ctx, ticketId, MIN_REVIEWERS, "review");
  const issues = collectReviewIssues(ctx, ticketId, MIN_REVIEWERS, "review");

  const workdir = workspacePath(ticketId);
  const piWrite = piWriteAt(workdir);
  const piRead = piReadAt(workdir);

  return (
    <Ralph
      id={`${ticketId}:impl-review-loop`}
      until={approved}
      maxIterations={MAX_ITERATIONS}
      onMaxReached="return-last"
    >
      <Sequence>
        <Task
          id={`${ticketId}:implement`}
          output={outputs.implement}
          agent={piWrite}
          timeoutMs={TASK_TIMEOUT_MS}
          retries={1}
        >
          {`Implement this ticket in the workspace:
${workdir}

Ticket:
${ticket.title}

${ticket.description}

Scope: ${ticket.scope}
${ticket.scope === "vertical"
  ? `Layers: ${ticket.layers?.join(", ")}
API surface: ${ticket.apiSurface?.join(", ")}
Data impact: ${ticket.dataImpact}
User journey: ${ticket.userJourney}`
  : `Layer: ${ticket.layer}`}

Acceptance criteria:
${ticket.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

Dependencies: ${ticket.dependencies?.join(", ") ?? "none"}

Review issues to address (if any):
${issues.length > 0 ? issues.map((i) => `- ${i}`).join("\n") : "none"}

Requirements:
- Write code directly in this workspace. Do NOT run any jj or git commands.
- Run relevant tests or explain why not.
- Keep changes minimal and aligned to specs.
- Prefer end-to-end implementation when feasible (schema → handler → service → persistence → tests).
- Avoid mock/in-memory persistence for PRD entities in production paths unless explicitly justified by scope.
- Ensure new/changed API endpoints are wired into DomainApi and the router.
- If scope is "vertical", touch all declared layers and include cross-layer test coverage.
- If scope is "single", keep changes local to the declared layer and validate locally.
- Tests must assert boundary behavior (API/contract/integration) when applicable, not only internal logic.
- Control time/randomness in tests to keep them deterministic.
- If invariants/data integrity change, add DB constraints and tests that verify enforcement.

Return ONLY JSON matching the schema.`}
        </Task>

        <Task
          id={`${ticketId}:snapshot-implement`}
          output={outputs.report}
          timeoutMs={60_000}
        >
          {() => snapshotChange(workdir, ticketId, "implement")}
        </Task>

        <Task
          id={`${ticketId}:validate`}
          output={outputs.validate}
          agent={piWrite}
          timeoutMs={TASK_TIMEOUT_MS}
          retries={1}
        >
          {`Validate changes in:
${workdir}

Run the most relevant tests for this ticket. If tests are skipped, explain why.
Report all commands and whether they passed.
If scope is "vertical", include at least one cross-layer test (integration or contract).

Return ONLY JSON matching the schema.`}
        </Task>

        <ReviewGroup
          ticket={ticket}
          ctx={ctx}
          reviewers={MIN_REVIEWERS}
          prefix="review"
          validateId="validate"
        />

        <Task
          id={`${ticketId}:review-fix`}
          output={outputs.reviewFix}
          agent={piWrite}
          timeoutMs={TASK_TIMEOUT_MS}
          skipIf={approved || issues.length === 0}
        >
          {`Fix all reviewer issues in:
${workdir}

Do NOT run any jj or git commands. Only fix code.

Issues:
${issues.map((i) => `- ${i}`).join("\n")}

Return ONLY JSON matching the schema.`}
        </Task>

        <Task
          id={`${ticketId}:snapshot-review-fix`}
          output={outputs.report}
          timeoutMs={60_000}
          skipIf={approved || issues.length === 0}
        >
          {() => snapshotChange(workdir, ticketId, "review-fix")}
        </Task>
      </Sequence>
    </Ralph>
  );
}

function TicketPipeline({ ticket, ctx }: { ticket: Ticket; ctx: WorkflowCtx }) {
  const ticketId = ticket.id;
  const report = ctx.latest("report", `${ticketId}:impl-report`);
  const done = report != null;

  return (
    <Sequence key={ticketId} skipIf={done}>
      <ValidationLoop ticket={ticket} ctx={ctx} />
      <Task
        id={`${ticketId}:impl-report`}
        output={outputs.report}
      >
        {{
          ticketId,
          status: allReviewersApproved(ctx, ticketId, MIN_REVIEWERS, "review")
            ? "done"
            : "partial",
          summary: `Completed ticket ${ticketId} with ${
            allReviewersApproved(ctx, ticketId, MIN_REVIEWERS, "review")
              ? "approval"
              : "partial results"
          }.`,
        }}
      </Task>
    </Sequence>
  );
}

function FinalReviewPipeline({
  ticket,
  ctx,
}: {
  ticket: Ticket;
  ctx: WorkflowCtx;
}) {
  const ticketId = ticket.id;
  const report = ctx.latest("report", `${ticketId}:final-report`);
  const done = report != null;
  const workdir = workspacePath(ticketId);
  const piWrite = piWriteAt(workdir);

  return (
    <Sequence key={`${ticketId}:final`} skipIf={done}>
      <Ralph
        id={`${ticketId}:final-review-loop`}
        until={allReviewersApproved(ctx, ticketId, REVIEWERS, "final-review")}
        maxIterations={MAX_ITERATIONS}
        onMaxReached="return-last"
      >
        <Sequence>
          <Task
            id={`${ticketId}:final-validate`}
            output={outputs.validate}
            agent={piWrite}
            timeoutMs={TASK_TIMEOUT_MS}
            retries={1}
          >
            {`Validate changes in:
${workdir}

Run the most relevant tests for this ticket. If tests are skipped, explain why.
Report all commands and whether they passed.

Return ONLY JSON matching the schema.`}
          </Task>

          <ReviewGroup
            ticket={ticket}
            ctx={ctx}
            reviewers={REVIEWERS}
            prefix="final-review"
            validateId="final-validate"
          />

          <Task
            id={`${ticketId}:final-review-fix`}
            output={outputs.reviewFix}
            agent={piWrite}
            timeoutMs={TASK_TIMEOUT_MS}
            skipIf={
              allReviewersApproved(ctx, ticketId, REVIEWERS, "final-review") ||
              collectReviewIssues(ctx, ticketId, REVIEWERS, "final-review")
                .length === 0
            }
          >
            {`Fix all reviewer issues in:
${workdir}

Do NOT run any jj or git commands. Only fix code.

Issues:
${collectReviewIssues(ctx, ticketId, REVIEWERS, "final-review")
  .map((i) => `- ${i}`)
  .join("\n")}

Return ONLY JSON matching the schema.`}
          </Task>

          <Task
            id={`${ticketId}:snapshot-final-review-fix`}
            output={outputs.report}
            timeoutMs={60_000}
            skipIf={
              allReviewersApproved(ctx, ticketId, REVIEWERS, "final-review") ||
              collectReviewIssues(ctx, ticketId, REVIEWERS, "final-review")
                .length === 0
            }
          >
            {() => snapshotChange(workdir, ticketId, "final-review-fix")}
          </Task>
        </Sequence>
      </Ralph>

      <Task
        id={`${ticketId}:final-report`}
        output={outputs.report}
      >
        {{
          ticketId,
          status: allReviewersApproved(ctx, ticketId, REVIEWERS, "final-review")
            ? "done"
            : "partial",
          summary: `Completed final review for ${ticketId} with ${
            allReviewersApproved(ctx, ticketId, REVIEWERS, "final-review")
              ? "approval"
              : "partial results"
          }.`,
        }}
      </Task>

      <Task
        id={`${ticketId}:push-bookmark`}
        output={outputs.report}
        timeoutMs={TASK_TIMEOUT_MS}
        skipIf={
          !jjBookmark || !allReviewersApproved(ctx, ticketId, REVIEWERS, "final-review")
        }
      >
        {() => pushBookmark(workdir, FEATURE_BOOKMARK, ticketId)}
      </Task>
    </Sequence>
  );
}

export default smithers((ctx) => {
  const discoverRows =
    (ctx.outputs as { discover?: unknown[] }).discover ?? ctx.outputs("discover");
  const discover =
    discoverRows.length > 0 ? discoverRows[discoverRows.length - 1] : null;
  const tickets = TicketsFromDiscover(discover ?? {});
  const completedTickets = tickets.filter(
    (ticket) => ctx.latest("report", `${ticket.id}:final-report`) != null,
  );
  const pending = tickets.filter(
    (ticket) => ctx.latest("report", `${ticket.id}:final-report`) == null,
  );

  return (
    <Workflow name="pi-spec-implementation" cache>
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
                "Missing SMITHERS_JJ_REPO. This sample expects `fabrik run --jj-repo <repo-url>` so it can clone the target repo into /workspace/workdir/repo.",
              );
            }
            if (!process.env.FIREWORKS_API_KEY?.trim()) {
              throw new Error(
                "Missing FIREWORKS_API_KEY. Sync it through `--env-file` so the PI agent can use the Fireworks-backed Kimi model inside the Job pod.",
              );
            }
            await $`jj git clone ${jjRepo} ${REPO_ROOT}`.cwd(WORKDIR_ROOT);
            return {
              ticketId: "prepare-repo",
              status: "done",
              summary: `Cloned ${jjRepo} into ${REPO_ROOT}`,
            };
          }}
        </Task>

        <Branch if={pending.length === 0} then={
          <Task
            id="discover"
            output={outputs.discover}
            agent={piReadRoot}
            timeoutMs={TASK_TIMEOUT_MS}
            retries={2}
          >
            {`Discover the next 3-5 implementation tickets by comparing the cloned repo's documented requirements to its current codebase.

Repo root: ${REPO_ROOT}

Constraints:
- Start by reading the root README.md.
- Read any root-level repo instructions such as AGENTS.md or CLAUDE.md before proposing tickets.
- If specs/README.md exists, use it as the primary spec index.
- If specs/README.md does not exist, inspect the repo's docs/ tree and any architecture or guide documents that define expected behavior.
- Use only the existing repo. Do not invent features beyond specs.
- Prefer foundational tickets before dependent ones.
- Tickets must be minimal, independently testable.
- IDs must be lowercase kebab-case.
- Every ticket must declare a scope: "vertical" or "single".
- Use "vertical" when the change affects user flow, API/data, shared contracts, or cross-layer behavior.
- Use "single" only for copy/styling-only changes or isolated refactors with no external behavior change.
- Vertical tickets must include userJourney, layers (>=2), apiSurface, dataImpact, and a cross-layer testPlan.
- Single tickets must include layer and a local testPlan.
- Response schema requires all fields: always include every ticket field. For "single", set userJourney/dataImpact to empty strings and layers/apiSurface to empty arrays. For "vertical", set layer to an empty string.
- Arrays like acceptanceCriteria/relevantFiles/referenceFiles/testPlan must be present (empty arrays are allowed).
- Prefer full, end-to-end scope for vertical tickets (complete the flow, not partial slices).
- Do not split a single user flow across multiple tickets unless there is a hard dependency.
${completedTickets.length > 0 ? `\nCompleted tickets (do not repeat):\n${completedTickets.map((t) => `- ${t.id}`).join("\n")}\n` : ""}

Return ONLY JSON matching the schema.`}
          </Task>
        } />

        <Task
          id="prepare-workspaces"
          output={outputs.report}
          timeoutMs={TASK_TIMEOUT_MS}
          skipIf={pending.length === 0}
        >
          {() => prepareWorkspaces(REPO_ROOT, WORKSPACES_DIR, pending.map((t) => t.id))}
        </Task>

        <Parallel maxConcurrency={MAX_CONCURRENCY}>
          {pending.map((ticket) => (
            <TicketPipeline key={ticket.id} ticket={ticket} ctx={ctx} />
          ))}
        </Parallel>

        <Parallel maxConcurrency={MAX_CONCURRENCY}>
          {pending.map((ticket) => (
            <FinalReviewPipeline key={ticket.id} ticket={ticket} ctx={ctx} />
          ))}
        </Parallel>
      </Sequence>
    </Workflow>
  );
});
