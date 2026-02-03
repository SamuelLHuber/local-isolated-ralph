#!/usr/bin/env smithers
/** @jsxImportSource smithers-orchestrator */
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve, basename } from "node:path"
import * as Orchestrator from "smithers-orchestrator"

type Spec = {
  id: string
  title: string
  goals: string[]
  nonGoals: string[]
  req: { api: string[]; behavior: string[]; obs: string[] }
  accept: string[]
  assume: string[]
}

type Review = {
  v: number
  status: "approved" | "changes_requested"
  issues: string[]
  next: string[]
}

const {
  createSmithersRoot,
  createSmithersDB,
  SmithersProvider,
  Ralph,
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
const reviewPromptPath = env.SMITHERS_REVIEW_PROMPT_PATH
const agentKind = (env.SMITHERS_AGENT ?? env.RALPH_AGENT ?? "claude").toLowerCase()
const model =
  env.SMITHERS_MODEL ??
  env.MODEL ??
  (agentKind === "codex" ? "codex-5.2" : "opus")
const maxIterations = Number(env.SMITHERS_MAX_ITERATIONS ?? env.MAX_ITERATIONS ?? 3)

if (!Orchestrator.OpenCode && agentKind === "opencode") {
  console.log("[WARN] OpenCode export missing; falling back to Codex for opencode.")
}

const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec

const smithersDir = resolve(".smithers")
if (!existsSync(smithersDir)) {
  mkdirSync(smithersDir, { recursive: true })
}
const db = createSmithersDB({ path: join(smithersDir, `${spec.id}.review.db`) })
const executionId = db.execution.start(`${spec.id}: review`, basename(specPath))

if (!existsSync(reportDir)) {
  mkdirSync(reportDir, { recursive: true })
}

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
  ...spec.assume.map((a) => `- ${a}`)
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

const reviewerPrompt = loadPrompt(reviewPromptPath)

const codexDefaults = {
  reasoningEffort: "medium",
  sandboxMode: "danger-full-access",
  approvalPolicy: "never"
} as const

const readReports = (): string => {
  try {
    const files = readdirSync(reportDir)
    const reportFiles = files.filter((f) => f.endsWith(".report.json"))
    const summaries = reportFiles.slice(0, 30).map((f) => {
      const raw = readFileSync(join(reportDir, f), "utf8")
      return `${f}:\n${raw}`
    })
    return summaries.length > 0 ? summaries.join("\n\n") : "No reports found."
  } catch {
    return "No reports found."
  }
}

const defaultReview = (status: Review["status"]): Review => ({
  v: 1,
  status,
  issues: [],
  next: []
})

const parseReview = (output?: string): Review => {
  if (!output) return defaultReview("changes_requested")
  const match = output.match(/\{[\s\S]*\}/)
  if (!match) return defaultReview("changes_requested")
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

function ReviewRunner() {
  const { db, reactiveDb } = useSmithers()
  const { data: doneRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'review.done'"
  )
  const done = Boolean(doneRaw ?? 0)

  if (done) {
    return <done status="reviewed" />
  }

  const prompt = [
    reviewerPrompt,
    systemPrompt,
    "",
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

  const handleFinished = (result: { output?: string }) => {
    const review = parseReview(result.output)
    writeReview(review)
    db.state.set("review.done", 1, "review_done")
  }

  const defaultProps = { onFinished: handleFinished } as const
  const claudeProps = { ...defaultProps, model } as const
  const codexProps = { ...defaultProps, model, ...codexDefaults } as const
  const openCodeProps = { ...defaultProps, model } as const

  return (
    <review status="running">
      <If condition={agentKind === "claude"}>
        <Claude {...claudeProps}>{prompt}</Claude>
      </If>
      <If condition={agentKind === "codex"}>
        <Codex {...codexProps}>{prompt}</Codex>
      </If>
        <If condition={agentKind === "opencode"}>
          <OpenCodeComponent {...openCodeProps}>{prompt}</OpenCodeComponent>
        </If>
    </review>
  )
}

function ReviewWorkflowInner() {
  const { reactiveDb } = useSmithers()
  const { data: doneRaw } = useQueryValue<number>(
    reactiveDb,
    "SELECT CAST(value AS INTEGER) FROM state WHERE key = 'review.done'"
  )
  const done = Boolean(doneRaw ?? 0)

  return (
    <Ralph id="review" condition={() => !done} maxIterations={maxIterations}>
      <ReviewRunner />
    </Ralph>
  )
}

function ReviewWorkflow() {
  return (
    <SmithersProvider db={db} executionId={executionId}>
      <ReviewWorkflowInner />
    </SmithersProvider>
  )
}

const root = createSmithersRoot()
try {
  await root.mount(ReviewWorkflow)
  db.execution.complete(executionId, { summary: "Review complete" })
} catch (error) {
  db.execution.fail(executionId, String(error))
  throw error
} finally {
  db.close()
}
