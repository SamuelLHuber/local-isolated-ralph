import * as Command from "@effect/cli/Command"
import * as Options from "@effect/cli/Options"
import * as Effect from "effect/Effect"
import * as Console from "effect/Console"
import * as Option from "effect/Option"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { homedir } from "node:os"
import { listSpecs } from "./specs.js"
import { resolveRalphHome } from "./embedded.js"
import { laosDown, laosLogs, laosStatus, laosUp } from "./laos.js"
import { syncCredentials } from "./credentials.js"
import { dispatchRun } from "./dispatch.js"
import { reconcileRuns } from "./reconcile.js"
import { orchestrateRuns } from "./orchestrate.js"
import { minifySpecs, validateSpecs } from "./specs.js"

const defaultRalphHome = process.env.LOCAL_RALPH_HOME ?? join(homedir(), "git", "local-isolated-ralph")

const ralphHomeOption = Options.text("ralph-home").pipe(
  Options.withDescription(`Path to local-ralph repo (default: ${defaultRalphHome})`),
  Options.withDefault(defaultRalphHome)
)

const specOption = Options.text("spec").pipe(Options.withDescription("Spec minified JSON path"))
const todoOption = Options.text("todo").pipe(Options.optional, Options.withDescription("Todo minified JSON path (optional)"))
const vmOption = Options.text("vm").pipe(Options.withDescription("VM name (e.g. ralph-1)"))
const projectOption = Options.text("project").pipe(Options.optional, Options.withDescription("Project directory to sync"))
const repoOption = Options.text("repo").pipe(
  Options.optional,
  Options.withDescription("Git repo URL to clone inside the VM (mutually exclusive with --project)")
)
const repoBranchOption = Options.text("repo-branch").pipe(
  Options.optional,
  Options.withDescription("Git branch to checkout when cloning --repo (defaults to repo default branch)")
)
const includeGitOption = Options.boolean("include-git").pipe(Options.withDefault(false), Options.withDescription("Include .git in sync"))
const workflowOption = Options.text("workflow").pipe(Options.optional, Options.withDescription("Smithers workflow path"))
const reportDirOption = Options.text("report-dir").pipe(Options.optional, Options.withDescription("Report directory inside VM"))
const modelOption = Options.text("model").pipe(Options.optional, Options.withDescription("Model name"))
const iterationsOption = Options.integer("iterations").pipe(Options.optional, Options.withDescription("Max iterations"))
const branchOption = Options.text("branch").pipe(
  Options.optional,
  Options.withDescription("Branch/bookmark name for this run (default: spec-<specId>)")
)
const reviewMaxOption = Options.integer("review-max").pipe(
  Options.optional,
  Options.withDescription("Max review reruns before human gate (default: 2)")
)
const reviewModelsOption = Options.text("review-models").pipe(
  Options.optional,
  Options.withDescription("JSON file mapping reviewer_id -> model")
)
const requireAgentsOption = Options.text("require-agents").pipe(
  Options.optional,
  Options.withDescription("Comma-separated list of required agents when workflow uses dynamic components")
)

const decisionOption = Options.text("decision").pipe(Options.withDescription("approve | reject"))
const notesOption = Options.text("notes").pipe(Options.withDescription("Human notes"))

const keepOption = Options.integer("keep").pipe(Options.optional, Options.withDescription("Workdirs to keep"))
const dryRunOption = Options.boolean("dry-run").pipe(Options.withDefault(false), Options.withDescription("Dry-run cleanup"))
const intervalOption = Options.integer("interval").pipe(
  Options.optional,
  Options.withDescription("Polling interval in seconds (default: 30)")
)
const notifyOption = Options.boolean("notify").pipe(
  Options.withDefault(true),
  Options.withDescription("Send desktop notifications when blocked tasks appear")
)
const onceOption = Options.boolean("once").pipe(
  Options.withDefault(false),
  Options.withDescription("Check once and exit")
)
const runIdOption = Options.integer("run-id").pipe(
  Options.optional,
  Options.withDescription("Run id (defaults to latest run for VM)")
)

const specsDirOption = Options.text("specs-dir").pipe(Options.withDescription("Directory containing spec/todo min files"))
const vmPrefixOption = Options.text("vm-prefix").pipe(Options.withDescription("VM name prefix (default: ralph)"))
const vmsOption = Options.text("vms").pipe(Options.withDescription("Comma-separated VM list (e.g. valpha,ralph-2)"))
const specsOption = Options.text("specs").pipe(Options.withDescription("Comma-separated spec min.json list"))
const branchPrefixOption = Options.text("branch-prefix").pipe(
  Options.optional,
  Options.withDescription("Branch prefix for orchestrated runs (default: spec)")
)

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

const smithersRefOption = Options.text("smithers-ref").pipe(
  Options.optional,
  Options.withDescription("Smithers ref to pin (branch, tag, or 40-char commit SHA; default: main)")
)
const updateBunOption = Options.boolean("bun").pipe(
  Options.withDefault(false),
  Options.withDescription("Run bun update in the local-ralph repo")
)
const updateSmithersOption = Options.boolean("smithers").pipe(
  Options.withDefault(false),
  Options.withDescription("Update pinned Smithers ref in nix/docs and regenerate embedded assets")
)

const runScript = (scriptPath: string, args: string[]) =>
  Effect.sync(() => {
    if (!existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`)
    }
    execFileSync(scriptPath, args, { stdio: "inherit" })
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const notifyDesktop = (title: string, message: string) => {
  if (process.platform === "darwin") {
    try {
      execFileSync("terminal-notifier", ["-title", title, "-message", message, "-group", "fabrik"], { stdio: "ignore" })
      return
    } catch {
      // fall through to console only
    }
  }
  if (process.platform === "linux") {
    try {
      execFileSync("notify-send", [title, message], { stdio: "ignore" })
      return
    } catch {
      // fall through to console only
    }
  }
}

const runRemote = (vm: string, command: string) => {
  if (process.platform === "darwin") {
    return execFileSync("limactl", ["shell", "--workdir", "/home/ralph", vm, "bash", "-lc", command]).toString()
  }
  if (process.platform === "linux") {
    const ip = execFileSync("virsh", ["domifaddr", vm]).toString().split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes("ipv4"))
      ?.split(/\s+/)[3]
      ?.split("/")[0]
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    return execFileSync("ssh", ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `ralph@${ip}`, command]).toString()
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

const unwrapOptional = <A>(value: Option.Option<A>) => Option.getOrUndefined(value)

const SMITHERS_REPO = "https://github.com/evmts/smithers.git"
const SMITHERS_REF_PATTERN = /github:evmts\/smithers#([A-Za-z0-9._/-]+)/

const readSmithersRef = (home: string): string | null => {
  const nixPath = resolve(home, "nix", "modules", "ralph.nix")
  if (!existsSync(nixPath)) return null
  const source = readFileSync(nixPath, "utf8")
  const match = source.match(SMITHERS_REF_PATTERN)
  return match ? match[1] : null
}

const resolveSmithersRefToSha = (ref: string): string => {
  const isSha = /^[a-f0-9]{40}$/.test(ref)
  if (isSha) return ref
  const branchRef = `refs/heads/${ref}`
  const tagRef = `refs/tags/${ref}`
  const resolveFrom = (remoteRef: string): string | null => {
    try {
      const output = execFileSync("git", ["ls-remote", SMITHERS_REPO, remoteRef], { encoding: "utf8" }).trim()
      if (!output) return null
      const sha = output.split(/\s+/)[0]
      return /^[a-f0-9]{40}$/.test(sha) ? sha : null
    } catch {
      return null
    }
  }
  const branchSha = resolveFrom(branchRef)
  if (branchSha) return branchSha
  const tagSha = resolveFrom(tagRef)
  if (tagSha) return tagSha
  throw new Error(`Could not resolve Smithers ref '${ref}' from ${SMITHERS_REPO}`)
}

const replaceSmithersRefInFile = (path: string, nextRef: string) => {
  if (!existsSync(path)) return false
  const source = readFileSync(path, "utf8")
  const updated = source.replace(/github:evmts\/smithers#[A-Za-z0-9._/-]+/g, `github:evmts/smithers#${nextRef}`)
  if (updated === source) return false
  writeFileSync(path, updated, "utf8")
  return true
}

const updateSmithersRef = (home: string, nextRef: string) => {
  const targets = [
    resolve(home, "nix/modules/ralph.nix"),
    resolve(home, "README.md"),
    resolve(home, "QUICKSTART.md")
  ]
  let changed = 0
  for (const path of targets) {
    if (replaceSmithersRefInFile(path, nextRef)) changed += 1
  }
  if (changed === 0) {
    console.log("No Smithers references were updated.")
    return
  }
  execFileSync("bun", ["run", "scripts/embed-assets.ts"], { cwd: home, stdio: "inherit" })
  console.log(`Updated Smithers pin to ${nextRef} in ${changed} files and regenerated embedded assets.`)
}

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
    repo: repoOption,
    repoBranch: repoBranchOption,
    includeGit: includeGitOption,
    workflow: workflowOption,
    reportDir: reportDirOption,
    model: modelOption,
    iterations: iterationsOption,
    branch: branchOption,
    prompt: promptOption,
    reviewPrompt: reviewPromptOption,
    reviewMax: reviewMaxOption,
    reviewModels: reviewModelsOption,
    requireAgents: requireAgentsOption
  },
  ({
    ralphHome,
    spec,
    vm,
    todo,
    project,
    repo,
    repoBranch,
    includeGit,
    workflow,
    reportDir,
    model,
    iterations,
    branch,
    prompt,
    reviewPrompt,
    reviewMax,
    reviewModels,
    requireAgents
  }) => {
    const home = resolveRalphHome(ralphHome)
    const args: string[] = []
    const todoValue = unwrapOptional(todo)
    let projectValue = unwrapOptional(project)
    const repoValue = unwrapOptional(repo)
    const repoBranchValue = unwrapOptional(repoBranch)
    const workflowValue = unwrapOptional(workflow)
    const reportDirValue = unwrapOptional(reportDir)
    const modelValue = unwrapOptional(model)
    const iterationsValue = unwrapOptional(iterations)
    const branchValue = unwrapOptional(branch)
    const promptValue = unwrapOptional(prompt)
    const reviewPromptValue = unwrapOptional(reviewPrompt)
    const reviewMaxValue = unwrapOptional(reviewMax)
    const reviewModelsValue = unwrapOptional(reviewModels)
    const requireAgentsValue = unwrapOptional(requireAgents)
    if (!projectValue && !repoValue) {
      const cwd = process.cwd()
      if (existsSync(join(cwd, ".git")) || existsSync(join(cwd, ".jj"))) {
        projectValue = cwd
        console.log(`[INFO] No --project provided; using current repo: ${cwd}`)
      }
    }
    if (process.platform === "darwin" || process.platform === "linux") {
      return Effect.sync(() =>
        dispatchRun({
          vm,
          spec,
          todo: todoValue ?? spec.replace(/\.min\.json$/i, ".todo.min.json"),
          project: projectValue,
          repoUrl: repoValue ?? undefined,
          repoBranch: repoBranchValue ?? undefined,
          includeGit,
          workflow: workflowValue ? resolve(workflowValue) : resolve(home, "scripts/smithers-spec-runner.tsx"),
          reportDir: reportDirValue,
          model: modelValue,
          iterations: iterationsValue ?? undefined,
          branch: branchValue ?? undefined,
          prompt: promptValue ? resolve(promptValue) : undefined,
          reviewPrompt: reviewPromptValue ? resolve(reviewPromptValue) : undefined,
          reviewModels: reviewModelsValue ? resolve(reviewModelsValue) : undefined,
          reviewMax: reviewMaxValue ?? undefined,
          requireAgents: requireAgentsValue ? requireAgentsValue.split(",") : undefined
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
    if (branchValue) args.push("--branch", branchValue)
    if (promptValue) args.push("--prompt", promptValue)
    if (reviewPromptValue) args.push("--review-prompt", reviewPromptValue)
    if (typeof reviewMaxValue === "number" && Number.isFinite(reviewMaxValue)) {
      args.push("--review-max", String(reviewMaxValue))
    }
    if (reviewModelsValue) args.push("--review-models", reviewModelsValue)
    if (requireAgentsValue) args.push("--require-agents", requireAgentsValue)
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
    return Effect.sync(() => {
      validateSpecs(dir)
      Console.log("All spec/todo JSON files passed schema checks.")
    })
  }
).pipe(Command.withDescription("Validate spec/todo JSON"))

const minifyCommand = Command.make(
  "minify",
  { dir: Options.text("dir").pipe(Options.withDescription("Specs directory"), Options.withDefault("specs")) },
  ({ dir }) => {
    return Effect.sync(() => {
      minifySpecs(dir)
      Console.log(`Minified JSON in ${dir}`)
    })
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

const runsReconcileCommand = Command.make(
  "reconcile",
  {
    db: Options.text("db").pipe(
      Options.optional,
      Options.withDescription("Path to ralph.db (default: ~/.cache/ralph/ralph.db)")
    ),
    limit: Options.integer("limit").pipe(Options.optional, Options.withDescription("Max rows (default 50)")),
    heartbeatSeconds: Options.integer("heartbeat-seconds").pipe(
      Options.optional,
      Options.withDescription("Seconds before heartbeat is stale (default: 60)")
    )
  },
  ({ db, limit, heartbeatSeconds }) =>
    Effect.sync(() => {
      const dbValue = unwrapOptional(db)
      const dbPath = dbValue ?? resolve(homedir(), ".cache", "ralph", "ralph.db")
      if (!existsSync(dbPath)) {
        console.log(`No DB found at ${dbPath}`)
        return
      }
      reconcileRuns({
        dbPath,
        limit: unwrapOptional(limit) ?? 50,
        heartbeatSeconds: unwrapOptional(heartbeatSeconds) ?? 60
      })
    }).pipe(Effect.withSpan("runs.reconcile"))
).pipe(Command.withDescription("Reconcile run status against VM processes"))

const runsCommand = Command.make("runs").pipe(
  Command.withSubcommands([
    runsReconcileCommand,
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
          try {
            reconcileRuns({ dbPath, limit: limitValue ?? 10, heartbeatSeconds: 60 })
          } catch {
            // best-effort
          }
          const script = `
import sqlite3
import sys

db_path = sys.argv[1]
limit = int(sys.argv[2])
conn = sqlite3.connect(db_path)
cols = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
if "end_reason" not in cols:
  conn.execute("ALTER TABLE runs ADD COLUMN end_reason TEXT")
cur = conn.execute(
  "SELECT id, vm_name, spec_path, started_at, status, exit_code, end_reason FROM runs ORDER BY started_at DESC LIMIT ?",
  (limit,)
)
rows = cur.fetchall()
conn.close()
if not rows:
  print("No runs found.")
else:
  for row in rows:
    rid, vm, spec, started, status, code, end_reason = row
    reason = end_reason or "-"
    print(f"{rid} | {vm} | {status} | {code} | {reason} | {started} | {spec}")
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
          try {
            reconcileRuns({ dbPath, limit: 50, heartbeatSeconds: 60 })
          } catch {
            // best-effort
          }
          const script = `
import sqlite3
import sys

db_path = sys.argv[1]
rid = int(sys.argv[2])
conn = sqlite3.connect(db_path)
cols = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
if "end_reason" not in cols:
  conn.execute("ALTER TABLE runs ADD COLUMN end_reason TEXT")
cur = conn.execute(
  "SELECT id, vm_name, workdir, spec_path, todo_path, started_at, status, exit_code, end_reason FROM runs WHERE id = ?",
  (rid,)
)
row = cur.fetchone()
conn.close()
if not row:
  print("Run not found.")
else:
  rid, vm, workdir, spec, todo, started, status, code, end_reason = row
  print(f"id: {rid}")
  print(f"vm: {vm}")
  print(f"workdir: {workdir}")
  print(f"spec: {spec}")
  print(f"todo: {todo}")
  print(f"started_at: {started}")
  print(f"status: {status}")
  print(f"exit_code: {code}")
  print(f"end_reason: {end_reason}")
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
    ,
    Command.make(
      "watch",
      {
        vm: vmOption,
        runId: runIdOption,
        interval: intervalOption,
        notify: notifyOption,
        once: onceOption,
        db: Options.text("db").pipe(
          Options.optional,
          Options.withDescription("Path to ralph.db (default: ~/.cache/ralph/ralph.db)")
        )
      },
      ({ vm, runId, interval, notify, once, db }) =>
        Effect.promise(async () => {
          const dbValue = unwrapOptional(db)
          const dbPath = dbValue ?? resolve(homedir(), ".cache", "ralph", "ralph.db")
          if (!existsSync(dbPath)) {
            console.log(`No DB found at ${dbPath}`)
            return
          }
          try {
            reconcileRuns({ dbPath, limit: 50, heartbeatSeconds: 60 })
          } catch {
            // best-effort
          }

          const runIdValue = unwrapOptional(runId)
          const intervalSeconds = unwrapOptional(interval) ?? 30
          const notifyEnabled = notify
          const onceValue = once

          const lookupScript = `
import sqlite3
import sys

db_path = sys.argv[1]
rid = sys.argv[2]
vm = sys.argv[3]
conn = sqlite3.connect(db_path)
if rid != "":
  cur = conn.execute(
    "SELECT id, vm_name, workdir FROM runs WHERE id = ?",
    (int(rid),)
  )
else:
  cur = conn.execute(
    "SELECT id, vm_name, workdir FROM runs WHERE vm_name = ? ORDER BY started_at DESC LIMIT 1",
    (vm,)
  )
row = cur.fetchone()
conn.close()
if not row:
  print("")
else:
  rid, vm_name, workdir = row
  print(f"{rid}|{vm_name}|{workdir}")
`
          const result = execFileSync("python3", ["-", dbPath, String(runIdValue ?? ""), vm], {
            input: lookupScript
          }).toString().trim()
          if (!result) {
            console.log("Run not found.")
            return
          }
          const [rid, vmName, workdir] = result.split("|")
          const workBase = workdir.split("/").pop() ?? ""
          const reportsDir = `/home/ralph/work/${vmName}/.runs/${workBase}/reports`
          const seen = new Set<string>()
          console.log(`[${vmName}] Watching reports for run ${rid}`)

          while (true) {
            const script = `
import json, os
path = "${reportsDir}"
items = []
if os.path.isdir(path):
  for name in sorted(os.listdir(path)):
    if not name.endswith(".report.json"):
      continue
    try:
      with open(os.path.join(path, name), "r") as f:
        data = json.load(f)
      status = data.get("status")
      if status == "blocked":
        items.append((name, data.get("taskId", ""), data.get("issues", []), data.get("next", [])))
    except Exception:
      continue
for name, task_id, issues, nxt in items:
  print(name + "|" + task_id + "|" + "; ".join(issues) + "|" + "; ".join(nxt))
`
            const output = runRemote(vmName, `python3 - <<'PY'\n${script}\nPY`).trim()
            if (output) {
              for (const line of output.split("\n")) {
                const [file, taskId, issues, next] = line.split("|")
                if (seen.has(file)) continue
                seen.add(file)
                const msg = `Blocked: ${taskId}\n${issues}\nNext: ${next}`
                console.log(`[${vmName}] ${msg}`)
                if (notifyEnabled) notifyDesktop("fabrik", msg)
              }
            }
            if (onceValue) return
            await sleep(intervalSeconds * 1000)
          }
        }).pipe(Effect.withSpan("runs.watch"))
    ).pipe(Command.withDescription("Watch a run for blocked tasks and notify"))
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

const orchestrateCommand = Command.make(
  "orchestrate",
  {
    specs: specsOption,
    vms: vmsOption,
    project: projectOption,
    repo: repoOption,
    repoBranch: repoBranchOption,
    includeGit: includeGitOption,
    workflow: workflowOption,
    prompt: promptOption,
    reviewPrompt: reviewPromptOption,
    reviewModels: reviewModelsOption,
    reviewMax: reviewMaxOption,
    requireAgents: requireAgentsOption,
    branchPrefix: branchPrefixOption,
    iterations: iterationsOption,
    interval: intervalOption
  },
  ({
    specs,
    vms,
    project,
    repo,
    repoBranch,
    includeGit,
    workflow,
    prompt,
    reviewPrompt,
    reviewModels,
    reviewMax,
    requireAgents,
    branchPrefix,
    iterations,
    interval
  }) =>
    Effect.promise(async () => {
      const specList = specs.split(",").map((s) => s.trim()).filter(Boolean)
      const vmList = vms.split(",").map((s) => s.trim()).filter(Boolean)
      const workflowValue = unwrapOptional(workflow)
      const promptValue = unwrapOptional(prompt)
      const reviewPromptValue = unwrapOptional(reviewPrompt)
      const reviewModelsValue = unwrapOptional(reviewModels)
      const reviewMaxValue = unwrapOptional(reviewMax)
      const requireAgentsValue = unwrapOptional(requireAgents)
      const branchPrefixValue = unwrapOptional(branchPrefix)
      const iterationsValue = unwrapOptional(iterations)
      const intervalValue = unwrapOptional(interval)
      const repoValue = unwrapOptional(repo)
      const repoBranchValue = unwrapOptional(repoBranch)
      const results = await orchestrateRuns({
        specs: specList,
        vms: vmList,
        project: unwrapOptional(project),
        repoUrl: repoValue ?? undefined,
        repoBranch: repoBranchValue ?? undefined,
        includeGit,
        workflow: workflowValue ? resolve(workflowValue) : resolve(defaultRalphHome, "scripts/smithers-spec-runner.tsx"),
        prompt: promptValue ? resolve(promptValue) : undefined,
        reviewPrompt: reviewPromptValue ? resolve(reviewPromptValue) : undefined,
        reviewModels: reviewModelsValue ? resolve(reviewModelsValue) : undefined,
        reviewMax: reviewMaxValue ?? undefined,
        requireAgents: requireAgentsValue ? requireAgentsValue.split(",") : undefined,
        branchPrefix: branchPrefixValue ?? undefined,
        iterations: iterationsValue ?? undefined,
        intervalSeconds: intervalValue ?? 30
      })
      for (const result of results) {
        if (result.status === "blocked") {
          console.log(`[${result.vm}] BLOCKED: ${result.blockedTask ?? "unknown"}`)
        } else {
          console.log(`[${result.vm}] DONE`)
        }
      }
    })
).pipe(Command.withDescription("Dispatch multiple runs and watch for completion"))

const depsCommand = Command.make("deps").pipe(
  Command.withSubcommands([
    Command.make(
      "check",
      { ralphHome: ralphHomeOption },
      ({ ralphHome }) =>
        Effect.sync(() => {
          const home = resolveRalphHome(ralphHome)
          console.log(`[deps] Checking Bun dependencies in ${home}`)
          try {
            execFileSync("bun", ["outdated"], { cwd: home, stdio: "inherit" })
          } catch (error) {
            // bun outdated exits non-zero when outdated packages exist; output already shown.
            if (!(error instanceof Error)) throw error
          }

          const pinnedRef = readSmithersRef(home)
          if (!pinnedRef) {
            console.log("[deps] Smithers pin not found in nix/modules/ralph.nix")
            return
          }
          const latestMainSha = resolveSmithersRefToSha("main")
          const pinnedSha = /^[a-f0-9]{40}$/.test(pinnedRef) ? pinnedRef : resolveSmithersRefToSha(pinnedRef)
          const upToDate = pinnedSha === latestMainSha
          console.log(`[deps] Smithers pinned ref: ${pinnedRef}`)
          console.log(`[deps] Smithers pinned sha: ${pinnedSha}`)
          console.log(`[deps] Smithers latest main: ${latestMainSha}`)
          console.log(`[deps] Smithers status: ${upToDate ? "up-to-date" : "update available"}`)
        })
    ).pipe(Command.withDescription("Check outdated Bun deps and Smithers pin drift")),
    Command.make(
      "update",
      {
        ralphHome: ralphHomeOption,
        bun: updateBunOption,
        smithers: updateSmithersOption,
        smithersRef: smithersRefOption
      },
      ({ ralphHome, bun, smithers, smithersRef }) =>
        Effect.sync(() => {
          if (!bun && !smithers) {
            throw new Error("Nothing to update. Pass --bun and/or --smithers.")
          }
          const home = resolveRalphHome(ralphHome)
          if (bun) {
            console.log(`[deps] Running bun update in ${home}`)
            execFileSync("bun", ["update"], { cwd: home, stdio: "inherit" })
          }
          if (smithers) {
            const refValue = unwrapOptional(smithersRef) ?? "main"
            const nextSha = resolveSmithersRefToSha(refValue)
            updateSmithersRef(home, nextSha)
          }
        })
    ).pipe(Command.withDescription("Update Bun deps and/or Smithers pin"))
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
    credentialsCommand,
    orchestrateCommand,
    depsCommand
  ])
)

export const run = Command.run(cli, {
  name: "Local Fabrik CLI",
  version: "0.1.0"
})
