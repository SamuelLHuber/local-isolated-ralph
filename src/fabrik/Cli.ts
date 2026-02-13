import * as Command from "@effect/cli/Command"
import * as Options from "@effect/cli/Options"
import * as Effect from "effect/Effect"
import * as Console from "effect/Console"
import * as Option from "effect/Option"
import { existsSync, readFileSync } from "node:fs"
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
import { runCommand, runCommandOutput } from "./exec.js"
import { cleanupWorkdirs } from "./cleanup.js"
import { getVmIp } from "./vm-utils.js"
import { dispatchFleet } from "./fleet.js"
import { recordFeedback, recordFeedbackForRun } from "./feedback.js"
import { findLatestRunForVm, findRunById, listRuns, openRunDb } from "./runDb.js"
import { CLI_VERSION } from "./version.js"

const defaultRalphHome = process.env.LOCAL_RALPH_HOME ?? join(homedir(), "git", "local-isolated-ralph")

const ralphHomeOption = Options.text("ralph-home").pipe(
  Options.withDescription(`Path to local-ralph repo (default: ${defaultRalphHome})`),
  Options.withDefault(defaultRalphHome)
)

const specOption = Options.text("spec").pipe(Options.withDescription("Spec JSON path"))
const todoOption = Options.text("todo").pipe(Options.optional, Options.withDescription("Todo JSON path (optional)"))
const vmOption = Options.text("vm").pipe(Options.withDescription("VM name (e.g. ralph-1)"))
const runSpecOption = specOption.pipe(Options.optional)
const runVmOption = vmOption.pipe(Options.optional)
const projectOption = Options.text("project").pipe(Options.optional, Options.withDescription("Project directory to sync"))
const repoOption = Options.text("repo").pipe(
  Options.optional,
  Options.withDescription("Git repo URL to clone inside the VM (mutually exclusive with --project)")
)
const repoBranchOption = Options.text("repo-branch").pipe(
  Options.optional,
  Options.withDescription("Git branch to checkout when cloning --repo (defaults to repo default branch)")
)
const repoRefOption = Options.text("ref").pipe(
  Options.optional,
  Options.withDescription("Git ref/branch to checkout when cloning --repo (alias for --repo-branch)")
)
const includeGitOption = Options.boolean("include-git").pipe(Options.withDefault(false), Options.withDescription("Include .git in sync"))
const workflowOption = Options.text("workflow").pipe(Options.optional, Options.withDescription("Smithers workflow path"))
const reportDirOption = Options.text("report-dir").pipe(Options.optional, Options.withDescription("Report directory inside VM"))
const modelOption = Options.text("model").pipe(Options.optional, Options.withDescription("Model name"))
const iterationsOption = Options.integer("iterations").pipe(Options.optional, Options.withDescription("Max iterations"))
const followOption = Options.boolean("follow").pipe(
  Options.withDefault(false),
  Options.withDescription("Stream Smithers output (otherwise detach)")
)
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

const specsDirOption = Options.text("specs-dir").pipe(Options.withDescription("Directory containing spec/todo JSON files"))
const vmPrefixOption = Options.text("vm-prefix").pipe(Options.withDescription("VM name prefix (default: ralph)"))
const vmsOption = Options.text("vms").pipe(Options.withDescription("Comma-separated VM list (e.g. valpha,ralph-2)"))
const specsOption = Options.text("specs").pipe(Options.withDescription("Comma-separated spec.json list"))
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

const readSpecId = (path?: string) => {
  if (!path) return ""
  try {
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw) as { id?: string }
    return typeof parsed.id === "string" ? parsed.id : ""
  } catch {
    return ""
  }
}
const laosFollowOption = Options.boolean("follow").pipe(
  Options.withDefault(false),
  Options.withDescription("Follow logs")
)

const workflowHelp = [
  "Workflow:",
  "  1) fabrik spec validate",
  "  2) fabrik run --spec specs/feature.json --vm ralph-1 --project /path/to/repo",
  "  3) fabrik runs watch --vm ralph-1",
  "  4) fabrik runs show --id <run-id>",
  "  5) fabrik feedback --vm ralph-1 --spec specs/feature.json --decision approve --notes \"OK\""
].join("\n")

const printRunNextSteps = (runId: number, vm: string, specPath: string) => {
  console.log("")
  console.log("Next steps:")
  console.log(`  fabrik runs show --id ${runId}`)
  console.log(`  fabrik runs watch --vm ${vm}`)
  console.log(
    `  fabrik feedback --vm ${vm} --spec ${specPath} --decision approve --notes \"OK\"`
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const notifyDesktop = (title: string, message: string) => {
  if (process.platform === "darwin") {
    try {
      runCommand("terminal-notifier", ["-title", title, "-message", message, "-group", "fabrik"], {
        context: "desktop notification"
      })
      return
    } catch {
      // fall through to console only
    }
  }
  if (process.platform === "linux") {
    try {
      runCommand("notify-send", [title, message], { context: "desktop notification" })
      return
    } catch {
      // fall through to console only
    }
  }
}

const runRemote = (vm: string, command: string) => {
  if (process.platform === "darwin") {
    return runCommandOutput("limactl", ["shell", "--workdir", "/home/ralph", vm, "bash", "-lc", command], {
      context: `run ${command} on ${vm}`
    })
  }
  if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    return runCommandOutput(
      "ssh",
      ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `ralph@${ip}`, command],
      { context: `run ${command} on ${vm}` }
    )
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

const runRemoteStream = (vm: string, command: string) => {
  if (process.platform === "darwin") {
    runCommand("limactl", ["shell", "--workdir", "/home/ralph", vm, "bash", "-lc", command], {
      context: `stream ${command} on ${vm}`
    })
    return
  }
  if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    runCommand(
      "ssh",
      ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `ralph@${ip}`, command],
      { context: `stream ${command} on ${vm}` }
    )
    return
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

const unwrapOptional = <A>(value: Option.Option<A>) => Option.getOrUndefined(value)

const resolveTodoPath = (specPath: string) => {
  if (specPath.endsWith(".todo.min.json")) return specPath
  if (specPath.endsWith(".min.json")) return specPath.replace(/\.min\.json$/i, ".todo.min.json")
  if (specPath.endsWith(".todo.json")) return specPath
  if (specPath.endsWith(".json")) return specPath.replace(/\.json$/i, ".todo.json")
  return `${specPath}.todo.json`
}

const promptOption = Options.text("prompt").pipe(
  Options.optional,
  Options.withDescription("Path to PROMPT.md (prepended to system prompt)")
)
const reviewPromptOption = Options.text("review-prompt").pipe(
  Options.optional,
  Options.withDescription("Path to reviewer PROMPT.md (prepended to review prompt)")
)

const runAttachCommand = Command.make(
  "attach",
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
      const { db: dbHandle } = openRunDb(dbPath)
      const run = findRunById(dbHandle, id)
      dbHandle.close()
      if (!run) {
        console.log("Run not found.")
        return
      }
      const workBase = run.workdir.split("/").pop() ?? ""
      const reportsDir = `/home/ralph/work/${run.vm_name}/.runs/${workBase}/reports`
      const controlDir = `/home/ralph/work/${run.vm_name}/.runs/${workBase}`
      const specId = readSpecId(run.spec_path)
      const dbName = specId ? `${specId}.db` : `run-${run.id}.db`
      const smithersDbPath = `${controlDir}/.smithers/${dbName}`
      const logPath = `${reportsDir}/smithers.log`
      const command = [
        `if [ -f "${logPath}" ]; then`,
        `  tail -n 200 -f "${logPath}"`,
        "else",
        `  echo "smithers.log not found; showing smithers db instead."`,
        `  python3 - <<'PY'`,
        `import json, os, sqlite3`,
        `db_path = "${smithersDbPath}"`,
        `if not os.path.exists(db_path):`,
        `  print("No smithers db found.")`,
        `  raise SystemExit(0)`,
        `conn = sqlite3.connect(db_path)`,
        `try:`,
        `  for row in conn.execute("SELECT task_id, status, issues, next FROM task_report ORDER BY node_id"):` ,
        `    print(json.dumps({"taskId": row[0], "status": row[1], "issues": row[2], "next": row[3]}, indent=2))`,
        `  for row in conn.execute("SELECT status, issues, next FROM review_summary ORDER BY iteration DESC LIMIT 1"):` ,
        `    print(json.dumps({"reviewStatus": row[0], "issues": row[1], "next": row[2]}, indent=2))`,
        `finally:`,
        `  conn.close()`,
        `PY`,
        "fi"
      ].join("\n")
      runRemoteStream(run.vm_name, command)
    })
).pipe(Command.withDescription("Attach to an existing run and stream logs"))

const runDispatchCommand = Command.make(
  "run",
  {
    ralphHome: ralphHomeOption,
    spec: runSpecOption,
    vm: runVmOption,
    todo: todoOption,
    project: projectOption,
    repo: repoOption,
    repoBranch: repoBranchOption,
    repoRef: repoRefOption,
    includeGit: includeGitOption,
    workflow: workflowOption,
    reportDir: reportDirOption,
    model: modelOption,
    iterations: iterationsOption,
    follow: followOption,
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
    repoRef,
    includeGit,
    workflow,
    reportDir,
    model,
    iterations,
    follow,
    branch,
    prompt,
    reviewPrompt,
    reviewMax,
    reviewModels,
    requireAgents
  }) => {
    const home = resolveRalphHome(ralphHome)
    const specValue = unwrapOptional(spec)
    const vmValue = unwrapOptional(vm)
    if (!specValue) {
      throw new Error("Missing required option: --spec")
    }
    if (!vmValue) {
      throw new Error("Missing required option: --vm")
    }
    const todoValue = unwrapOptional(todo)
    let projectValue = unwrapOptional(project)
    const repoValue = unwrapOptional(repo)
    const repoBranchValue = unwrapOptional(repoBranch)
    const repoRefValue = unwrapOptional(repoRef)
    const workflowValue = unwrapOptional(workflow)
    const reportDirValue = unwrapOptional(reportDir)
    const modelValue = unwrapOptional(model)
    const iterationsValue = unwrapOptional(iterations)
    const followValue = follow
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
    const resolvedTodo = todoValue ?? resolveTodoPath(specValue)
    if (process.platform === "darwin" || process.platform === "linux") {
      return Effect.sync(() => {
        const result = dispatchRun({
          vm: vmValue,
          spec: specValue,
          todo: resolvedTodo,
          project: projectValue,
          repoUrl: repoValue ?? undefined,
          repoRef: repoRefValue ?? repoBranchValue ?? undefined,
          includeGit,
          workflow: workflowValue ? resolve(workflowValue) : resolve(home, "scripts/smithers-spec-runner.tsx"),
          reportDir: reportDirValue,
          model: modelValue,
          iterations: iterationsValue ?? undefined,
          follow: followValue,
          branch: branchValue ?? undefined,
          prompt: promptValue ? resolve(promptValue) : undefined,
          reviewPrompt: reviewPromptValue ? resolve(reviewPromptValue) : undefined,
          reviewModels: reviewModelsValue ? resolve(reviewModelsValue) : undefined,
          reviewMax: reviewMaxValue ?? undefined,
          requireAgents: requireAgentsValue ? requireAgentsValue.split(",") : undefined
        })
        printRunNextSteps(result.runId, vmValue, specValue)
        return result
      })
    }
    return Effect.fail(new Error(`Unsupported OS: ${process.platform}`))
  }
).pipe(
  Command.withDescription("Dispatch a Smithers run (immutable workdir)"),
  Command.withSubcommands([runAttachCommand])
)

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
    vm: vmOption,
    spec: specOption,
    decision: decisionOption,
    notes: notesOption
  },
  ({ vm, spec, decision, notes }) =>
    Effect.sync(() =>
      recordFeedback({
        vm,
        spec,
        decision,
        notes
      })
    )
).pipe(Command.withDescription("Record human approval/rejection"))

const cleanupCommand = Command.make(
  "cleanup",
  {
    vm: vmOption,
    keep: keepOption,
    dryRun: dryRunOption
  },
  ({ vm, keep, dryRun }) =>
    Effect.sync(() =>
      cleanupWorkdirs({
        vm,
        keep: typeof keep === "number" && Number.isFinite(keep) ? keep : undefined,
        dryRun
      })
    )
).pipe(Command.withDescription("Cleanup old immutable workdirs"))

const fleetCommand = Command.make(
  "fleet",
  {
    ralphHome: ralphHomeOption,
    specsDir: specsDirOption.pipe(Options.withDefault("specs")),
    vmPrefix: vmPrefixOption.pipe(Options.withDefault("ralph"))
  },
  ({ specsDir, vmPrefix }) =>
    Effect.sync(() =>
      dispatchFleet({
        specsDir,
        vmPrefix
      })
    )
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

const knownIssuesCommand = Command.make("known-issues", {}, () =>
  Console.log([
    "Known issues:",
    "",
    "1) Bun untrusted scripts after install:",
    "   bun pm untrusted",
    "   # review the package + script", 
    "   bun pm trust <pkg>  # if acceptable; otherwise remove the dependency",
    "",
    "2) Smithers missing in VM:",
    "   limactl shell <vm> -- bash -lc 'bun add -g smithers-orchestrator'",
    "   # or on Linux: ssh ralph@<ip> 'bun add -g smithers-orchestrator'",
    "",
    "3) Missing GitHub/Codex auth in VM:",
    "   fabrik credentials sync --vm <vm>",
    "",
    "4) VM not running:",
    "   limactl start <vm>  # macOS", 
    "   virsh start <vm>    # Linux"
  ].join("\n"))
).pipe(Command.withDescription("Print known issues and fixes"))

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
      Options.withDescription("Seconds before heartbeat is stale (default: 120)")
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
        heartbeatSeconds: unwrapOptional(heartbeatSeconds) ?? 120
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
            reconcileRuns({ dbPath, limit: limitValue ?? 10, heartbeatSeconds: 120 })
          } catch {
            // best-effort
          }
          const { db: dbHandle } = openRunDb(dbPath)
          const rows = listRuns(dbHandle, limitValue ?? 10)
          dbHandle.close()
          if (!rows.length) {
            console.log("No runs found.")
            return
          }
          for (const row of rows) {
            console.log(
              `${row.id} | ${row.vm_name} | ${row.status} | ${row.exit_code ?? ""} | ${row.started_at} | ${row.spec_path}`
            )
          }
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
            reconcileRuns({ dbPath, limit: 50, heartbeatSeconds: 120 })
          } catch {
            // best-effort
          }
          const { db: dbHandle } = openRunDb(dbPath)
          const run = findRunById(dbHandle, id)
          dbHandle.close()
          if (!run) {
            console.log("Run not found.")
            return
          }
          console.log(`id: ${run.id}`)
          console.log(`vm: ${run.vm_name}`)
          console.log(`workdir: ${run.workdir}`)
          console.log(`spec: ${run.spec_path}`)
          console.log(`todo: ${run.todo_path}`)
          console.log(`repo_url: ${run.repo_url ?? ""}`)
          console.log(`repo_ref: ${run.repo_ref ?? ""}`)
          console.log(`started_at: ${run.started_at}`)
          console.log(`status: ${run.status}`)
          console.log(`exit_code: ${run.exit_code ?? ""}`)
          if (run.failure_reason) {
            console.log(`failure_reason: ${run.failure_reason}`)
          }
          console.log(`cli_version: ${run.cli_version ?? ""}`)
          console.log(`os: ${run.os ?? ""}`)
          console.log(`binary_hash: ${run.binary_hash ?? ""}`)
          console.log(`git_sha: ${run.git_sha ?? ""}`)
        }).pipe(Effect.withSpan("runs.show"))
    ).pipe(Command.withDescription("Show run details")),
    Command.make(
      "feedback",
      {
        id: Options.integer("id").pipe(Options.withDescription("Run id")),
        decision: decisionOption,
        notes: notesOption,
        db: Options.text("db").pipe(
          Options.optional,
          Options.withDescription("Path to ralph.db (default: ~/.cache/ralph/ralph.db)")
        )
      },
      ({ id, decision, notes, db }) =>
        Effect.sync(() => {
          const dbValue = unwrapOptional(db)
          const dbPath = dbValue ?? resolve(homedir(), ".cache", "ralph", "ralph.db")
          if (!existsSync(dbPath)) {
            console.log(`No DB found at ${dbPath}`)
            return
          }
          recordFeedbackForRun({ runId: id, decision, notes, dbPath })
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
            reconcileRuns({ dbPath, limit: 50, heartbeatSeconds: 120 })
          } catch {
            // best-effort
          }

          const runIdValue = unwrapOptional(runId)
          const intervalSeconds = unwrapOptional(interval) ?? 30
          const notifyEnabled = notify
          const onceValue = once

          const { db: dbHandle } = openRunDb(dbPath)
          const run = runIdValue
            ? findRunById(dbHandle, runIdValue)
            : findLatestRunForVm(dbHandle, vm)
          dbHandle.close()
          if (!run) {
            console.log("Run not found.")
            return
          }
          const rid = String(run.id)
          const vmName = run.vm_name
          const workdir = run.workdir
          const workBase = workdir.split("/").pop() ?? ""
          const controlDir = `/home/ralph/work/${vmName}/.runs/${workBase}`
          const specId = readSpecId(run.spec_path)
          const dbName = specId ? `${specId}.db` : `run-${rid}.db`
          const smithersDbPath = `${controlDir}/.smithers/${dbName}`
          const seen = new Set<string>()
          console.log(`[${vmName}] Watching Smithers DB for run ${rid}`)

          while (true) {
            const script = `
import json, os, sqlite3
path = "${smithersDbPath}"
run_id = "${rid}"
items = []
if not os.path.exists(path):
  raise SystemExit(0)
conn = sqlite3.connect(path)
try:
  cur = conn.execute(
    "SELECT task_id, node_id, status, issues, next FROM task_report WHERE run_id = ? AND status IN ('blocked','failed') ORDER BY node_id",
    (run_id,)
  )
  for row in cur.fetchall():
    task_id, node_id, status, issues_raw, next_raw = row
    def parse_list(raw):
      if raw is None:
        return []
      if isinstance(raw, (list, tuple)):
        return list(raw)
      if isinstance(raw, str):
        try:
          parsed = json.loads(raw)
          if isinstance(parsed, list):
            return parsed
        except Exception:
          return [raw]
      return []
    items.append((str(task_id or node_id or ""), str(status or ""), "; ".join(parse_list(issues_raw)), "; ".join(parse_list(next_raw))))
finally:
  conn.close()
for task_id, status, issues, nxt in items:
  print(task_id + "|" + status + "|" + issues + "|" + nxt)
`
            const output = runRemote(vmName, `python3 - <<'PY'\n${script}\nPY`).trim()
            if (output) {
              for (const line of output.split("\n")) {
                const [taskId, status, issues, next] = line.split("|")
                const key = `${taskId}:${status}`
                if (seen.has(key)) continue
                seen.add(key)
                const msg = `Blocked (${status}): ${taskId}\n${issues}\nNext: ${next}`
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

const specInterviewPrompt = `COMPOUND ENGINEERING: SPEC INTERVIEW
======================================

> Each unit of engineering work should make subsequent units easier—not harder.

80% PLANNING | 20% EXECUTION

Read: specs/INTERVIEW.md for complete compound engineering principles.

QUICK REFERENCE - The 10 Questions:

PRE-INTERVIEW CHECKLIST:
[ ] Clear problem statement
[ ] Boundary understanding (in/out of scope)
[ ] Success criteria defined

Q1: IDENTITY - Unique kebab-case ID (e.g., "billing-idempotency")
Q2: TITLE - One sentence, active voice, NO implementation details
Q3: STATUS - draft | ready | in-progress | review | done | superseded
Q4: GOALS (3-7) - MUST accomplish, starts with verb, NO implementation
Q5: NON-GOALS - Explicitly out of scope (prevents creep)
Q6: API - Interfaces, signatures, branded types, error channels
Q7: BEHAVIOR - Business rules, state transitions, edge cases
Q8: OBSERVABILITY - Metrics, logs, alerts, health checks
Q9: ACCEPTANCE - Testable criteria, performance thresholds
Q10: ASSUMPTIONS - What could change (deps, platform, volume)

CRITICAL PRINCIPLES:
- Goals = WHAT (never HOW)
- Non-goals = scope fence
- Every requirement verifiable
- Tier T1/T2/T3/T4 determines guarantee layers needed

OUTPUT: specs/{id}.json (see full format in specs/INTERVIEW.md)

NEXT: Run 'fabrik todo generate' for todo creation guide`;

const specInterviewExtendedRef = `\n\nFor the complete Compound Engineering interview process with:\n- 80/20 planning/execution ratio explanation\n- 4 principles (Plan, Review, Codify, Quality)\n- Detailed Q1-Q10 guidance with examples\n- DoD by tier (T1-T4)\n- Compound impact over time\n\nSee: specs/INTERVIEW.md`;

const specInterviewFullPrompt = specInterviewPrompt + specInterviewExtendedRef;

const specInterviewCommand = Command.make(
  "interview",
  {},
  () =>
    Effect.gen(function*() {
      yield* Console.log(specInterviewPrompt)
    })
).pipe(Command.withDescription("Print structured prompt for conducting a spec interview"))

const todoGeneratePrompt = `TODO GENERATION FROM SPEC
==========================

You are converting a Spec into a structured Todo JSON file.
This requires understanding the SPEC deeply and breaking it into verifiable tasks.

INPUT: Read specs/{id}.json
OUTPUT: Write specs/{id}.todo.json

PROCESS:

STEP 1: Analyze the Spec
- Identify the criticality tier:
  * T1 (Critical/Money/Auth): Needs ALL 6 guarantee layers
  * T2 (Important/State): Needs L1-L5
  * T3-T4: Needs L1-L4

- List all invariants that MUST hold (for @property tests)
- Identify DB schema changes needed
- Note external integrations

STEP 2: Determine TDD Mode
- TDD = true: For logic-heavy code (state machines, calculations, transformations)
- TDD = false: For glue/config/setup code

STEP 3: Define Definition of Done (DoD)
Include based on criticality tier:

T1 (Critical) - ALL of:
- L1: Branded types implemented (no primitive types)
- L2: Effect.assert for pre/postconditions present
- L3: DB migration with UNIQUE/CHECK constraints
- L4: @property TSDoc on every invariant test
- L4: Property-based tests (conservation, idempotency)
- L5: TODO comments for production alerts
- L5: Metrics emission points identified
- L6: Seed-based simulation plan documented
- Tests: 90%+ line coverage, 85%+ branch coverage
- Code reviewed by 8 reviewers (including NASA-10-RULES)
- Pushed to GitHub branch, CI passes

T2 (Important) - ALL of:
- L1: Branded types for domain values
- L2: Assertions for key invariants
- L3: DB constraints for uniqueness/referential integrity
- L4: Unit tests + property tests for core invariants
- L5: Monitoring TODOs
- Tests: 85%+ line coverage, 70%+ branch coverage
- Code reviewed, CI passes

T3-T4 (Standard) - ALL of:
- L1: Basic typing (no any)
- L2: Input validation
- L4: Unit tests for happy path and errors
- Tests: 80%+ line coverage
- CI passes

STEP 4: Create Tasks (3-15 per spec)
Each task MUST be:
- Independent (can be done in any order within constraints)
- Verifiable (clear "verify" criteria)
- Small (1-4 hours of focused work)

Task structure:
{
  "id": "1",
  "do": "What to implement (active voice, specific)",
  "verify": "How to confirm it's correct (tests, assertions, constraints)"
}

EXAMPLE TASKS BY TYPE:

Type: Domain Model
{
  "id": "1",
  "do": "Define branded types: UserId, SubscriptionId, PositiveAmount",
  "verify": "Types compile, Schema validates, no primitive string/number usage"
}

Type: State Machine
{
  "id": "2",
  "do": "Implement phantom types for Subscription<Status> state machine",
  "verify": "Invalid transitions cause compile errors; Match.exhaustive covers all states"
}

Type: DB Schema
{
  "id": "3", 
  "do": "Create migration with UNIQUE constraint for idempotency keys",
  "verify": "Tests confirm duplicate key rejection at DB level"
}

Type: Core Logic
{
  "id": "4",
  "do": "Implement chargeSubscription with Effect.assert pre/postconditions",
  "verify": "@property tests: CANCELED_NEVER_CHARGED, NO_DOUBLE_CHARGE, PERIOD_ADVANCES_ONCE"
}

Type: API Layer
{
  "id": "5",
  "do": "Add REST endpoint POST /subscriptions/:id/charge",
  "verify": "Integration tests pass; input validation rejects malformed requests"
}

Type: Observability
{
  "id": "6",
  "do": "Add TODO comments for production alerts (double charge, failed renewal)",
  "verify": "TODOs include alert conditions and severity levels"
}

Type: Simulation (T1 only)
{
  "id": "7",
  "do": "Document seed-based simulation plan for billing invariants",
  "verify": "Plan includes: seed generation, operations per seed, invariant checks, failure injection"
}

OUTPUT FORMAT:

{
  "v": 1,
  "id": "<same-as-spec-id>",
  "tdd": <true|false>,
  "dod": [
    "L1: Branded types implemented",
    "L2: Effect.assert for pre/postconditions",
    "..."
  ],
  "tasks": [
    { "id": "1", "do": "...", "verify": "..." },
    { "id": "2", "do": "...", "verify": "..." }
  ]
}

QUALITY CHECKLIST:
- [ ] Every task has clear "verify" criteria
- [ ] TDD flag matches actual test requirements
- [ ] DoD includes all required layers for tier
- [ ] Tasks are ordered by dependency (not necessarily execution order)
- [ ] No task exceeds 4 hours of work
- [ ] Critical paths have more verification tasks`;

const todoGenerateCommand = Command.make(
  "generate",
  {},
  () =>
    Effect.gen(function*() {
      yield* Console.log(todoGeneratePrompt)
    })
).pipe(Command.withDescription("Print structured prompt for generating a todo.json from a spec"))

const specsCommand = Command.make("spec").pipe(
  Command.withSubcommands([validateCommand, minifyCommand, specsStatusCommand, specInterviewCommand])
)

const todoCommand = Command.make("todo").pipe(
  Command.withSubcommands([todoGenerateCommand])
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
    repoRef: repoRefOption,
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
    repoRef,
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
      const repoRefValue = unwrapOptional(repoRef)
      const results = await orchestrateRuns({
        specs: specList,
        vms: vmList,
        project: unwrapOptional(project),
        repoUrl: repoValue ?? undefined,
        repoRef: repoRefValue ?? repoBranchValue ?? undefined,
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

const cli = Command.make("fabrik").pipe(
  Command.withDescription(`Local Fabrik CLI\n\n${workflowHelp}`),
  Command.withSubcommands([
    runDispatchCommand,
    specsCommand,
    todoCommand,
    feedbackCommand,
    cleanupCommand,
    fleetCommand,
    docsCommand,
    flowCommand,
    knownIssuesCommand,
    runsCommand,
    laosCommand,
    credentialsCommand,
    orchestrateCommand
  ])
)

export const run = Command.run(cli, {
  name: "Local Fabrik CLI",
  version: CLI_VERSION
})
