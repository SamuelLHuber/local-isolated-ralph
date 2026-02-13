#!/usr/bin/env smithers
/** @jsxImportSource smithers-orchestrator */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { createSmithers, Sequence, PiAgent, CodexAgent, ClaudeCodeAgent } from "smithers-orchestrator"

type Spec = {
  id: string
  title: string
  goals: string[]
  nonGoals: string[]
  req: { api: string[]; behavior: string[]; obs: string[] }
  accept: string[]
  assume: string[]
}

const env = process.env
const specPath = resolve(env.SMITHERS_SPEC_PATH ?? env.SPEC_PATH ?? "specs/000-base.json")
const reportDir = resolve(env.SMITHERS_REPORT_DIR ?? env.REPORT_DIR ?? "reports")
const reviewPromptPath = env.SMITHERS_REVIEW_PROMPT_PATH
const execCwd = env.SMITHERS_CWD ? resolve(env.SMITHERS_CWD) : process.cwd()
const agentKind = (env.SMITHERS_AGENT ?? env.RALPH_AGENT ?? "pi").toLowerCase()
const modelOverride = env.SMITHERS_MODEL ?? env.MODEL
const providerOverride = env.SMITHERS_PROVIDER ?? env.PI_PROVIDER
const sourceDbPath = env.SMITHERS_SOURCE_DB_PATH ? resolve(env.SMITHERS_SOURCE_DB_PATH) : undefined

const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec

const dbPath = resolve(env.SMITHERS_DB_PATH ?? join(".smithers", `${spec.id}.review.db`))
if (!existsSync(dirname(dbPath))) {
  mkdirSync(dirname(dbPath), { recursive: true })
}
if (!existsSync(reportDir)) {
  mkdirSync(reportDir, { recursive: true })
}

const reviewSchema = z.object({
  v: z.number(),
  status: z.enum(["approved", "changes_requested"]),
  issues: z.array(z.string()),
  next: z.array(z.string())
})

const { Workflow, Task, smithers } = createSmithers({ reviewSummary: reviewSchema }, { dbPath })

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

const reviewSchemaExample = JSON.stringify(
  {
    v: 1,
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
    mode: "text",
    print: true,
    cwd: execCwd
  })
}

const reviewAgent = makeAgent(modelOverride)

const readReportSummary = () => {
  if (sourceDbPath && existsSync(sourceDbPath)) {
    try {
      const runId = env.SMITHERS_RUN_ID ?? ""
      const script = `
import json, os, sqlite3
path = "${sourceDbPath}"
run_id = "${runId}"
if not os.path.exists(path):
  print("No reports found.")
  raise SystemExit(0)
conn = sqlite3.connect(path)
try:
  if run_id:
    cur = conn.execute("SELECT task_id, status, issues, next FROM task_report WHERE run_id = ? ORDER BY node_id", (run_id,))
  else:
    cur = conn.execute("SELECT task_id, status, issues, next FROM task_report ORDER BY node_id")
  rows = cur.fetchall()
  if not rows:
    print("No reports found.")
  else:
    for row in rows:
      print(json.dumps({"taskId": row[0], "status": row[1], "issues": row[2], "next": row[3]}, indent=2))
except Exception:
  print("No reports found.")
finally:
  conn.close()
`
      const output = execFileSync("python3", ["-"], { input: script, encoding: "utf8" }).trim()
      return output || "No reports found."
    } catch {
      return "No reports found."
    }
  }

  try {
    const files = existsSync(reportDir) ? readdirSync(reportDir) : []
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

export default smithers(() => {
  const reportSummary = readReportSummary()

  return (
    <Workflow name="review-only">
      <Sequence>
        <Task id="review" output="reviewSummary" outputSchema={reviewSchema} agent={reviewAgent}>
          {[
            reviewerPrompt,
            systemPrompt,
            "",
            "Review the implementation against the spec, todo, and task reports.",
            "Focus on correctness, tests, security, and strict spec compliance.",
            "Verify changes were pushed (jj git push --change @) if applicable.",
            "",
            "Reports:",
            reportSummary,
            "",
            "Output:",
            "Return a single JSON object that matches this schema:",
            reviewSchemaExample
          ]
            .filter((line) => line !== "")
            .join("\n")}
        </Task>
      </Sequence>
    </Workflow>
  )
})
