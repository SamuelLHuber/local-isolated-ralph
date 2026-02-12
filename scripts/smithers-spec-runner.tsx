/** @jsxImportSource smithers-orchestrator */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createSmithers, CodexAgent, ClaudeCodeAgent, Parallel, Ralph, Sequence, Task } from "smithers-orchestrator"
import { z } from "zod"

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

type Reviewer = { id: string; title: string; prompt: string }

const env = process.env
const specPath = resolve(env.SMITHERS_SPEC_PATH ?? env.SPEC_PATH ?? "specs/000-base.min.json")
const todoPath = resolve(env.SMITHERS_TODO_PATH ?? env.TODO_PATH ?? "specs/000-base.todo.min.json")
const reportDir = resolve(env.SMITHERS_REPORT_DIR ?? env.REPORT_DIR ?? "reports")
const promptPath = env.SMITHERS_PROMPT_PATH
const reviewPromptPath = env.SMITHERS_REVIEW_PROMPT_PATH
const reviewersDir = env.SMITHERS_REVIEWERS_DIR
const controlDir = env.CONTROL_DIR ?? ""
const runId = env.SMITHERS_RUN_ID ?? ""
const branchName = env.SMITHERS_BRANCH ?? ""

const agentKind = (env.SMITHERS_AGENT ?? env.RALPH_AGENT ?? "codex").toLowerCase()
const reviewAgentKind = "codex"

const model =
  env.SMITHERS_MODEL ??
  env.MODEL ??
  (agentKind === "codex" ? "gpt-5.2-codex" : "opus")

const reviewMax = Math.max(1, Number(env.SMITHERS_REVIEW_MAX ?? 2))

const loadPrompt = (path?: string): string => {
  if (!path) return ""
  try {
    if (!existsSync(path)) return ""
    return readFileSync(path, "utf8").trim()
  } catch {
    return ""
  }
}

const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec
const todo = JSON.parse(readFileSync(todoPath, "utf8")) as Todo

const globalPrompt = loadPrompt(promptPath)
const reviewerPrompt = loadPrompt(reviewPromptPath)

const defaultReviewers: Reviewer[] = [
  { id: "security", title: "Security", prompt: "" },
  { id: "code-quality", title: "Code Quality", prompt: "" },
  { id: "simplicity", title: "Minimal Simplicity", prompt: "" },
  { id: "test-coverage", title: "Test Coverage", prompt: "" },
  { id: "maintainability", title: "Maintainability", prompt: "" }
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
const runReview = reviewers.length > 0

const taskReportSchema = z.object({
  v: z.literal(1),
  taskId: z.string(),
  status: z.enum(["done", "blocked", "failed"]),
  work: z.array(z.string()),
  files: z.array(z.string()),
  tests: z.array(z.string()),
  issues: z.array(z.string()),
  next: z.array(z.string()),
  rootCause: z.string(),
  reasoning: z.string(),
  fix: z.string(),
  error: z.string(),
  commit: z.string()
})

const reviewSchema = z.object({
  v: z.literal(1),
  status: z.enum(["approved", "changes_requested"]),
  issues: z.array(z.string()),
  next: z.array(z.string())
})

const gateSchema = z.object({
  v: z.literal(1),
  status: z.literal("blocked"),
  reason: z.string()
})

const { Workflow, smithers } = createSmithers({
  taskReport: taskReportSchema,
  reviewResult: reviewSchema,
  humanGate: gateSchema
})

const codexTimeout = Number(env.SMITHERS_AGENT_TIMEOUT_MS ?? env.SMITERS_AGENT_TIMEOUT_MS ?? 1800000)

const implementerAgent =
  agentKind === "claude"
    ? new ClaudeCodeAgent({
        model,
        dangerouslySkipPermissions: true,
        outputFormat: "json",
        timeoutMs: Number.isFinite(codexTimeout) ? codexTimeout : 1800000
      })
    : new CodexAgent({
        model,
        dangerouslyBypassApprovalsAndSandbox: true,
        skipGitRepoCheck: true,
        json: true,
        timeoutMs: Number.isFinite(codexTimeout) ? codexTimeout : 1800000
      })

const reviewerAgent =
  reviewAgentKind === "claude"
    ? new ClaudeCodeAgent({
        model,
        dangerouslySkipPermissions: true,
        outputFormat: "json",
        timeoutMs: Number.isFinite(codexTimeout) ? codexTimeout : 1800000
      })
    : new CodexAgent({
        model,
        dangerouslyBypassApprovalsAndSandbox: true,
        skipGitRepoCheck: true,
        json: true,
        timeoutMs: Number.isFinite(codexTimeout) ? codexTimeout : 1800000
      })

const taskNodeId = (index: number, task: TodoTask) => `task-${index + 1}-${task.id}`
const taskReportFile = (task: TodoTask) => join(reportDir, `${task.id}.report.json`)
const reviewNodeId = (reviewer: Reviewer) => `review-${reviewer.id}`
const reviewFile = (reviewer: Reviewer) => join(reportDir, `review-${reviewer.id}.json`)

const systemPrompt = [
  `Spec ID: ${spec.id}`,
  `Title: ${spec.title}`,
  runId ? `Run ID: ${runId}` : "",
  branchName ? `Branch: ${branchName}` : "",
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
]
  .filter(Boolean)
  .join("\n")

const parseReview = (raw: unknown) => {
  const parsed = reviewSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  return { v: 1 as const, status: "changes_requested" as const, issues: [], next: [] }
}

const persistArtifacts = (ctx: { latest: (table: string, nodeId: string) => any; iterationCount: (table: string, nodeId: string) => number }) => {
  mkdirSync(reportDir, { recursive: true })

  let allTasksDone = true
  let anyTaskBlockedOrFailed = false
  for (let i = 0; i < todo.tasks.length; i++) {
    const task = todo.tasks[i]!
    const row = ctx.latest("taskReport", taskNodeId(i, task))
    if (!row) {
      allTasksDone = false
      continue
    }
    writeFileSync(taskReportFile(task), `${JSON.stringify(row, null, 2)}\n`, "utf8")
    if (row.status !== "done") {
      anyTaskBlockedOrFailed = true
    }
  }

  let reviewApproved = false
  let reviewMaxReached = false

  if (runReview) {
    let allReviewersPresent = true
    const reviewRows = reviewers.map((reviewer) => {
      const row = ctx.latest("reviewResult", reviewNodeId(reviewer))
      if (!row) allReviewersPresent = false
      return { reviewer, row }
    })

    reviewRows.forEach(({ reviewer, row }) => {
      if (!row) return
      writeFileSync(reviewFile(reviewer), `${JSON.stringify({ ...row, reviewer: reviewer.id }, null, 2)}\n`, "utf8")
    })

    if (allReviewersPresent) {
      const normalized = reviewRows.map(({ row }) => parseReview(row))
      reviewApproved = normalized.every((row) => row.status === "approved")
      const issues = normalized.flatMap((row) => row.issues)
      const next = normalized.flatMap((row) => row.next)
      const combined = {
        v: 1 as const,
        status: reviewApproved ? ("approved" as const) : ("changes_requested" as const),
        issues,
        next
      }
      writeFileSync(join(reportDir, "review.json"), `${JSON.stringify(combined, null, 2)}\n`, "utf8")

      const attempts = Math.max(...reviewers.map((reviewer) => ctx.iterationCount("reviewResult", reviewNodeId(reviewer))))
      reviewMaxReached = attempts >= reviewMax
      if (reviewApproved || reviewMaxReached) {
        const reason = reviewApproved
          ? "Human review required before next spec run."
          : "Reviewers requested changes. Max retries reached; human decision required."
        const gate = { v: 1 as const, status: "blocked" as const, reason }
        writeFileSync(join(reportDir, "human-gate.json"), `${JSON.stringify(gate, null, 2)}\n`, "utf8")
      }
    }
  }

  if (controlDir) {
    mkdirSync(controlDir, { recursive: true })
    const phase = !allTasksDone ? "tasks" : anyTaskBlockedOrFailed ? "done" : !runReview ? "done" : reviewApproved || reviewMaxReached ? "done" : "review"
    writeFileSync(
      join(controlDir, "phase.json"),
      `${JSON.stringify({ v: 1, ts: new Date().toISOString(), phase }, null, 2)}\n`,
      "utf8"
    )
  }
}

const taskPrompt = (task: TodoTask, index: number) => {
  const reportPath = taskReportFile(task)
  return [
    globalPrompt,
    systemPrompt,
    "",
    `Task ${index + 1}/${todo.tasks.length}: ${task.id}`,
    "",
    "Do:",
    task.do,
    "",
    "Verify:",
    task.verify,
    "",
    "Version control:",
    "- Use jj (not git).",
    "- Create a new change before work: `jj new master`.",
    "- Update the change description with `jj describe`.",
    branchName ? `- Push with: jj git push --bookmark ${branchName}` : "- Push with: jj git push --change @",
    "- If push fails, set status=blocked and include the error.",
    "",
    "Report artifacts:",
    `- Write the final JSON report to: ${reportPath}`,
    "",
    "Output:",
    "Return only JSON matching this schema exactly:",
    JSON.stringify(
      {
        v: 1,
        taskId: task.id,
        status: "done | blocked | failed",
        work: ["..."],
        files: ["..."],
        tests: ["..."],
        issues: ["..."],
        next: ["..."],
        rootCause: "...",
        reasoning: "...",
        fix: "...",
        error: "...",
        commit: "..."
      },
      null,
      2
    )
  ]
    .filter((line) => line !== "")
    .join("\n")
}

const reviewPrompt = (reviewer: Reviewer) => {
  const reportRows = todo.tasks
    .map((task, index) => ({ task, row: null as unknown }))
    .map(({ task }, index) => ({ task, reportPath: taskReportFile(task), index }))

  const reportsText = reportRows
    .map(({ task, reportPath }) => `${task.id}: ${reportPath}`)
    .join("\n")

  return [
    reviewerPrompt,
    reviewer.prompt,
    systemPrompt,
    "",
    `Reviewer: ${reviewer.title}`,
    "Review implementation strictly against spec and todo.",
    "Validate correctness, tests, safety, and whether VCS push happened.",
    "",
    "Task report files:",
    reportsText || "No report files listed.",
    "",
    "Report artifacts:",
    `- Write reviewer JSON file to: ${reviewFile(reviewer)}`,
    "",
    "Output:",
    "Return only JSON matching this schema exactly:",
    JSON.stringify(
      {
        v: 1,
        status: "approved | changes_requested",
        issues: ["..."],
        next: ["..."]
      },
      null,
      2
    )
  ]
    .filter((line) => line !== "")
    .join("\n")
}

const reviewFixPrompt = (ctx: { latest: (table: string, nodeId: string) => any }) => {
  const latestReviews = reviewers
    .map((reviewer) => ({ reviewer, row: parseReview(ctx.latest("reviewResult", reviewNodeId(reviewer))) }))
    .filter(({ row }) => row.status === "changes_requested")

  const items = latestReviews.flatMap(({ reviewer, row }) => {
    const issues = row.issues.map((issue) => `[${reviewer.title}] ${issue}`)
    const next = row.next.map((item) => `[${reviewer.title}] ${item}`)
    return [...issues, ...next]
  })

  return [
    globalPrompt,
    systemPrompt,
    "",
    "Review fix pass:",
    ...items.map((item) => `- ${item}`),
    "",
    "Do:",
    "Address reviewer feedback and update tests if needed.",
    "",
    "Version control:",
    "- Use jj (not git).",
    "- Create a new change before work: `jj new master`.",
    "- Update the change description with `jj describe`.",
    branchName ? `- Push with: jj git push --bookmark ${branchName}` : "- Push with: jj git push --change @",
    "",
    "Output:",
    "Return only JSON matching the task report schema."
  ]
    .filter((line) => line !== "")
    .join("\n")
}

export default smithers((ctx) => {
  persistArtifacts(ctx)

  const taskRows = todo.tasks.map((task, index) => ctx.latest("taskReport", taskNodeId(index, task)))
  const hasTaskFailure = taskRows.some((row) => row && row.status !== "done")
  const allTasksDone = taskRows.every((row) => Boolean(row))

  const reviewApproved =
    runReview &&
    reviewers.length > 0 &&
    reviewers.every((reviewer) => parseReview(ctx.latest("reviewResult", reviewNodeId(reviewer))).status === "approved")

  const reviewAttempts =
    runReview && reviewers.length > 0
      ? Math.max(...reviewers.map((reviewer) => ctx.iterationCount("reviewResult", reviewNodeId(reviewer))))
      : 0
  const reviewMaxReached = runReview && reviewAttempts >= reviewMax

  return (
    <Workflow name={`${spec.id}: ${spec.title}`}>
      <Sequence>
        {todo.tasks.map((task, index) => (
          <Task
            key={taskNodeId(index, task)}
            id={taskNodeId(index, task)}
            output="taskReport"
            agent={implementerAgent}
            retries={1}
          >
            {taskPrompt(task, index)}
          </Task>
        ))}

        <Ralph
          id="review-loop"
          until={!runReview || !allTasksDone || hasTaskFailure || reviewApproved || reviewMaxReached}
          maxIterations={Math.max(1, reviewMax)}
          onMaxReached="return-last"
          skipIf={!runReview || !allTasksDone || hasTaskFailure}
        >
          <Sequence>
            <Task
              id="review-fix"
              output="taskReport"
              agent={implementerAgent}
              skipIf={ctx.iteration === 0}
            >
              {reviewFixPrompt(ctx)}
            </Task>

            <Parallel>
              {reviewers.map((reviewer) => (
                <Task
                  key={reviewNodeId(reviewer)}
                  id={reviewNodeId(reviewer)}
                  output="reviewResult"
                  agent={reviewerAgent}
                  retries={1}
                >
                  {reviewPrompt(reviewer)}
                </Task>
              ))}
            </Parallel>
          </Sequence>
        </Ralph>

        <Task
          id="human-gate"
          output="humanGate"
          skipIf={!runReview || (!reviewApproved && !reviewMaxReached)}
        >
          {{
            v: 1,
            status: "blocked",
            reason: reviewApproved
              ? "Human review required before next spec run."
              : "Reviewers requested changes. Max retries reached; human decision required."
          }}
        </Task>
      </Sequence>
    </Workflow>
  )
})
