#!/usr/bin/env smithers
/** @jsxImportSource smithers-orchestrator */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import {
  createSmithers,
  Sequence,
  Parallel,
  Ralph,
  PiAgent,
  CodexAgent,
  ClaudeCodeAgent
} from "smithers-orchestrator"

type Spec = {
  id: string
  title: string
  goals: string[]
  nonGoals: string[]
  req: {
    api: string[]
    behavior: string[]
    obs: string[]
  }
  accept: string[]
  assume: string[]
}

type TodoTask = { id: string; do: string; verify: string }
type Todo = { id: string; tdd: boolean; dod: string[]; tasks: TodoTask[] }

type Review = {
  v: number
  reviewer: string
  status: "approved" | "changes_requested"
  issues: string[]
  next: string[]
}

type ReviewSummary = {
  v: number
  status: "approved" | "changes_requested"
  issues: string[]
  next: string[]
}

type Report = {
  v: number
  taskId: string
  status: "done" | "blocked" | "failed"
  work: string[]
  files: string[]
  tests: string[]
  issues: string[]
  next: string[]
}

type HumanGate = {
  v: number
  status: "blocked"
  reason: string
}

const env = process.env
const specPath = resolve(env.SMITHERS_SPEC_PATH ?? env.SPEC_PATH ?? "specs/000-base.json")
const todoPath = resolve(env.SMITHERS_TODO_PATH ?? env.TODO_PATH ?? "specs/000-base.todo.json")
const reportDir = resolve(env.SMITHERS_REPORT_DIR ?? env.REPORT_DIR ?? "reports")
const promptPath = env.SMITHERS_PROMPT_PATH
const reviewPromptPath = env.SMITHERS_REVIEW_PROMPT_PATH
const reviewersDir = env.SMITHERS_REVIEWERS_DIR ?? "prompts/reviewers"
const reviewModelsPath = env.SMITHERS_REVIEW_MODELS_FILE
const execCwd = env.SMITHERS_CWD ? resolve(env.SMITHERS_CWD) : process.cwd()
const agentKind = (env.SMITHERS_AGENT ?? env.RALPH_AGENT ?? "pi").toLowerCase()
const modelOverride = env.SMITHERS_MODEL ?? env.MODEL
const providerOverride = env.SMITHERS_PROVIDER ?? env.PI_PROVIDER
const reviewMax = Number(env.SMITHERS_REVIEW_MAX ?? 2)

const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec
const todo = JSON.parse(readFileSync(todoPath, "utf8")) as Todo

const dbPath = resolve(env.SMITHERS_DB_PATH ?? join(".smithers", `${spec.id}.db`))
if (!existsSync(dirname(dbPath))) {
  mkdirSync(dirname(dbPath), { recursive: true })
}
if (!existsSync(reportDir)) {
  mkdirSync(reportDir, { recursive: true })
}

const reportSchema = z.object({
  v: z.number(),
  taskId: z.string(),
  status: z.enum(["done", "blocked", "failed"]),
  work: z.array(z.string()),
  files: z.array(z.string()),
  tests: z.array(z.string()),
  issues: z.array(z.string()),
  next: z.array(z.string())
})

const reviewSchema = z.object({
  v: z.number(),
  reviewer: z.string(),
  status: z.enum(["approved", "changes_requested"]),
  issues: z.array(z.string()),
  next: z.array(z.string())
})

const reviewSummarySchema = z.object({
  v: z.number(),
  status: z.enum(["approved", "changes_requested"]),
  issues: z.array(z.string()),
  next: z.array(z.string())
})

const humanGateSchema = z.object({
  v: z.number(),
  status: z.literal("blocked"),
  reason: z.string()
})

const { Workflow, Task, smithers } = createSmithers(
  {
    taskReport: reportSchema,
    reviewReport: reviewSchema,
    reviewSummary: reviewSummarySchema,
    humanGate: humanGateSchema
  },
  { dbPath }
)

const systemPrompt = [
  `Spec ID: ${spec.id}`,
  `Title: ${spec.title}`,
  "",
  "Goals:",
  ...spec.goals.map((g) => `- ${g}`),
  "",
  "Non-goals:",
  ...spec.nonGoals.map((g) => `- ${g}`),
  "",
  "API requirements:",
  ...spec.req.api.map((r) => `- ${r}`),
  "",
  "Behavior requirements:",
  ...spec.req.behavior.map((r) => `- ${r}`),
  "",
  "Observability requirements:",
  ...spec.req.obs.map((r) => `- ${r}`),
  "",
  "Acceptance criteria:",
  ...spec.accept.map((a) => `- ${a}`),
  "",
  "Assumptions:",
  ...spec.assume.map((a) => `- ${a}`),
  "",
  `TDD required: ${todo.tdd ? "yes" : "no"}`,
  "Definition of done:",
  ...todo.dod.map((d) => `- ${d}`)
].join("\n")

const loadPrompt = (path?: string): string => {
  if (!path) return ""
  try {
    if (!existsSync(path)) return ""
    return readFileSync(path, "utf8").trim()
  } catch {
    return ""
  }
}

const globalPrompt = loadPrompt(promptPath)
const reviewerPrompt = loadPrompt(reviewPromptPath)

type Reviewer = {
  id: string
  title: string
  prompt: string
}

// Fallback reviewers if prompts/reviewers/ directory doesn't exist or files missing.
// These are loaded from prompts/reviewers/*.md when available.
// File naming: prompts/reviewers/{REVIEWER-ID}.md (uppercase with hyphens)
const defaultReviewers: Reviewer[] = [
  { id: "security", title: "Security", prompt: "" },
  { id: "code-quality", title: "Code Quality", prompt: "" },
  { id: "simplicity", title: "Minimal Simplicity", prompt: "" },
  { id: "test-coverage", title: "Test Coverage", prompt: "" },
  { id: "maintainability", title: "Maintainability", prompt: "" },
  { id: "tigerstyle", title: "Tigerstyle Audit", prompt: "" },
  { id: "nasa-10-rules", title: "NASA Engineering Principles", prompt: "" },
  { id: "correctness-guarantees", title: "Correctness & Invariant Validation", prompt: "" }
]

const loadReviewers = (): Reviewer[] => {
  if (!reviewersDir || !existsSync(reviewersDir)) return defaultReviewers
  const files = readdirSync(reviewersDir).filter((f) => f.toLowerCase().endsWith(".md"))
  if (files.length === 0) return defaultReviewers
  return files.map((file) => {
    const id = file.replace(/\.md$/i, "").toLowerCase()
    const title = file.replace(/\.md$/i, "").replace(/[-_]/g, " ")
    const prompt = loadPrompt(join(reviewersDir, file))
    return { id, title, prompt }
  })
}

const reviewers = loadReviewers()

const loadReviewModels = (): Record<string, string> => {
  if (!reviewModelsPath) return {}
  try {
    if (!existsSync(reviewModelsPath)) return {}
    const raw = readFileSync(reviewModelsPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") map[key.toLowerCase()] = value
    }
    return map
  } catch {
    return {}
  }
}

const reviewModels = loadReviewModels()
const reviewDefaultModel = reviewModels._default ?? reviewModels.default ?? reviewModels["*"] ?? modelOverride

const taskSchemaExample = JSON.stringify(
  {
    v: 1,
    taskId: "task-id",
    status: "done | blocked | failed",
    work: ["..."],
    files: ["..."],
    tests: ["..."],
    issues: ["..."],
    next: ["..."]
  },
  null,
  2
)

const reviewSchemaExample = JSON.stringify(
  {
    v: 1,
    reviewer: "security",
    status: "approved | changes_requested",
    issues: ["..."],
    next: ["..."]
  },
  null,
  2
)

const makeAgent = (model?: string) => {
  const resolvedModel = model ?? modelOverride
  if (agentKind === "claude") {
    return new ClaudeCodeAgent({
      model: resolvedModel ?? "opus",
      dangerouslySkipPermissions: true,
      cwd: execCwd
    })
  }
  if (agentKind === "codex") {
    return new CodexAgent({
      model: resolvedModel ?? "gpt-5.2-codex",
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cd: execCwd,
      cwd: execCwd
    })
  }
  return new PiAgent({
    model: resolvedModel ?? undefined,
    provider: providerOverride ?? undefined,
    mode: "json",
    cwd: execCwd
  })
}

const taskAgent = makeAgent(modelOverride)

const taskNodes = todo.tasks.map((task) => ({
  nodeId: `task-${task.id}`,
  task
}))

const hasBlockingTask = (ctx: { outputMaybe: (table: string, key: { nodeId: string }) => Report | undefined }) => {
  return taskNodes.some(({ nodeId }) => {
    const report = ctx.outputMaybe("taskReport", { nodeId }) as Report | undefined
    return report ? report.status !== "done" : false
  })
}

const shouldSkipTask = (
  ctx: { outputMaybe: (table: string, key: { nodeId: string }) => Report | undefined },
  index: number
) => {
  if (index === 0) return false
  return taskNodes.slice(0, index).some(({ nodeId }) => {
    const report = ctx.outputMaybe("taskReport", { nodeId }) as Report | undefined
    return report ? report.status !== "done" : false
  })
}

const buildReviewTasks = (ctx: { latest: (table: string, nodeId: string) => Review | undefined }) => {
  const tasks: Array<{ id: string; reviewer: Reviewer; text: string }> = []
  for (const reviewer of reviewers) {
    const nodeId = `review-${reviewer.id}`
    const review = ctx.latest("reviewReport", nodeId) as Review | undefined
    if (!review) continue
    const items = [...(review.issues ?? []), ...(review.next ?? [])].filter(Boolean)
    items.forEach((item, index) => {
      tasks.push({
        id: `review-task-${reviewer.id}-${index + 1}`,
        reviewer,
        text: `[${reviewer.title}] ${item}`
      })
    })
  }
  return tasks
}

const combineReviews = (ctx: { outputMaybe: (table: string, key: { nodeId: string; iteration?: number }) => Review | undefined; iteration: number }) => {
  const reviews = reviewers
    .map((reviewer) => ctx.outputMaybe("reviewReport", { nodeId: `review-${reviewer.id}`, iteration: ctx.iteration }) as Review | undefined)
    .filter(Boolean) as Review[]
  const issues = reviews.flatMap((r) => r.issues ?? [])
  const next = reviews.flatMap((r) => r.next ?? [])
  const status = reviews.length > 0 && reviews.every((r) => r.status === "approved") ? "approved" : "changes_requested"
  return { v: 1, status, issues, next } satisfies ReviewSummary
}

export default smithers((ctx) => {
  const blocking = hasBlockingTask(ctx)
  const latestSummary = ctx.latest("reviewSummary", "review-summary") as ReviewSummary | undefined
  const reviewApproved = latestSummary?.status === "approved"
  const reviewIterations = ctx.iterationCount("reviewSummary", "review-summary")
  const reviewMaxIterations = Math.max(1, reviewMax + 1)
  const maxReviewReached = reviewIterations >= reviewMaxIterations && !reviewApproved

  const gateReason = reviewApproved
    ? "Human review required before next spec run."
    : maxReviewReached
      ? "Reviewers requested changes. Max retries reached; human decision required."
      : "Reviewers requested changes. Human decision required."

  const reviewTasks = buildReviewTasks(ctx)
  const needsReviewTasks = latestSummary?.status === "changes_requested"

  return (
    <Workflow name="spec-workflow">
      <Sequence>
        {taskNodes.map(({ nodeId, task }, index) => (
          <Task
            key={nodeId}
            id={nodeId}
            output="taskReport"
            outputSchema={reportSchema}
            skipIf={shouldSkipTask(ctx, index)}
            agent={taskAgent}
          >
            {[
              globalPrompt,
              systemPrompt,
              "",
              `Task ${index + 1}/${taskNodes.length}: ${task.id}`,
              "",
              "Do:",
              task.do,
              "",
              "Verify:",
              task.verify,
              "",
              "Engineering Standards (MUST comply - NASA/Tigerstyle):",
              "",
              "1. Classify Criticality Tier (T1-T4):",
              "   - T1 (Critical/Money/Auth): Needs ALL 6 layers (L1-L5 + Simulation)",
              "   - T2 (Important/State): Needs L1-L5, Simulation optional",
              "   - T3-T4 (Standard/Low): Needs L1-L4",
              "",
              "2. Implement Guarantee Layers (Defense in Depth):",
              "   * L1 (Types): Branded types for domain values (UserId, not string). Phantom types for state machines.",
              "   * L2 (Runtime): Effect.assert for preconditions/postconditions. Fail fast on violations.",
              "   * L3 (Persistence): DB constraints (UNIQUE for idempotency, CHECK for valid values).",
              "   * L4 (Tests): @property TSDoc naming each invariant. Property-based tests for correctness.",
              "   * L5 (Monitoring): TODOs/alerts for production (e.g., 'detected double X').",
              "   * L6 (Simulation): T1 only - seed-based 24/7 simulation plan.",
              "",
              "3. Tigerstyle Principles:",
              "   - No primitive obsession (branded types > raw primitives)",
              "   - Immutable data structures (const > let, avoid mutation)",
              "   - Explicit dependencies (Effect requirements, not hidden globals)",
              "   - Fail fast with guard clauses (assert early, assert often)",
              "",
              "4. NASA Power of Ten:",
              "   - Bounded loops (no infinite recursion, fixed upper limits)",
              "   - Short functions (<60 lines, single responsibility)",
              "   - Check all return values (Effect error channels handled)",
              "   - Explicit assertions (pre/postconditions verified)",
              "",
              "Version control (GitHub-compatible):",
              "- Use jj. GitHub requires named branches for PRs; never use anonymous changes.",
              `- Create branch: \`jj new main && jj bookmark create ${spec.id}-${task.id}\`.`,
              "- Work normally (jj auto-snapshots files).",

              `- Describe: \`jj describe -m "..."\` (required before push).`,
              `- Push to GitHub: \`jj git push --branch ${spec.id}-${task.id}\`.`,
              "  (This creates/updates the branch on origin for PR creation).",
              "- If push fails (conflict), rebase: `jj rebase -d main` then force-push.",
              "- If still failing, set status=failed with details.",
              "",
              "Output:",
              "Return a single JSON object that matches this schema:",
              taskSchemaExample
            ]
              .filter((line) => line !== "")
              .join("\n")}
          </Task>
        ))}

        <Ralph
          id="review-loop"
          until={reviewApproved}
          maxIterations={reviewMaxIterations}
          onMaxReached="return-last"
          skipIf={blocking}
        >
          <Sequence>
            {needsReviewTasks && reviewTasks.length > 0 ? (
              <Sequence>
                {reviewTasks.map((task, index) => (
                  <Task
                    key={task.id}
                    id={task.id}
                    output="taskReport"
                    outputSchema={reportSchema}
                    agent={taskAgent}
                  >
                    {[
                      globalPrompt,
                      systemPrompt,
                      "",
                      `Review Task ${index + 1}/${reviewTasks.length}: ${task.id}`,
                      "",
                      "Do:",
                      task.text,
                      "",
                      "Verify:",
                      "Update code/tests and verify relevant tests pass.",
                      "",
                      "Engineering Standards (MUST comply - NASA/Tigerstyle):",
                      "",
                      "1. Classify Criticality Tier (T1-T4):",
                      "   - T1 (Critical/Money/Auth): Needs ALL 6 layers (L1-L5 + Simulation)",
                      "   - T2 (Important/State): Needs L1-L5, Simulation optional",
                      "   - T3-T4 (Standard/Low): Needs L1-L4",
                      "",
                      "2. Implement Guarantee Layers (Defense in Depth):",
                      "   * L1 (Types): Branded types for domain values (UserId, not string). Phantom types for state machines.",
                      "   * L2 (Runtime): Effect.assert for preconditions/postconditions. Fail fast on violations.",
                      "   * L3 (Persistence): DB constraints (UNIQUE for idempotency, CHECK for valid values).",
                      "   * L4 (Tests): @property TSDoc naming each invariant. Property-based tests for correctness.",
                      "   * L5 (Monitoring): TODOs/alerts for production (e.g., 'detected double X').",
                      "   * L6 (Simulation): T1 only - seed-based 24/7 simulation plan.",
                      "",
                      "3. Tigerstyle Principles:",
                      "   - No primitive obsession (branded types > raw primitives)",
                      "   - Immutable data structures (const > let, avoid mutation)",
                      "   - Explicit dependencies (Effect requirements, not hidden globals)",
                      "   - Fail fast with guard clauses (assert early, assert often)",
                      "",
                      "4. NASA Power of Ten:",
                      "   - Bounded loops (no infinite recursion, fixed upper limits)",
                      "   - Short functions (<60 lines, single responsibility)",
                      "   - Check all return values (Effect error channels handled)",
                      "   - Explicit assertions (pre/postconditions verified)",
                      "",
                      "Version control (GitHub-compatible):",
                      "- Use jj. GitHub requires named branches for PRs; never use anonymous changes.",
                      `- Create branch: \`jj new main && jj bookmark create ${spec.id}-${task.id}\`.`,
                      "- Work normally (jj auto-snapshots files).",

                      `- Describe: \`jj describe -m "..."\` (required before push).`,
                      `- Push to GitHub: \`jj git push --branch ${spec.id}-${task.id}\`.`,
                      "  (This creates/updates the branch on origin for PR creation).",
                      "- If push fails (conflict), rebase: `jj rebase -d main` then force-push.",
                      "- If still failing, set status=failed with details.",
                      "",
                      "Output:",
                      "Return a single JSON object that matches this schema:",
                      taskSchemaExample
                    ]
                      .filter((line) => line !== "")
                      .join("\n")}
                  </Task>
                ))}
              </Sequence>
            ) : null}

            <Parallel>
              {reviewers.map((reviewer) => {
                const modelOverride = reviewModels[reviewer.id.toLowerCase()] ?? reviewDefaultModel
                const reviewerAgent = makeAgent(modelOverride)
                return (
                  <Task
                    key={reviewer.id}
                    id={`review-${reviewer.id}`}
                    output="reviewReport"
                    outputSchema={reviewSchema}
                    agent={reviewerAgent}
                  >
                    {[
                      reviewerPrompt,
                      reviewer.prompt,
                      systemPrompt,
                      "",
                      `Reviewer: ${reviewer.title}`,
                      `Set reviewer to "${reviewer.id}" in the JSON output.`,
                      "Review the implementation against the spec, todo, and task reports.",
                      "Focus on correctness, tests, security, and strict spec compliance.",
                      "Verify changes were pushed (jj git push --change @) if applicable.",
                      "",
                      "Output:",
                      "Return a single JSON object that matches this schema:",
                      reviewSchemaExample
                    ]
                      .filter((line) => line !== "")
                      .join("\n")}
                  </Task>
                )
              })}
            </Parallel>

            <Task id="review-summary" output="reviewSummary" outputSchema={reviewSummarySchema}>
              {combineReviews(ctx)}
            </Task>
          </Sequence>
        </Ralph>

        <Task
          id="human-gate"
          output="humanGate"
          outputSchema={humanGateSchema}
          skipIf={blocking || !latestSummary}
        >
          {{ v: 1, status: "blocked", reason: gateReason }}
        </Task>
      </Sequence>
    </Workflow>
  )
})
