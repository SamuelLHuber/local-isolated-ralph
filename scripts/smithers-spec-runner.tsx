#!/usr/bin/env smithers
/** @jsxImportSource smithers-orchestrator */
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { useEffect } from "react"
import { basename, join, resolve } from "node:path"
import * as Orchestrator from "smithers-orchestrator"

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

type Report = {
  v: number
  taskId: string
  status: "done" | "blocked" | "failed"
  work: string[]
  files: string[]
  tests: string[]
  issues: string[]
  next: string[]
  rootCause: string
  reasoning: string
  fix: string
  error: string
  commit: string
}

type Review = {
  v: number
  status: "approved" | "changes_requested"
  issues: string[]
  next: string[]
}

type HumanGate = {
  v: number
  status: "blocked"
  reason: string
}

type ReviewTask = {
  id: string
  do: string
  verify: string
}

const {
  createSmithersRoot,
  createSmithersDB,
  SmithersProvider,
  Ralph,
  useRalphIteration,
  Claude,
  Codex,
  If,
  useSmithers,
  useQueryValue
} = Orchestrator

const OpenCodeComponent = Orchestrator.OpenCode ?? Codex

const env = process.env
const specPath = resolve(env.SMITHERS_SPEC_PATH ?? env.SPEC_PATH ?? "specs/000-base.min.json")
const todoPath = resolve(env.SMITHERS_TODO_PATH ?? env.TODO_PATH ?? "specs/000-base.todo.min.json")
const reportDir = resolve(env.SMITHERS_REPORT_DIR ?? env.REPORT_DIR ?? "reports")
const promptPath = env.SMITHERS_PROMPT_PATH
const reviewPromptPath = env.SMITHERS_REVIEW_PROMPT_PATH
const reviewersDir = env.SMITHERS_REVIEWERS_DIR
const reviewModelsPath = env.SMITHERS_REVIEW_MODELS_FILE
const execCwd = env.SMITHERS_CWD ? resolve(env.SMITHERS_CWD) : process.cwd()
const runId = env.SMITHERS_RUN_ID ?? ""
const branchName = env.SMITHERS_BRANCH ?? ""
const workflowShaExpected = env.SMITHERS_WORKFLOW_SHA ?? ""
  const agentKind = (env.SMITHERS_AGENT ?? env.RALPH_AGENT ?? "codex").toLowerCase()
  const reviewAgentKind = "codex"
const model =
  env.SMITHERS_MODEL ??
  env.MODEL ??
  (agentKind === "codex" ? "gpt-5.2-codex" : "opus")
const maxIterations = Number(env.SMITHERS_MAX_ITERATIONS ?? env.MAX_ITERATIONS ?? 100)
const runReview = true
const reviewMax = Number(env.SMITHERS_REVIEW_MAX ?? 2)

if (!Orchestrator.OpenCode && agentKind === "opencode") {
  console.log("[WARN] OpenCode export missing; falling back to Codex for opencode.")
}

const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec
const todo = JSON.parse(readFileSync(todoPath, "utf8")) as Todo
const specId = spec.id ?? ""

const workflowPath = process.argv[1]
const workflowShaActual = (() => {
  try {
    const data = readFileSync(workflowPath)
    return createHash("sha256").update(data).digest("hex")
  } catch {
    return ""
  }
})()

const smithersDir = resolve(".smithers")
if (!existsSync(smithersDir)) {
  mkdirSync(smithersDir, { recursive: true })
}
const db = createSmithersDB({ path: join(smithersDir, `${spec.id}.db`) })
const executionId = db.execution.start(`${spec.id}: ${spec.title}`, basename(specPath))

if (!existsSync(reportDir)) {
  mkdirSync(reportDir, { recursive: true })
}

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

const loadReviewModels = (): Record<string, string> => {
  if (!reviewModelsPath) return {}
  try {
    if (!existsSync(reviewModelsPath)) return {}
    const raw = readFileSync(reviewModelsPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        map[key.toLowerCase()] = value
      }
    }
    return map
  } catch {
    return {}
  }
}

const reviewModels = loadReviewModels()
const reviewDefaultModel =
  reviewModels._default ?? reviewModels.default ?? reviewModels["*"] ?? model

const reviewModelFor = (id: string) =>
  reviewModels[id.toLowerCase()] ?? reviewDefaultModel

const runJj = (args: string[]) => {
  const result = spawnSync("jj", args, { cwd: execCwd, encoding: "utf8" })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  return { ok: result.status === 0, output }
}

const pushBookmark = (branch: string) => {
  if (!branch) return
  const first = runJj(["git", "push", "--bookmark", branch])
  if (first.ok) return
  if (first.output.includes("Refusing to create new remote bookmark")) {
    runJj(["bookmark", "track", branch, "--remote=origin"])
    const second = runJj(["git", "push", "--bookmark", branch])
    if (second.ok) return
    console.log(`[WARN] Failed to push JJ bookmark ${branch}: ${second.output || "unknown error"}`)
    return
  }
  console.log(`[WARN] Failed to push JJ bookmark ${branch}: ${first.output || "unknown error"}`)
}

const hasWorkingChanges = () => {
  const result = runJj(["diff", "--stat"])
  return result.ok && result.output.trim().length > 0
}

const composeCommitMessage = (taskId: string, report: Report) => {
  const subject = `feat(spec-${specId}): ${taskId}`
  const why = report.reasoning || report.rootCause || "No root cause provided."
  const fix = report.fix || "No fix summary provided."
  const work = report.work?.length ? report.work.map((item) => `- ${item}`).join("\n") : "- No work items reported."
  const trailers = [
    specId ? `[spec:${specId}]` : "",
    taskId ? `[todo:${taskId}]` : "",
    runId ? `[run:${runId}]` : ""
  ].filter(Boolean).join(" ")

  return [
    subject,
    "",
    "Why:",
    why,
    "",
    "Fix:",
    fix,
    "",
    "Work:",
    work,
    "",
    trailers
  ].join("\n").trim()
}

const codexTimeout = Number(env.SMITHERS_AGENT_TIMEOUT_MS ?? env.SMITERS_AGENT_TIMEOUT_MS ?? 1800000)
const codexDefaults = {
  reasoningEffort: "medium",
  sandboxMode: "danger-full-access",
  skipGitRepoCheck: true,
  json: true,
  timeout: Number.isFinite(codexTimeout) ? codexTimeout : 1800000
} as const

type Reviewer = {
  id: string
  title: string
  prompt: string
}

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

type ReviewResult = Review & { reviewer: string }

const writeReviewerResult = (reviewerId: string, review: Review) => {
  const payload: ReviewResult = { ...review, reviewer: reviewerId }
  const path = join(reportDir, `review-${reviewerId}.json`)
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
}

const combineReviews = (): Review => {
  const reviews: Review[] = []
  for (const reviewer of reviewers) {
    const path = join(reportDir, `review-${reviewer.id}.json`)
    if (!existsSync(path)) continue
    try {
      const raw = readFileSync(path, "utf8")
      reviews.push(JSON.parse(raw) as Review)
    } catch {
      continue
    }
  }
  const issues = reviews.flatMap((r) => r.issues ?? [])
  const next = reviews.flatMap((r) => r.next ?? [])
  const status = reviews.every((r) => r.status === "approved") ? "approved" : "changes_requested"
  return { v: 1, status, issues, next }
}

const buildReviewTasks = (): ReviewTask[] => {
  const tasks: ReviewTask[] = []
  for (const reviewer of reviewers) {
    const path = join(reportDir, `review-${reviewer.id}.json`)
    if (!existsSync(path)) continue
    try {
      const raw = readFileSync(path, "utf8")
      const review = JSON.parse(raw) as Review
      const items = [...(review.issues ?? []), ...(review.next ?? [])].filter(Boolean)
      items.forEach((item, index) => {
        tasks.push({
          id: `review-${reviewer.id}-${index + 1}`,
          do: `[${reviewer.title}] ${item}`,
          verify: "Update code/tests and verify relevant tests pass."
        })
      })
    } catch {
      continue
    }
  }
  return tasks
}

const defaultReport = (taskId: string, status: Report["status"]): Report => ({
  v: 1,
  taskId,
  status,
  work: [],
  files: [],
  tests: [],
  issues: [],
  next: [],
  rootCause: "",
  reasoning: "",
  fix: "",
  error: "",
  commit: ""
})

const parseReport = (taskId: string, output?: string): Report => {
  if (!output) {
    return defaultReport(taskId, "failed")
  }
  const match = output.match(/\{[\s\S]*\}/)
  if (!match) {
    return defaultReport(taskId, "failed")
  }
  try {
    const parsed = JSON.parse(match[0]) as Report
    if (!parsed.taskId) parsed.taskId = taskId
    if (!parsed.status) parsed.status = "failed"
    if (!parsed.work) parsed.work = []
    if (!parsed.files) parsed.files = []
    if (!parsed.tests) parsed.tests = []
    if (!parsed.issues) parsed.issues = []
    if (!parsed.next) parsed.next = []
    if (!parsed.rootCause) parsed.rootCause = ""
    if (!parsed.reasoning) parsed.reasoning = ""
    if (!parsed.fix) parsed.fix = ""
    if (!parsed.error) parsed.error = ""
    if (!parsed.commit) parsed.commit = ""
    if (parsed.v !== 1) parsed.v = 1
    return parsed
  } catch {
    return defaultReport(taskId, "failed")
  }
}

const writeReport = (report: Report) => {
  const path = join(reportDir, `${report.taskId}.report.json`)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

const defaultReview = (status: Review["status"]): Review => ({
  v: 1,
  status,
  issues: [],
  next: []
})

const isRateLimitError = (output?: string) => {
  if (!output) return false
  const haystack = output.toLowerCase()
  return (
    haystack.includes("usage_limit_reached") ||
    haystack.includes("rate limit") ||
    haystack.includes("http 429") ||
    haystack.includes("too many requests")
  )
}

const computeBackoffMs = (attempt: number) => {
  if (attempt === 0) return 60 * 60 * 1000
  if (attempt === 1) return 2 * 60 * 60 * 1000
  if (attempt === 2) return 3 * 60 * 60 * 1000
  return 0
}

const formatBackoffLabel = (attempt: number) => {
  if (attempt === 0) return "1 hour"
  if (attempt === 1) return "2 hours"
  if (attempt === 2) return "3 hours"
  return "no further retries"
}

const parseReview = (output?: string): Review => {
  if (!output) {
    return defaultReview("changes_requested")
  }
  const match = output.match(/\{[\s\S]*\}/)
  if (!match) {
    return defaultReview("changes_requested")
  }
  try {
    const parsed = JSON.parse(match[0]) as Review
    if (!parsed.status) parsed.status = "changes_requested"
    if (!parsed.issues) parsed.issues = []
    if (!parsed.next) parsed.next = []
    if (parsed.v !== 1) parsed.v = 1
    return parsed
  } catch {
    return defaultReview("changes_requested")
  }
}

const writeReview = (review: Review) => {
  const path = join(reportDir, "review.json")
  writeFileSync(path, `${JSON.stringify(review, null, 2)}\n`, "utf8")
}

const writeHumanGate = (reason: string) => {
  const gate: HumanGate = { v: 1, status: "blocked", reason }
  const path = join(reportDir, "human-gate.json")
  writeFileSync(path, `${JSON.stringify(gate, null, 2)}\n`, "utf8")
}

const reviewTimeoutMs = Number(env.SMITHERS_REVIEW_TIMEOUT_MS ?? 1800000)

const writeReviewTodo = (tasks: ReviewTask[]) => {
  const path = join(reportDir, "review-todo.json")
  writeFileSync(path, `${JSON.stringify({ v: 1, tasks }, null, 2)}\n`, "utf8")
}

const readReviewTodo = (): ReviewTask[] => {
  const path = join(reportDir, "review-todo.json")
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, "utf8")
    const json = JSON.parse(raw) as { tasks?: ReviewTask[] }
    return Array.isArray(json.tasks) ? json.tasks : []
  } catch {
    return []
  }
}

const readReports = (): string => {
  try {
    if (!existsSync(reportDir)) return "No reports found."
    const entries = readFileSync(join(reportDir, ".index"), "utf8")
    return entries
  } catch {
    try {
      const files = readdirSync(reportDir)
      const reportFiles = files.filter((f) => f.endsWith(".report.json"))
      const summaries = reportFiles.slice(0, 20).map((f) => {
        const raw = readFileSync(join(reportDir, f), "utf8")
        return `${f}:\n${raw}`
      })
      return summaries.length > 0 ? summaries.join("\n\n") : "No reports found."
    } catch {
      return "No reports found."
    }
  }
}

function TaskRunner() {
  const { db, reactiveDb } = useSmithers()
  const ralph = useRalphIteration()
  const decodeStateString = (value?: string) => {
    if (!value) return value
    const trimmed = value.trim()
    if (!trimmed) return value
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === "string" ? parsed : value
    } catch {
      return value
    }
  }
  const { data: indexRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'task.index'"
  )
  const { data: doneRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'task.done'"
  )
  const { data: phaseRaw } = useQueryValue<string>(
    reactiveDb,
    "SELECT value FROM state WHERE key = 'phase'"
  )
  const { data: reviewRetryRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'review.retry'"
  )
  const { data: reviewTaskIndexRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'review.task.index'"
  )
  const { data: reviewTransitionRaw } = useQueryValue<string>(
    reactiveDb,
    "SELECT value FROM state WHERE key = 'review.transition'",
    []
  )
  const { data: reviewTasksTransitionRaw } = useQueryValue<string>(
    reactiveDb,
    "SELECT value FROM state WHERE key = 'review.tasks.transition'",
    []
  )
  const { data: reviewTickRaw } = useQueryValue<string>(
    reactiveDb,
    "SELECT value FROM state WHERE key = 'review.tick'",
    []
  )
  const { data: rateLimitCountRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'rate.limit.count'",
    []
  )
  const { data: rateLimitUntilRaw } = useQueryValue<string>(
    reactiveDb,
    "SELECT value FROM state WHERE key = 'rate.limit.until'",
    []
  )
  const { data: usageInputRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'usage.input'",
    []
  )
  const { data: usageOutputRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'usage.output'",
    []
  )
  const { data: usageTotalRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'usage.total'",
    []
  )
  const { data: usageTaskInputRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'usage.task.input'",
    []
  )
  const { data: usageTaskOutputRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'usage.task.output'",
    []
  )
  const { data: usageTaskTotalRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'usage.task.total'",
    []
  )
  const { data: usageReviewInputRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'usage.review.input'",
    []
  )
  const { data: usageReviewOutputRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'usage.review.output'",
    []
  )
  const { data: usageReviewTotalRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'usage.review.total'",
    []
  )
  const index = indexRaw ?? 0
  const done = Boolean(doneRaw ?? 0)
  const phase = decodeStateString(phaseRaw) ?? "tasks"
  const reviewRetry = reviewRetryRaw ?? 0
  const reviewTaskIndex = reviewTaskIndexRaw ?? 0
  const reviewTransition = decodeStateString(reviewTransitionRaw) ?? ""
  const reviewTasksTransition = decodeStateString(reviewTasksTransitionRaw) ?? ""
  const reviewTick = decodeStateString(reviewTickRaw) ?? ""
  const rateLimitCount = rateLimitCountRaw ?? 0
  const rateLimitUntil = decodeStateString(rateLimitUntilRaw)
  const usageInput = usageInputRaw ?? 0
  const usageOutput = usageOutputRaw ?? 0
  const usageTotal = usageTotalRaw ?? 0
  const usageTaskInput = usageTaskInputRaw ?? 0
  const usageTaskOutput = usageTaskOutputRaw ?? 0
  const usageTaskTotal = usageTaskTotalRaw ?? 0
  const usageReviewInput = usageReviewInputRaw ?? 0
  const usageReviewOutput = usageReviewOutputRaw ?? 0
  const usageReviewTotal = usageReviewTotalRaw ?? 0

  const bumpUsage = (kind: "task" | "review", result: { tokensUsed?: { input?: number; output?: number } }) => {
    const inputTokens = result.tokensUsed?.input ?? 0
    const outputTokens = result.tokensUsed?.output ?? 0
    if (inputTokens === 0 && outputTokens === 0) return
    const totalTokens = inputTokens + outputTokens
    db.state.set("usage.input", usageInput + inputTokens, "usage")
    db.state.set("usage.output", usageOutput + outputTokens, "usage")
    db.state.set("usage.total", usageTotal + totalTokens, "usage")
    if (kind === "task") {
      db.state.set("usage.task.input", usageTaskInput + inputTokens, "usage")
      db.state.set("usage.task.output", usageTaskOutput + outputTokens, "usage")
      db.state.set("usage.task.total", usageTaskTotal + totalTokens, "usage")
    } else {
      db.state.set("usage.review.input", usageReviewInput + inputTokens, "usage")
      db.state.set("usage.review.output", usageReviewOutput + outputTokens, "usage")
      db.state.set("usage.review.total", usageReviewTotal + totalTokens, "usage")
    }
  }
  const reviewStarted = useQueryValue<string>(
    reactiveDb,
    "SELECT value FROM state WHERE key = 'review.started_at'",
    []
  ).data

  const allReviewsComplete = () =>
    reviewers.every((reviewer) => existsSync(join(reportDir, `review-${reviewer.id}.json`)))

  useEffect(() => {
    if (phase !== "review") return
    if (reviewTransition) return
    if (!allReviewsComplete()) return
    const combined = combineReviews()
    if (combined.status === "approved") {
      writeReview(combined)
      writeHumanGate("Human review required before next spec run.")
      db.state.set("phase", "done", "review_done")
      db.state.set("task.done", 1, "review_done")
      db.state.set("review.transition", "done", "review_transition")
      return
    }

    if (reviewRetry >= reviewMax) {
      writeReview(combined)
      writeHumanGate("Reviewers requested changes. Max retries reached; human decision required.")
      db.state.set("phase", "done", "review_done")
      db.state.set("task.done", 1, "review_done")
      db.state.set("review.transition", "done", "review_transition")
      return
    }

    const reviewTasks = buildReviewTasks()
    writeReviewTodo(reviewTasks)
    db.state.set("review.retry", reviewRetry + 1, "review_retry")
    db.state.set("review.task.index", 0, "review_task_start")
    db.state.set("phase", "review-tasks", "review_task_start")
    db.state.set("review.transition", "review-tasks", "review_transition")
  }, [phase, reviewRetry, reviewTransition, reviewTick])

  useEffect(() => {
    if (phase !== "review-tasks") return
    if (reviewTasksTransition) return
    const reviewTasks = readReviewTodo()
    if (reviewTasks.length === 0) {
      writeHumanGate("Reviewer changes requested but no tasks were generated. Human decision required.")
      db.state.set("phase", "done", "review_done")
      db.state.set("task.done", 1, "review_done")
      db.state.set("review.tasks.transition", "done", "review_tasks_transition")
      return
    }
    const task = reviewTasks[reviewTaskIndex]
    if (!task) {
      db.state.set("phase", "review", "review_restart")
      db.state.set("review.index", 0, "review_restart")
      db.state.set("review.tasks.transition", "restart", "review_tasks_transition")
    }
  }, [phase, reviewTaskIndex, reviewTasksTransition])

  useEffect(() => {
    if (!workflowShaExpected || !workflowShaActual) return
    if (workflowShaExpected !== workflowShaActual) {
      writeHumanGate("Workflow SHA mismatch; re-copy smithers-spec-runner.tsx and resume.")
      db.state.set("task.blocked", 1, "workflow_sha_mismatch")
      db.state.set("task.done", 1, "workflow_sha_mismatch")
      db.state.set("phase", "done", "workflow_sha_mismatch")
    }
  }, [workflowShaExpected, workflowShaActual])

  useEffect(() => {
    if (!rateLimitUntil) return
    const until = Date.parse(rateLimitUntil)
    if (!Number.isFinite(until)) return
    if (Date.now() < until) return
    db.state.set("rate.limit.until", "", "rate_limit_clear")
  }, [rateLimitUntil])

  useEffect(() => {
    if (phase !== "review") return
    if (!reviewStarted) {
      db.state.set("review.started_at", new Date().toISOString(), "review_started")
      return
    }
    const elapsed = Date.now() - Date.parse(reviewStarted)
    if (Number.isFinite(reviewTimeoutMs) && elapsed > reviewTimeoutMs) {
      writeHumanGate("Review timeout exceeded; no review outputs produced.")
      db.state.set("task.blocked", 1, "review_timeout")
      db.state.set("task.done", 1, "review_timeout")
      db.state.set("phase", "done", "review_timeout")
    }
  }, [phase, reviewStarted])

  if (phase === "review") {
    if (allReviewsComplete()) {
      return <review status="pending" />
    }
    if (rateLimitUntil) {
      return <review status="rate-limited" />
    }
    return (
      <review status="running">
        <Orchestrator.Parallel>
          {reviewers.map((reviewer) => {
            if (existsSync(join(reportDir, `review-${reviewer.id}.json`))) {
              return <reviewer-node key={reviewer.id} />
            }
            const prompt = [
              reviewerPrompt,
              reviewer.prompt,
              systemPrompt,
              "",
              `Reviewer: ${reviewer.title}`,
              "Review the implementation against the spec, todo, and task reports.",
              "Focus on correctness, tests, security, and strict spec compliance.",
              "Verify changes were pushed (jj git push --change @) if applicable.",
              "",
              "Reports:",
              readReports(),
              "",
              "Output:",
              "Return a single JSON object that matches this schema:",
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
            const handleReviewFinished = (result: { output?: string }) => {
              if (isRateLimitError(result.output)) {
                const delayMs = computeBackoffMs(rateLimitCount)
                const until = new Date(Date.now() + delayMs).toISOString()
                const label = formatBackoffLabel(rateLimitCount)
                writeHumanGate(`Rate limit hit during review. Backoff: ${label}. Resume after ${until}.`)
                db.state.set("rate.limit.count", rateLimitCount + 1, "rate_limit")
                if (delayMs > 0) {
                  db.state.set("rate.limit.until", until, "rate_limit")
                }
                db.state.set("task.blocked", 1, "rate_limit")
                db.state.set("task.done", 1, "rate_limit")
                db.state.set("phase", "done", "rate_limit")
                return
              }
              const review = parseReview(result.output)
              writeReviewerResult(reviewer.id, review)
              bumpUsage("review", result)
              db.state.set("review.tick", new Date().toISOString(), "review_tick")
              ralph?.signalComplete()
            }
            const defaultProps = { onFinished: handleReviewFinished } as const
            const codexProps = {
              ...defaultProps,
              model: reviewModelFor(reviewer.id),
              ...codexDefaults,
              cwd: execCwd
            } as const
            return (
              <reviewer-node key={reviewer.id}>
                <If condition={reviewAgentKind === "codex"}>
                  <Codex {...codexProps}>{prompt}</Codex>
                </If>
              </reviewer-node>
            )
          })}
        </Orchestrator.Parallel>
      </review>
    )
  }

  if (phase === "review-tasks") {
    const reviewTasks = readReviewTodo()
    if (reviewTasks.length === 0) {
      return <review status="review-tasks-empty" />
    }

    const task = reviewTasks[reviewTaskIndex]
    if (!task) {
      return <review status="review-restart" />
    }

const prompt = [
      globalPrompt,
      systemPrompt,
      "",
      `Review Task ${reviewTaskIndex + 1}/${reviewTasks.length}: ${task.id}`,
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
      "- Note: The working copy may already include changes from earlier tasks in this run. Treat those as expected and continue unless they are clearly unrelated.",
      "- Update the change description with `jj describe`.",
      branchName ? `- Use this branch/bookmark for all pushes: ${branchName}` : "- Use a single branch/bookmark for all pushes.",
      branchName
        ? `- Push with: jj git push --bookmark ${branchName}`
        : "- Push with: jj git push --change @",
      branchName
        ? `- If push refuses to create a remote bookmark, run: jj bookmark track ${branchName} --remote=origin`
        : "- If push refuses to create a remote bookmark, run: jj bookmark track <branch> --remote=origin",
      "- Commit messages must follow Conventional Commits (type(scope): subject).",
      "- Commit message must include spec + todo context and run id.",
      "- For root-cause fixes, include cause → reasoning → fix and relevant error output.",
      "- Avoid literal \\n; use a multi-line body via here-doc or printf.",
      "- Example (jj): jj describe -m \"$(cat <<'EOF'\n<subject>\n\n<trailers>\nEOF\n)\"",
      "- Example: feat(spec-020-fabrik-v0-2-0): implement dispatch auth [todo:git-credentials-vm] [spec:020-fabrik-v0-2-0] [run:20260203T120945Z]",
      "",
      "Output:",
      "Return a single JSON object that matches this schema:",
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

    const handleFinished = (result: { output?: string }) => {
      const report = parseReport(task.id, result.output)
      writeReport(report)

      if (report.status !== "done") {
        db.state.set("task.done", 1, "review_task_failed")
        db.state.set("phase", "done", "review_task_failed")
        ralph?.signalComplete()
        return
      }

      if (!hasWorkingChanges()) {
        report.commit = "no-op"
        report.work = [...report.work, "No working copy changes detected; skipped describe/push."]
        writeReport(report)
        db.state.set("review.task.index", reviewTaskIndex + 1, "review_task_advance")
        ralph?.signalComplete()
        return
      }

      const commitMessage = report.commit || composeCommitMessage(task.id, report)
      report.commit = commitMessage
      const describeResult = runJj(["describe", "-m", commitMessage])
      if (!describeResult.ok) {
        report.status = "blocked"
        report.error = `jj describe failed: ${describeResult.output || "unknown error"}`
        report.rootCause = "Failed to set commit message"
        report.reasoning = "JJ describe must succeed before push."
        report.fix = "Resolve JJ error and retry."
        writeReport(report)
        db.state.set("task.blocked", 1, "commit_describe_failed")
        db.state.set("task.done", 1, "commit_describe_failed")
        db.state.set("phase", "done", "commit_describe_failed")
        ralph?.signalComplete()
        return
      }

      pushBookmark(branchName)
      db.state.set("review.task.index", reviewTaskIndex + 1, "review_task_advance")
      ralph?.signalComplete()
    }

    const defaultProps = { onFinished: handleFinished } as const
    const claudeProps = { ...defaultProps, model } as const
    const codexProps = { ...defaultProps, model, ...codexDefaults, cwd: execCwd } as const
    const openCodeProps = { ...defaultProps, model } as const

    return (
      <review-task id={task.id} index={reviewTaskIndex}>
        <If condition={agentKind === "claude"}>
          <Claude {...claudeProps}>{prompt}</Claude>
        </If>
        <If condition={agentKind === "codex"}>
          <Codex {...codexProps}>{prompt}</Codex>
        </If>
        <If condition={agentKind === "opencode"}>
          <OpenCodeComponent {...openCodeProps}>{prompt}</OpenCodeComponent>
        </If>
      </review-task>
    )
  }

  useEffect(() => {
    if (done) return
    if (index < todo.tasks.length) return
    db.state.set("task.done", 1, "complete")
    if (runReview && phase !== "review") {
      db.state.set("phase", "review", "review_start")
      return
    }
    if (!runReview && phase !== "done") {
      db.state.set("phase", "done", "complete")
    }
  }, [done, index, phase])

  if (done || index >= todo.tasks.length) {
    if (runReview) {
      return <review status="pending" />
    }
    return <done status="complete" />
  }

  const task = todo.tasks[index]
  const prompt = [
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
    "- Note: The working copy may already include changes from earlier tasks in this run. Treat those as expected and continue unless they are clearly unrelated.",
    "- Update the change description with `jj describe`.",
    branchName ? `- Use this branch/bookmark for all pushes: ${branchName}` : "- Use a single branch/bookmark for all pushes.",
    branchName
      ? `- Push with: jj git push --bookmark ${branchName}`
      : "- Push with: jj git push --change @",
    branchName
      ? `- If push refuses to create a remote bookmark, run: jj bookmark track ${branchName} --remote=origin`
      : "- If push refuses to create a remote bookmark, run: jj bookmark track <branch> --remote=origin",
    "- Commit messages must follow Conventional Commits (type(scope): subject).",
    "- Commit message must include spec + todo context and run id.",
    "- For root-cause fixes, include cause → reasoning → fix and relevant error output.",
    "- Avoid literal \\n; use a multi-line body via here-doc or printf.",
    "- Example (jj): jj describe -m \"$(cat <<'EOF'\n<subject>\n\n<trailers>\nEOF\n)\"",
    "- Example: feat(spec-020-fabrik-v0-2-0): implement dispatch auth [todo:git-credentials-vm] [spec:020-fabrik-v0-2-0] [run:20260203T120945Z]",
    "",
    "Output:",
    "Return a single JSON object that matches this schema:",
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

  const handleFinished = (result: { output?: string }) => {
    if (isRateLimitError(result.output)) {
      const delayMs = computeBackoffMs(rateLimitCount)
      const until = new Date(Date.now() + delayMs).toISOString()
      const label = formatBackoffLabel(rateLimitCount)
      const report = defaultReport(task.id, "blocked")
      report.error = `Rate limit hit. Backoff: ${label}. Resume after ${until}.`
      report.rootCause = "Rate limit reached"
      report.reasoning = "Provider returned 429/usage_limit_reached during task execution."
      report.fix = "Wait for quota reset then resume the run."
      writeReport(report)
      writeHumanGate(`Rate limit hit. Backoff: ${label}. Resume after ${until}.`)
      db.state.set("rate.limit.count", rateLimitCount + 1, "rate_limit")
      if (delayMs > 0) {
        db.state.set("rate.limit.until", until, "rate_limit")
      }
      db.state.set("task.blocked", 1, "rate_limit")
      db.state.set("task.done", 1, "rate_limit")
      db.state.set("phase", "done", "rate_limit")
      ralph?.signalComplete()
      return
    }
    const report = parseReport(task.id, result.output)
    writeReport(report)
    bumpUsage("task", result)

    if (report.status === "blocked") {
      db.state.set("task.blocked", 1, "blocked")
      db.state.set("task.done", 1, "blocked")
      db.state.set("phase", "done", "blocked")
      ralph?.signalComplete()
      return
    }

    if (report.status === "failed") {
      db.state.set("task.failed", 1, "failed")
      db.state.set("task.done", 1, "failed")
      db.state.set("phase", "done", "failed")
      ralph?.signalComplete()
      return
    }

    if (!hasWorkingChanges()) {
      report.commit = "no-op"
      report.work = [...report.work, "No working copy changes detected; skipped describe/push."]
      writeReport(report)
      db.state.set("task.index", index + 1, "advance")
      if (index + 1 >= todo.tasks.length) {
        db.state.set("task.done", 1, "complete")
      }
      ralph?.signalComplete()
      return
    }

    const commitMessage = report.commit || composeCommitMessage(task.id, report)
    report.commit = commitMessage
    const describeResult = runJj(["describe", "-m", commitMessage])
    if (!describeResult.ok) {
      report.status = "blocked"
      report.error = `jj describe failed: ${describeResult.output || "unknown error"}`
      report.rootCause = "Failed to set commit message"
      report.reasoning = "JJ describe must succeed before push."
      report.fix = "Resolve JJ error and retry."
      writeReport(report)
      db.state.set("task.blocked", 1, "commit_describe_failed")
      db.state.set("task.done", 1, "commit_describe_failed")
      db.state.set("phase", "done", "commit_describe_failed")
      ralph?.signalComplete()
      return
    }

    pushBookmark(branchName)
    db.state.set("task.index", index + 1, "advance")
    if (index + 1 >= todo.tasks.length) {
      db.state.set("task.done", 1, "complete")
    }
    ralph?.signalComplete()
  }

  const defaultProps = { onFinished: handleFinished } as const
  const claudeProps = { ...defaultProps, model } as const
  const codexProps = { ...defaultProps, model, ...codexDefaults, cwd: execCwd } as const
  const openCodeProps = { ...defaultProps, model } as const

  return (
    <task id={task.id} index={index}>
      <If condition={agentKind === "claude"}>
        <Claude {...claudeProps}>{prompt}</Claude>
      </If>
      <If condition={agentKind === "codex"}>
        <Codex {...codexProps}>{prompt}</Codex>
      </If>
      <If condition={agentKind === "opencode"}>
        <OpenCodeComponent {...openCodeProps}>{prompt}</OpenCodeComponent>
      </If>
    </task>
  )
}

function SpecWorkflowInner() {
  const { reactiveDb } = useSmithers()
  const { data: doneRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'task.done'"
  )
  const { data: phaseRaw } = useQueryValue<string>(
    reactiveDb,
    "SELECT value FROM state WHERE key = 'phase'"
  )
  const decodeStateString = (value?: string) => {
    if (!value) return value
    const trimmed = value.trim()
    if (!trimmed) return value
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === "string" ? parsed : value
    } catch {
      return value
    }
  }
  const done = Boolean(doneRaw ?? 0)
  const phase = decodeStateString(phaseRaw) ?? "tasks"

  return (
    <Ralph id="spec-ralph" condition={() => !done || phase !== "done"} maxIterations={maxIterations}>
      <TaskRunner />
    </Ralph>
  )
}

function SpecWorkflow() {
  return (
    <SmithersProvider db={db} executionId={executionId}>
      <SpecWorkflowInner />
    </SmithersProvider>
  )
}

const root = createSmithersRoot()
try {
  await root.mount(SpecWorkflow)
  db.execution.complete(executionId, { summary: "Spec workflow complete" })
} catch (error) {
  db.execution.fail(executionId, String(error))
  throw error
} finally {
  db.close()
}
