import * as Command from "@effect/cli/Command"
import * as Options from "@effect/cli/Options"
import * as Effect from "effect/Effect"
import * as Console from "effect/Console"
import * as Option from "effect/Option"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { homedir } from "node:os"
import { listSpecs } from "./specs.js"
import { resolveRalphHome } from "./embedded.js"
import { laosDown, laosLogs, laosStatus, laosUp } from "./laos.js"
import { syncCredentials } from "./credentials.js"
import { dispatchRun } from "./dispatch.js"

const defaultRalphHome = process.env.LOCAL_RALPH_HOME ?? join(homedir(), "git", "local-isolated-ralph")

const ralphHomeOption = Options.text("ralph-home").pipe(
  Options.withDescription(`Path to local-ralph repo (default: ${defaultRalphHome})`),
  Options.withDefault(defaultRalphHome)
)

const specOption = Options.text("spec").pipe(Options.withDescription("Spec minified JSON path"))
const todoOption = Options.text("todo").pipe(Options.optional, Options.withDescription("Todo minified JSON path (optional)"))
const vmOption = Options.text("vm").pipe(Options.withDescription("VM name (e.g. ralph-1)"))
const projectOption = Options.text("project").pipe(Options.optional, Options.withDescription("Project directory to sync"))
const includeGitOption = Options.boolean("include-git").pipe(Options.withDefault(false), Options.withDescription("Include .git in sync"))
const workflowOption = Options.text("workflow").pipe(Options.optional, Options.withDescription("Smithers workflow path"))
const reportDirOption = Options.text("report-dir").pipe(Options.optional, Options.withDescription("Report directory inside VM"))
const modelOption = Options.text("model").pipe(Options.optional, Options.withDescription("Model name"))
const iterationsOption = Options.integer("iterations").pipe(Options.optional, Options.withDescription("Max iterations"))
const reviewMaxOption = Options.integer("review-max").pipe(
  Options.optional,
  Options.withDescription("Max review reruns before human gate (default: 2)")
)
const reviewModelsOption = Options.text("review-models").pipe(
  Options.optional,
  Options.withDescription("JSON file mapping reviewer_id -> model")
)

const decisionOption = Options.text("decision").pipe(Options.withDescription("approve | reject"))
const notesOption = Options.text("notes").pipe(Options.withDescription("Human notes"))

const keepOption = Options.integer("keep").pipe(Options.optional, Options.withDescription("Workdirs to keep"))
const dryRunOption = Options.boolean("dry-run").pipe(Options.withDefault(false), Options.withDescription("Dry-run cleanup"))

const specsDirOption = Options.text("specs-dir").pipe(Options.withDescription("Directory containing spec/todo min files"))
const vmPrefixOption = Options.text("vm-prefix").pipe(Options.withDescription("VM name prefix (default: ralph)"))

const topicOption = Options.text("topic").pipe(
  Options.withDescription("Topic: readme | workflow | quickstart | specs"),
  Options.withDefault("readme")
)

const laosRepoOption = Options.text("repo").pipe(
  Options.optional,
  Options.withDescription("LAOS git repo URL (default: https://github.com/dtechvision/laos)")
)
const laosBranchOption = Options.text("branch").pipe(
  Options.optional,
  Options.withDescription("LAOS branch (default: main)")
)
const laosDirOption = Options.text("dir").pipe(
  Options.optional,
  Options.withDescription("LAOS working directory (default: ~/.cache/fabrik/laos)")
)
const laosFollowOption = Options.boolean("follow").pipe(
  Options.withDefault(false),
  Options.withDescription("Follow logs")
)

const runScript = (scriptPath: string, args: string[]) =>
  Effect.sync(() => {
    if (!existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`)
    }
    execFileSync(scriptPath, args, { stdio: "inherit" })
  })

const unwrapOptional = <A>(value: Option.Option<A>) => Option.getOrUndefined(value)

const promptOption = Options.text("prompt").pipe(
  Options.optional,
  Options.withDescription("Path to PROMPT.md (prepended to system prompt)")
)
const reviewPromptOption = Options.text("review-prompt").pipe(
  Options.optional,
  Options.withDescription("Path to reviewer PROMPT.md (prepended to review prompt)")
)

const runCommand = Command.make(
  "run",
  {
    ralphHome: ralphHomeOption,
    spec: specOption,
    vm: vmOption,
    todo: todoOption,
    project: projectOption,
    includeGit: includeGitOption,
    workflow: workflowOption,
    reportDir: reportDirOption,
    model: modelOption,
    iterations: iterationsOption,
    prompt: promptOption,
    reviewPrompt: reviewPromptOption,
    reviewMax: reviewMaxOption,
    reviewModels: reviewModelsOption
  },
  ({
    ralphHome,
    spec,
    vm,
    todo,
    project,
    includeGit,
    workflow,
    reportDir,
    model,
    iterations,
    prompt,
    reviewPrompt,
    reviewMax,
    reviewModels
  }) => {
    const home = resolveRalphHome(ralphHome)
    const args: string[] = []
    const todoValue = unwrapOptional(todo)
    let projectValue = unwrapOptional(project)
    const workflowValue = unwrapOptional(workflow)
    const reportDirValue = unwrapOptional(reportDir)
    const modelValue = unwrapOptional(model)
    const iterationsValue = unwrapOptional(iterations)
    const promptValue = unwrapOptional(prompt)
    const reviewPromptValue = unwrapOptional(reviewPrompt)
    const reviewMaxValue = unwrapOptional(reviewMax)
    const reviewModelsValue = unwrapOptional(reviewModels)
    if (!projectValue) {
      const cwd = process.cwd()
      if (existsSync(join(cwd, ".git")) || existsSync(join(cwd, ".jj"))) {
        projectValue = cwd
        console.log(`[INFO] No --project provided; using current repo: ${cwd}`)
      }
    }
    if (process.platform === "darwin") {
      return Effect.sync(() =>
        dispatchRun({
          vm,
          spec,
          todo: todoValue ?? spec.replace(/\.min\.json$/i, ".todo.min.json"),
          project: projectValue,
          includeGit,
          workflow: workflowValue ? resolve(workflowValue) : resolve(home, "scripts/smithers-spec-runner.tsx"),
          reportDir: reportDirValue,
          model: modelValue,
          iterations: iterationsValue ?? undefined,
          prompt: promptValue ? resolve(promptValue) : undefined,
          reviewPrompt: reviewPromptValue ? resolve(reviewPromptValue) : undefined,
          reviewModels: reviewModelsValue ? resolve(reviewModelsValue) : undefined,
          reviewMax: reviewMaxValue ?? undefined
        })
      )
    }
    const script = resolve(home, "scripts", "dispatch.sh")
    if (includeGit) args.push("--include-git")
    args.push("--spec", spec)
    if (todoValue) args.push("--todo", todoValue)
    if (workflowValue) args.push("--workflow", workflowValue)
    if (reportDirValue) args.push("--report-dir", reportDirValue)
    if (modelValue) args.push("--model", modelValue)
    if (promptValue) args.push("--prompt", promptValue)
    if (reviewPromptValue) args.push("--review-prompt", reviewPromptValue)
    if (typeof reviewMaxValue === "number" && Number.isFinite(reviewMaxValue)) {
      args.push("--review-max", String(reviewMaxValue))
    }
    if (reviewModelsValue) args.push("--review-models", reviewModelsValue)
    args.push(vm, spec)
    if (projectValue) args.push(projectValue)
    if (typeof iterationsValue === "number" && Number.isFinite(iterationsValue)) {
      args.push(String(iterationsValue))
    }
    return runScript(script, args)
  }
).pipe(Command.withDescription("Dispatch a Smithers run (immutable workdir)"))

const validateCommand = Command.make(
  "validate",
  { dir: Options.text("dir").pipe(Options.withDescription("Specs directory"), Options.withDefault("specs")) },
  ({ dir }) => {
    const home = resolveRalphHome(defaultRalphHome)
    return runScript("bun", ["run", resolve(home, "scripts", "validate-specs.ts"), dir])
  }
).pipe(Command.withDescription("Validate spec/todo JSON"))

const minifyCommand = Command.make(
  "minify",
  { dir: Options.text("dir").pipe(Options.withDescription("Specs directory"), Options.withDefault("specs")) },
  ({ dir }) => {
    const home = resolveRalphHome(defaultRalphHome)
    return runScript("bun", ["run", resolve(home, "scripts", "minify-specs.ts"), dir])
  }
).pipe(Command.withDescription("Minify spec/todo JSON"))

const specCommand = Command.make("spec").pipe(Command.withSubcommands([validateCommand, minifyCommand]))

const feedbackCommand = Command.make(
  "feedback",
  {
    ralphHome: ralphHomeOption,
    vm: vmOption,
    spec: specOption,
    decision: decisionOption,
    notes: notesOption
  },
  ({ ralphHome, vm, spec, decision, notes }) => {
    const home = resolveRalphHome(ralphHome)
    const script = resolve(home, "scripts", "record-human-feedback.sh")
    const args = ["--vm", vm, "--spec", spec, "--decision", decision, "--notes", notes]
    return runScript(script, args)
  }
).pipe(Command.withDescription("Record human approval/rejection"))

const cleanupCommand = Command.make(
  "cleanup",
  {
    ralphHome: ralphHomeOption,
    vm: vmOption,
    keep: keepOption,
    dryRun: dryRunOption
  },
  ({ ralphHome, vm, keep, dryRun }) => {
    const home = resolveRalphHome(ralphHome)
    const script = resolve(home, "scripts", "cleanup-workdirs.sh")
    const args = [vm]
    if (typeof keep === "number" && Number.isFinite(keep)) {
      args.push("--keep", String(keep))
    }
    if (dryRun) args.push("--dry-run")
    return runScript(script, args)
  }
).pipe(Command.withDescription("Cleanup old immutable workdirs"))

const fleetCommand = Command.make(
  "fleet",
  {
    ralphHome: ralphHomeOption,
    specsDir: specsDirOption.pipe(Options.withDefault("specs")),
    vmPrefix: vmPrefixOption.pipe(Options.withDefault("ralph"))
  },
  ({ ralphHome, specsDir, vmPrefix }) => {
    const home = resolveRalphHome(ralphHome)
    const script = resolve(home, "scripts", "smithers-fleet.sh")
    const args = [specsDir, vmPrefix]
    return runScript(script, args)
  }
).pipe(Command.withDescription("Dispatch a fleet of Smithers runs"))

const docsCommand = Command.make(
  "docs",
  { topic: topicOption },
  ({ topic }) => {
    const base = resolveRalphHome(defaultRalphHome)
    const topicMap: Record<string, string> = {
      readme: "README.md",
      workflow: "WORKFLOW.md",
      quickstart: "QUICKSTART.md",
      specs: "specs/README.md"
    }
    const rel = topicMap[topic] ?? topicMap.readme
    const path = resolve(base, rel)
    const text = existsSync(path) ? readFileSync(path, "utf8") : `Docs not found: ${path}`
    return Console.log(text)
  }
).pipe(Command.withDescription("Print local-ralph docs"))

const flowCommand = Command.make("flow", {}, () =>
  Console.log([
    "Flow:",
    "1) Edit spec + todo JSON",
    "2) Validate + minify",
    "3) Dispatch Smithers",
    "4) Agent review runs",
    "5) Human gate blocks",
    "6) Approve -> next spec, Reject -> update and rerun"
  ].join("\n"))
).pipe(Command.withDescription("Print the short workflow"))

const laosBase = {
  repo: laosRepoOption,
  branch: laosBranchOption,
  dir: laosDirOption
}

const laosCommand = Command.make("laos").pipe(
  Command.withSubcommands([
    Command.make("up", laosBase, ({ repo, branch, dir }) =>
      Effect.sync(() => laosUp({ repoUrl: repo, branch, dir }))
    ).pipe(Command.withDescription("Clone/update LAOS and start docker compose")),
    Command.make("down", laosBase, ({ repo, branch, dir }) =>
      Effect.sync(() => laosDown({ repoUrl: repo, branch, dir }))
    ).pipe(Command.withDescription("Stop LAOS docker compose stack")),
    Command.make("status", laosBase, ({ repo, branch, dir }) =>
      Effect.sync(() => laosStatus({ repoUrl: repo, branch, dir }))
    ).pipe(Command.withDescription("Show LAOS docker compose status")),
    Command.make("logs", { ...laosBase, follow: laosFollowOption }, ({ repo, branch, dir, follow }) =>
      Effect.sync(() => laosLogs({ repoUrl: repo, branch, dir }, follow))
    ).pipe(Command.withDescription("Show LAOS docker compose logs"))
  ])
)

const runsCommand = Command.make("runs").pipe(
  Command.withSubcommands([
    Command.make(
      "list",
      {
        limit: Options.integer("limit").pipe(Options.optional, Options.withDescription("Max rows (default 10)")),
        db: Options.text("db").pipe(
          Options.optional,
          Options.withDescription("Path to ralph.db (default: ~/.cache/ralph/ralph.db)")
        )
      },
      ({ limit, db }) =>
        Effect.sync(() => {
          const limitValue = unwrapOptional(limit)
          const dbValue = unwrapOptional(db)
          const dbPath = dbValue ?? resolve(homedir(), ".cache", "ralph", "ralph.db")
          if (!existsSync(dbPath)) {
            console.log(`No DB found at ${dbPath}`)
            return
          }
          const script = `
import sqlite3
import sys

db_path = sys.argv[1]
limit = int(sys.argv[2])
conn = sqlite3.connect(db_path)
cur = conn.execute(
  "SELECT id, vm_name, spec_path, started_at, status, exit_code FROM runs ORDER BY started_at DESC LIMIT ?",
  (limit,)
)
rows = cur.fetchall()
conn.close()
if not rows:
  print("No runs found.")
else:
  for row in rows:
    rid, vm, spec, started, status, code = row
    print(f"{rid} | {vm} | {status} | {code} | {started} | {spec}")
`
          const rows = execFileSync("python3", ["-", dbPath, String(limitValue ?? 10)], {
            input: script
          }).toString()
          console.log(rows.trim())
        }).pipe(Effect.withSpan("runs.list"))
    ).pipe(Command.withDescription("List recent runs")),
    Command.make(
      "show",
      {
        id: Options.integer("id").pipe(Options.withDescription("Run id")),
        db: Options.text("db").pipe(
          Options.optional,
          Options.withDescription("Path to ralph.db (default: ~/.cache/ralph/ralph.db)")
        )
      },
      ({ id, db }) =>
        Effect.sync(() => {
          const dbValue = unwrapOptional(db)
          const dbPath = dbValue ?? resolve(homedir(), ".cache", "ralph", "ralph.db")
          if (!existsSync(dbPath)) {
            console.log(`No DB found at ${dbPath}`)
            return
          }
          const script = `
import sqlite3
import sys

db_path = sys.argv[1]
rid = int(sys.argv[2])
conn = sqlite3.connect(db_path)
cur = conn.execute(
  "SELECT id, vm_name, workdir, spec_path, todo_path, started_at, status, exit_code FROM runs WHERE id = ?",
  (rid,)
)
row = cur.fetchone()
conn.close()
if not row:
  print("Run not found.")
else:
  rid, vm, workdir, spec, todo, started, status, code = row
  print(f"id: {rid}")
  print(f"vm: {vm}")
  print(f"workdir: {workdir}")
  print(f"spec: {spec}")
  print(f"todo: {todo}")
  print(f"started_at: {started}")
  print(f"status: {status}")
  print(f"exit_code: {code}")
`
          const output = execFileSync("python3", ["-", dbPath, String(id)], { input: script }).toString()
          console.log(output.trim())
        }).pipe(Effect.withSpan("runs.show"))
    ).pipe(Command.withDescription("Show run details")),
    Command.make(
      "feedback",
      {
        id: Options.integer("id").pipe(Options.withDescription("Run id")),
        decision: decisionOption,
        notes: notesOption,
        ralphHome: ralphHomeOption,
        db: Options.text("db").pipe(
          Options.optional,
          Options.withDescription("Path to ralph.db (default: ~/.cache/ralph/ralph.db)")
        )
      },
      ({ id, decision, notes, ralphHome, db }) =>
        Effect.sync(() => {
          const dbValue = unwrapOptional(db)
          const dbPath = dbValue ?? resolve(homedir(), ".cache", "ralph", "ralph.db")
          if (!existsSync(dbPath)) {
            console.log(`No DB found at ${dbPath}`)
            return
          }
          const script = `
import sqlite3
import sys

db_path = sys.argv[1]
rid = int(sys.argv[2])
conn = sqlite3.connect(db_path)
cur = conn.execute(
  "SELECT vm_name, spec_path FROM runs WHERE id = ?",
  (rid,)
)
row = cur.fetchone()
conn.close()
if not row:
  print("")
else:
  print(f"{row[0]}|{row[1]}")
`
          const result = execFileSync("python3", ["-", dbPath, String(id)], { input: script })
            .toString()
            .trim()
          if (!result) {
            console.log("Run not found.")
            return
          }
          const [vm, spec] = result.split("|")
          const scriptPath = resolve(ralphHome, "scripts", "record-human-feedback.sh")
          execFileSync(
            scriptPath,
            ["--vm", vm, "--spec", spec, "--decision", decision, "--notes", notes],
            { stdio: "inherit" }
          )
        }).pipe(Effect.withSpan("runs.feedback"))
    ).pipe(Command.withDescription("Record feedback for a run id"))
  ])
)

const specsStatusCommand = Command.make(
  "status",
  { dir: Options.text("dir").pipe(Options.withDefault("specs"), Options.withDescription("Specs directory")) },
  ({ dir }) =>
    Effect.gen(function*() {
      const specs = listSpecs(dir)
      if (specs.length === 0) {
        yield* Console.log("No specs found.")
        return
      }
      for (const spec of specs) {
        const status = spec.status ?? "unknown"
        const title = spec.title ? ` - ${spec.title}` : ""
        yield* Console.log(`${spec.id}: ${status}${title}`)
      }
    })
).pipe(Command.withDescription("List specs and status"))

const specsCommand = Command.make("spec").pipe(
  Command.withSubcommands([validateCommand, minifyCommand, specsStatusCommand])
)

const credentialsCommand = Command.make("credentials").pipe(
  Command.withSubcommands([
    Command.make(
      "sync",
      { vm: vmOption },
      ({ vm }) => Effect.sync(() => syncCredentials({ vm }))
    ).pipe(Command.withDescription("Sync host credentials into a VM"))
  ])
)

const cli = Command.make("fabrik").pipe(
  Command.withSubcommands([
    runCommand,
    specsCommand,
    feedbackCommand,
    cleanupCommand,
    fleetCommand,
    docsCommand,
    flowCommand,
    runsCommand,
    laosCommand,
    credentialsCommand
  ])
)

export const run = Command.run(cli, {
  name: "Local Fabrik CLI",
  version: "0.1.0"
})
