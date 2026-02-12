/** @jsxImportSource smithers-orchestrator */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createSmithers, CodexAgent, ClaudeCodeAgent, Sequence, Task } from "smithers-orchestrator"
import { z } from "zod"

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
const specPath = resolve(env.SMITHERS_SPEC_PATH ?? env.SPEC_PATH ?? "specs/000-base.min.json")
const reportDir = resolve(env.SMITHERS_REPORT_DIR ?? env.REPORT_DIR ?? "reports")
const reviewPromptPath = env.SMITHERS_REVIEW_PROMPT_PATH

const agentKind = (env.SMITHERS_AGENT ?? env.RALPH_AGENT ?? "codex").toLowerCase()
const model =
  env.SMITHERS_MODEL ??
  env.MODEL ??
  (agentKind === "codex" ? "gpt-5.2-codex" : "opus")

const loadPrompt = (path?: string) => {
  if (!path) return ""
  try {
    if (!existsSync(path)) return ""
    return readFileSync(path, "utf8").trim()
  } catch {
    return ""
  }
}

const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec
const reviewerPrompt = loadPrompt(reviewPromptPath)

const reviewSchema = z.object({
  v: z.literal(1),
  status: z.enum(["approved", "changes_requested"]),
  issues: z.array(z.string()),
  next: z.array(z.string())
})

const { Workflow, smithers } = createSmithers({
  reviewResult: reviewSchema
})

const timeoutMs = Number(env.SMITHERS_AGENT_TIMEOUT_MS ?? env.SMITERS_AGENT_TIMEOUT_MS ?? 1800000)

const reviewerAgent =
  agentKind === "claude"
    ? new ClaudeCodeAgent({
        model,
        dangerouslySkipPermissions: true,
        outputFormat: "json",
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 1800000
      })
    : new CodexAgent({
        model,
        dangerouslyBypassApprovalsAndSandbox: true,
        skipGitRepoCheck: true,
        json: true,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 1800000
      })

const reportsText = () => {
  try {
    const files = readdirSync(reportDir).filter((name) => name.endsWith(".report.json")).sort()
    if (!files.length) return "No reports found."
    return files
      .slice(0, 30)
      .map((name) => `${name}:\n${readFileSync(join(reportDir, name), "utf8")}`)
      .join("\n\n")
  } catch {
    return "No reports found."
  }
}

const prompt = [
  reviewerPrompt,
  `Spec ID: ${spec.id}`,
  `Title: ${spec.title}`,
  "",
  "Review the implementation against the spec and task reports.",
  "Focus on correctness, tests, security, and strict spec compliance.",
  "",
  "Reports:",
  reportsText(),
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

export default smithers((ctx) => {
  const review = ctx.latest("reviewResult", "review")

  if (review) {
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(join(reportDir, "review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8")
  }

  return (
    <Workflow name={`${spec.id}: reviewer`}>
      <Sequence>
        <Task id="review" output="reviewResult" agent={reviewerAgent} retries={1} skipIf={Boolean(review)}>
          {prompt}
        </Task>
      </Sequence>
    </Workflow>
  )
})
