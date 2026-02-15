import * as Command from "@effect/cli/Command"
import * as Options from "@effect/cli/Options"
import * as Effect from "effect/Effect"
import * as Console from "effect/Console"
import * as Option from "effect/Option"
import { existsSync, readFileSync } from "node:fs"
import { resolve, join, basename } from "node:path"
import { homedir } from "node:os"
import { listSpecs } from "./specs.js"
import { resolveRalphHome } from "./embedded.js"
import { laosDown, laosLogs, laosStatus, laosUp } from "./laos.js"
import { syncCredentials, validateRalphEnvHost, testApiKeysInVm } from "./credentials.js"
import { listRalphVms, printVmList, cleanupVms, createRalphEnv } from "./vm.js"
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
const todoOption = Options.text("todo").pipe(Options.optional, Options.withDescription("Todo JSON path - when provided, uses pre-defined tickets directly (skips discovery phase)"))
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
const dynamicOption = Options.boolean("dynamic").pipe(
  Options.withDefault(false),
  Options.withDescription("Use batched iterative discovery workflow (discovers tickets in 3-5 ticket batches, runs full review only at end)")
)
const learnOption = Options.boolean("learn").pipe(
  Options.withDefault(false),
  Options.withDescription("Capture learnings for pattern optimization (requires --dynamic)")
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
  "  2a) fabrik run --spec specs/feature.json --todo specs/feature.todo.json --vm ralph-1 --project /path/to/repo",
  "      (uses pre-defined tickets from todo file - skips discovery)",
  "  2b) fabrik run --spec specs/feature.md --vm ralph-1 --project /path/to/repo",
  "      (no todo provided - discovers tickets from spec automatically)",
  "  2c) fabrik run --spec specs/feature.md --vm ralph-1 --project /path/to/repo --dynamic",
  "      (batched discovery: discovers 3-5 tickets at a time, iterates until complete)",
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

const runResumeCommand = Command.make(
  "resume",
  {
    id: Options.integer("id").pipe(Options.withDescription("Run id")),
    db: Options.text("db").pipe(
      Options.optional,
      Options.withDescription("Path to ralph.db (default: ~/.cache/ralph/ralph.db)")
    ),
    fix: Options.boolean("fix").pipe(
      Options.withDefault(false),
      Options.withDescription("Attempt to fix 'string or blob too big' errors by truncating large database entries before resuming")
    )
  },
  ({ id, db, fix }) =>
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
      const smithersRunnerDir = `${run.workdir}/smithers-runner`
      const specId = readSpecId(run.spec_path)
      const dbName = specId ? `${specId}.db` : `run-${run.id}.db`
      const smithersDbPath = `${controlDir}/.smithers/${dbName}`

      // Read run context from VM to reconstruct environment
      const contextCmd = `cat "${reportsDir}/run-context.json" 2>/dev/null || echo '{}'`
      const contextJson = runRemote(run.vm_name, contextCmd)
      let context: Record<string, unknown> = {}
      try {
        context = JSON.parse(contextJson) as Record<string, unknown>
      } catch {
        console.log(`[${run.vm_name}] Warning: Could not parse run-context.json`)
      }

      // Build VM paths from context (host paths need to be converted)
      // Spec/todo in VM are stored in specs/ dir with .min.json extension
      const vmSpecPath = context.spec_path 
        ? `${run.workdir}/specs/${basename(context.spec_path as string).replace(/\.mdx?$/, "").replace(/\.json$/, "").replace(/\.min$/, "")}.min.json`
        : `${run.workdir}/specs/spec.min.json`
      const vmTodoPath = context.todo_path
        ? `${run.workdir}/specs/${basename(context.todo_path as string).replace(/\.json$/, "").replace(/\.min$/, "")}.min.json`
        : `${vmSpecPath}.todo.min.json`
      const vmPromptPath = context.prompt_path
        ? `${run.workdir}/${basename(context.prompt_path as string)}`
        : undefined
      const vmReviewPromptPath = context.review_prompt_path
        ? `${run.workdir}/${basename(context.review_prompt_path as string)}`
        : undefined

      // Extract environment variables
      const envVars: string[] = []
      const setEnv = (name: string, value: string | null | undefined) => {
        if (value) envVars.push(`export ${name}="${value.replace(/"/g, '\\"')}"`)
      }

      setEnv("SMITHERS_SPEC_PATH", vmSpecPath)
      setEnv("SMITHERS_TODO_PATH", vmTodoPath)
      if (vmPromptPath) setEnv("SMITHERS_PROMPT_PATH", vmPromptPath)
      if (vmReviewPromptPath) setEnv("SMITHERS_REVIEW_PROMPT_PATH", vmReviewPromptPath)
      if (context.review_models_path) setEnv("SMITHERS_REVIEW_MODELS_FILE", `${run.workdir}/${basename(context.review_models_path as string)}`)
      setEnv("SMITHERS_REPORT_DIR", reportsDir)
      setEnv("SMITHERS_CWD", run.workdir)
      setEnv("SMITHERS_BRANCH", context.branch as string)
      setEnv("SMITHERS_RUN_ID", String(run.id))
      setEnv("SMITHERS_DB_PATH", smithersDbPath)
      setEnv("RALPH_AGENT", (context.agent as string) || "pi")
      setEnv("MAX_ITERATIONS", "100")

      // Optionally fix large database entries
      if (fix) {
        console.log(`[${run.vm_name}] Attempting to fix large database entries...`)
        const fixScript = `python3 - <<'PY'
import sqlite3, json, os
db_path = "${smithersDbPath}"
if not os.path.exists(db_path):
    print("Database not found, skipping fix")
    raise SystemExit(0)
conn = sqlite3.connect(db_path)
try:
    # Find and truncate large entries in task outputs
    MAX_SIZE = 500000  # ~500KB limit per field
    tables_to_check = ['task_report', 'task_output', '_smithers_outputs']
    for table in tables_to_check:
        try:
            cur = conn.execute(f"SELECT name FROM pragma_table_info('{table}')")
            columns = [row[0] for row in cur.fetchall()]
            for col in columns:
                # Truncate text/blob columns that might be too large
                if col in ['output', 'result', 'data', 'content', 'issues', 'next', 'raw']:
                    cur = conn.execute(f"SELECT rowid, {col} FROM {table} WHERE LENGTH({col}) > ?", (MAX_SIZE,))
                    for rowid, val in cur.fetchall():
                        truncated = val[:MAX_SIZE] + "\\n[TRUNCATED: was " + str(len(val)) + " chars]"
                        conn.execute(f"UPDATE {table} SET {col} = ? WHERE rowid = ?", (truncated, rowid))
                        print(f"Truncated {table}.{col} row {rowid}")
            conn.commit()
        except Exception as e:
            print(f"Skipping {table}: {e}")
finally:
    conn.close()
print("Database fix complete")
PY`
        runRemote(run.vm_name, fixScript)
      }

      // Build resume script
      const workflowFile = existsSync(`${smithersRunnerDir}/workflow-dynamic.tsx`) 
        ? "workflow-dynamic.tsx" 
        : "workflow.tsx"

      const resumeScript = [
        `cd "${smithersRunnerDir}"`,
        "export PATH=\"$HOME/.bun/bin:$HOME/.bun/install/global/node_modules/.bin:$PATH\"",
        "if [ -f ~/.config/ralph/ralph.env ]; then set -a; source ~/.config/ralph/ralph.env; set +a; fi",
        "if [ -n \"${GITHUB_TOKEN:-}\" ]; then export GH_TOKEN=\"${GITHUB_TOKEN}\"; fi",
        ...envVars,
        `echo "[${run.vm_name}] Resuming workflow: ${workflowFile}"`,
        `smithers resume ${workflowFile} 2>&1 | tee -a "${reportsDir}/smithers-resume.log"`,
        `echo "${run.id}" > "${controlDir}/resumed.run_id"`
      ].join("\n")

      console.log(`[${run.vm_name}] Resuming run ${run.id}...`)
      console.log(`[${run.vm_name}] Control dir: ${controlDir}`)
      console.log(`[${run.vm_name}] Smithers DB: ${smithersDbPath}`)
      console.log(`[${run.vm_name}] Workflow: ${workflowFile}`)
      if (fix) {
        console.log(`[${run.vm_name}] Database fix mode enabled - large entries will be truncated`)
      }
      console.log("")
      console.log("To watch logs:")
      console.log(`  fabrik run attach --id ${run.id}`)

      runRemoteStream(run.vm_name, resumeScript)
    })
).pipe(Command.withDescription("Resume a failed or interrupted Smithers run"))

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
    requireAgents: requireAgentsOption,
    dynamic: dynamicOption,
    learn: learnOption
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
    requireAgents,
    dynamic,
    learn
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
    // In dynamic mode, don't resolve a default todo path - let dispatch generate one
    // This prevents accidentally using an existing empty todo file
    const resolvedTodo = todoValue ?? (dynamic ? undefined : resolveTodoPath(specValue))
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
          workflow: workflowValue ? resolve(workflowValue) : dynamic 
            ? resolve(home, "smithers-runner/workflow-dynamic.tsx")
            : resolve(home, "smithers-runner/workflow.tsx"),
          reportDir: reportDirValue,
          model: modelValue,
          iterations: iterationsValue ?? undefined,
          follow: followValue,
          branch: branchValue ?? undefined,
          prompt: promptValue ? resolve(promptValue) : undefined,
          reviewPrompt: reviewPromptValue ? resolve(reviewPromptValue) : undefined,
          reviewModels: reviewModelsValue ? resolve(reviewModelsValue) : undefined,
          reviewMax: reviewMaxValue ?? undefined,
          requireAgents: requireAgentsValue ? requireAgentsValue.split(",") : undefined,
          dynamic,
          learn
        })
        printRunNextSteps(result.runId, vmValue, specValue)
        return result
      })
    }
    return Effect.fail(new Error(`Unsupported OS: ${process.platform}`))
  }
).pipe(
  Command.withDescription("Dispatch a Smithers run (immutable workdir)"),
  Command.withSubcommands([runAttachCommand, runResumeCommand])
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

Traditional development accumulates technical debt. Every feature adds complexity.
Compound engineering inverts this: 80% planning, 20% execution.

The result: quality compounds, future changes become easier.

=== THE 10-QUESTION INTERVIEW ===

PRE-INTERVIEW CHECKLIST (all must be checked):
[ ] Clear problem statement - Can you state it in one sentence?
[ ] Boundary understanding - What's explicitly in/out of scope?
[ ] Success criteria - How will we know this is "done"?

Q1: IDENTITY
"What is the unique identifier for this work?"
- Format: kebab-case (e.g., "billing-idempotency", "auth-passwordless")
- Must be unique across all specs
- Used for: filenames, branch names, commit trailers

Q2: TITLE
"What is the one-sentence description?"
- Active voice: "Implement", "Add", "Fix", "Remove"
- NO implementation details
- NO technology names
- Example: "Enable passwordless authentication" NOT "Use WebAuthn API"

Q3: STATUS
Current state: draft | ready | in-progress | review | done | superseded
Start with "draft". Move to "ready" only after interview complete.

Q4: GOALS (3-7 outcomes)
"What MUST this accomplish?"
- Each starts with verb: "Enable", "Provide", "Ensure", "Prevent"
- Measurable when possible
- NO implementation details
- Focus on user/customer success

Q5: NON-GOALS (Critical!)
"What is explicitly OUT of scope?"
- Prevents scope creep
- Lists tempting but excluded features
- Document what you'll do later, not now

Q6: API REQUIREMENTS
"What interfaces and contracts must exist?"
- Function signatures (inputs, outputs, errors)
- Data structures (schemas, validation rules)
- API endpoints (paths, methods, request/response)
- Configuration options (env vars, feature flags)

Q7: BEHAVIOR REQUIREMENTS
"What must happen functionally?"
- Business logic rules
- State transitions and triggers
- Error handling (what happens when things fail?)
- Edge cases (empty inputs, max values, race conditions)

Q8: OBSERVABILITY REQUIREMENTS
"How do we know it's working?"
- Metrics to emit (counters, histograms, gauges)
- Logs to write (events, decisions, errors)
- Alerts needed (conditions, severity, runbooks)
- Health checks (endpoints, thresholds)

Q9: ACCEPTANCE CRITERIA
"How do we verify this is complete?"
- Test scenarios with inputs/expected outputs
- Manual QA steps for UI flows
- Performance thresholds (latency, throughput)
- Security checks (penetration tests, audit logs)

Q10: ASSUMPTIONS
"What are we assuming that could change?"
- External dependencies (APIs, libraries, platforms)
- Platform constraints (OS, hardware, browser versions)
- Timing expectations (response times, SLAs)
- Volume expectations (users, requests, data size)

=== OUTPUT FORMAT ===

Save to: specs/{id}.json

{
  "v": 1,
  "id": "<Q1-kebab-case-id>",
  "title": "<Q2-active-voice-title>",
  "status": "<Q3-status>",
  "version": "1.0.0",
  "lastUpdated": "<ISO-date>",
  "goals": ["<Q4-1>", "<Q4-2>", ...],
  "nonGoals": ["<Q5-1>", "<Q5-2>", ...],
  "req": {
    "api": ["<Q6-1>", "<Q6-2>", ...],
    "behavior": ["<Q7-1>", "<Q7-2>", ...],
    "obs": ["<Q8-1>", "<Q8-2>", ...]
  },
  "accept": ["<Q9-1>", "<Q9-2>", ...],
  "assume": ["<Q10-1>", "<Q10-2>", ...]
}

=== COMPOUND ENGINEERING PRINCIPLES ===

1. PLAN THOROUGHLY BEFORE WRITING CODE
   - Spec is the contract. Changing requirements mid-flight costs 10x.
   - If you can't answer all 10 questions, you don't understand the problem.

2. REVIEW TO CATCH ISSUES AND CAPTURE LEARNINGS
   - Every finding is an opportunity to document patterns.
   - 8 reviewers: Security, Quality, Simplicity, Coverage, Maintainability,
     Tigerstyle, NASA-10-RULES, Correctness-Guarantees

3. CODIFY KNOWLEDGE SO IT'S REUSABLE
   - @property TSDoc names invariants explicitly
   - Branded types prevent primitive obsession
   - Todo templates capture task patterns

4. KEEP QUALITY HIGH SO FUTURE CHANGES ARE EASY
   - 6 Guarantee Layers: Types, Runtime, Persistence, Tests, Monitoring, Simulation
   - Each layer makes the next change safer

=== CRITICALITY TIERS ===

T1 (Critical): Money, auth, signing, irreversible state → ALL 6 layers
T2 (Important): User data, business logic, state machines → L1-L5
T3 (Standard): Features, UI state, caching → L1-L4
T4 (Low): Analytics, logging, metrics → L1, L4

=== NEXT STEP ===

After spec creation, run: fabrik todo generate`;

const specInterviewCommand = Command.make(
  "interview",
  {},
  () =>
    Effect.gen(function*() {
      yield* Console.log(specInterviewPrompt)
    })
).pipe(Command.withDescription("Print complete spec interview guide with 10 questions and compound engineering principles"))

// =============================================================================
// TODO GENERATION COMMAND
// =============================================================================

const todoGeneratePrompt = `COMPOUND ENGINEERING: TODO GENERATION
=====================================

> Plan thoroughly. Review rigorously. Codify knowledge. Compound quality.

INPUT:  specs/{id}.json (from completed interview)
OUTPUT: specs/{id}.todo.json

=== STEP 1: DETERMINE CRITICALITY TIER ===

| Tier | Examples | Layers Required |
|------|----------|-----------------|
| T1 (Critical) | Money, auth, signing, irreversible state | ALL 6 (L1-L5 + Simulation) |
| T2 (Important) | User data, business logic, state machines | L1-L5 |
| T3 (Standard) | Features, UI state, caching | L1-L4 |
| T4 (Low) | Analytics, logging, metrics | L1, L4 |

=== STEP 2: DEFINE DEFINITION OF DONE ===

T1 (Critical) - ALL must be checked:
- [ ] L1: Branded types implemented (no primitive types)
- [ ] L2: Effect.assert for pre/postconditions present
- [ ] L3: DB migration with UNIQUE/CHECK constraints
- [ ] L4: @property TSDoc on every invariant test
- [ ] L4: Property-based tests (conservation, idempotency)
- [ ] L4: 90%+ line coverage, 85%+ branch coverage
- [ ] L5: TODO comments for production alerts
- [ ] L5: Metrics emission points identified
- [ ] L6: Seed-based simulation plan documented
- [ ] Review: All 8 reviewers approved
- [ ] VCS: Code pushed to GitHub branch, CI passes
- [ ] Human: Gate cleared with manual approval

T2 (Important) - ALL must be checked:
- [ ] L1: Branded types for domain values
- [ ] L2: Assertions for key invariants
- [ ] L3: DB constraints for uniqueness/referential integrity
- [ ] L4: Unit tests + property tests for core invariants
- [ ] L4: 85%+ line coverage, 70%+ branch coverage
- [ ] L5: Monitoring TODOs with alert conditions
- [ ] Review: All applicable reviewers passed
- [ ] VCS: Pushed to branch, CI passes

T3-T4 (Standard/Low) - ALL must be checked:
- [ ] L1: Basic typing (strict mode, no any)
- [ ] L2: Input validation at boundaries
- [ ] L4: Unit tests for happy path and errors
- [ ] L4: 80%+ line coverage
- [ ] VCS: Pushed, CI passes

=== STEP 3: SET TDD MODE ===

TDD = true: Logic-heavy code (state machines, calculations, transformations)
TDD = false: Glue/config/setup code

Even with TDD=false, you MUST have tests. They just don't need to be written first.

=== STEP 4: CREATE TASKS (3-15 per spec, max 4 hours each) ===

Task sizing rules:
- Max 4 hours of focused work
- Independent where possible (can parallelize)
- Verifiable with clear "verify" criteria
- Atomic (all-or-nothing completion)

Task ordering: By dependency, not execution
1. Foundation (types, schemas, constraints)
2. Core logic (domain rules, invariants)
3. Integration (APIs, external services)
4. Observability (metrics, alerts, logging)

=== TASK TEMPLATES BY LAYER ===

L1 - TYPES (Foundation):
{
  "id": "1",
  "do": "Define branded types: {DomainId}, {AmountType}, {StatusType}",
  "verify": "Types compile; Schema validates; No primitive string/number in domain code"
}

L1 - STATE MACHINE (Foundation):
{
  "id": "2",
  "do": "Implement phantom types for {Entity}<Status> state machine",
  "verify": "Invalid transitions cause compile-time errors; Match.exhaustive covers all states"
}

L2 - RUNTIME (Core Logic):
{
  "id": "3",
  "do": "Implement {operation} with Effect.assert pre/postconditions",
  "verify": "@property tests: {INVARIANT_1}, {INVARIANT_2}; All assertions pass"
}

L2 - IDEMPOTENCY (Critical Operations):
{
  "id": "4",
  "do": "Implement idempotency key generation and storage",
  "verify": "Duplicate requests with same key return same result; DB UNIQUE constraint prevents duplicates"
}

L3 - PERSISTENCE (DB Schema):
{
  "id": "5",
  "do": "Create migration with constraints: UNIQUE({field}), CHECK({condition})",
  "verify": "Tests confirm constraint rejection at DB level; Schema matches spec requirements"
}

L4 - TESTS (Property-Based):
{
  "id": "6",
  "do": "Add @property TSDoc and property tests for {invariants}",
  "verify": "Property tests pass for: conservation, idempotency, commutativity"
}

L5 - MONITORING (Observability):
{
  "id": "7",
  "do": "Add production TODOs for alerts: {condition} -> {severity}",
  "verify": "TODOs include: alert condition, severity level, runbook link"
}

L6 - SIMULATION (T1 Only):
{
  "id": "8",
  "do": "Document seed-based simulation plan for {invariants}",
  "verify": "Plan includes: seed generation, operations_per_seed, invariant checks, failure injection"
}

=== @PROPERTY NAMING CONVENTIONS ===

Name invariants explicitly with UPPER_SNAKE_CASE:

Billing:
- CANCELED_NEVER_CHARGED
- NO_DOUBLE_CHARGE
- PERIOD_ADVANCES_ONCE
- MONEY_CONSERVED

Auth:
- TOKEN_EXPIRES_CORRECTLY
- SESSION_ISOLATION_HOLDS
- PERMISSION_CHECKS_ALWAYS_RUN

State Machines:
- INVALID_TRANSITIONS_BLOCKED
- STATE_CONSISTENCY_MAINTAINED

=== OUTPUT FORMAT ===

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

=== QUALITY CHECKLIST ===

Before finalizing todo:
- [ ] Tier appropriate for risk level
- [ ] DoD complete for the tier
- [ ] TDD flag matches actual requirements
- [ ] Tasks sized (1-4 hours max)
- [ ] Ordered by dependency
- [ ] Every task has verifiable criteria
- [ ] All required guarantee layers have tasks
- [ ] @property names are explicit and UPPER_SNAKE_CASE
- [ ] Critical paths have extra verification tasks

=== COMPOUND ENGINEERING IMPACT ===

Each todo is a teaching document:
- New team member reads it -> understands architecture
- Future spec references it -> reuses patterns
- Reviewer checks against it -> consistent quality
- Operations uses it -> knows what to monitor

Each todo makes the next easier:
- Task templates get refined
- Common patterns emerge
- Reviews get faster
- Implementation gets safer

The flywheel effect: Month 1 (slower) -> Month 6 (same speed, fewer bugs) -> Month 12 (2-3x velocity)`;

const todoGenerateCommand = Command.make(
  "generate",
  {},
  () =>
    Effect.gen(function*() {
      yield* Console.log(todoGeneratePrompt)
    })
).pipe(Command.withDescription("Print complete todo generation guide with compound engineering principles"))

const specsCommand = Command.make("spec").pipe(
  Command.withSubcommands([validateCommand, minifyCommand, specsStatusCommand, specInterviewCommand])
)

const todoCommand = Command.make("todo").pipe(
  Command.withSubcommands([todoGenerateCommand])
)

// =============================================================================
// PATTERNS COMMAND (Learning Management)
// =============================================================================

const patternsShowCommand = Command.make(
  "show",
  { dir: Options.text("dir").pipe(Options.withDefault("."), Options.withDescription("Repo root directory")) },
  ({ dir }) =>
    Effect.sync(() => {
      const { loadRepoPatterns } = require("./learning.js")
      const patterns = loadRepoPatterns(resolve(dir))
      
      if (patterns.length === 0) {
        console.log("No patterns learned yet. Run with --dynamic --learn to start capturing learnings.")
        return
      }
      
      console.log("=== Learned Patterns ===\n")
      for (const p of patterns) {
        console.log(`Task Type: ${p.taskType}`)
        console.log(`  Tier: ${p.tier} (confidence: ${(p.confidence * 100).toFixed(0)}%, n=${p.sampleSize})`)
        console.log(`  Reviews: [${p.reviews.join(", ") || "none"}]`)
        console.log(`  Model: ${p.model}`)
        console.log(`  Gates: [${p.gates.join(", ")}]`)
        console.log(`  Avg Cost: $${p.avgCostUsd.toFixed(2)}, Avg Hours: ${p.avgHours.toFixed(1)}`)
        console.log("")
      }
    })
).pipe(Command.withDescription("Show learned patterns for this repo"))

const patternsResetCommand = Command.make(
  "reset",
  { dir: Options.text("dir").pipe(Options.withDefault("."), Options.withDescription("Repo root directory")) },
  ({ dir }) =>
    Effect.sync(() => {
      const { rmSync } = require("node:fs")
      const patternsPath = join(resolve(dir), ".fabrik/patterns.json")
      const learningsPath = join(resolve(dir), ".fabrik/learnings.jsonl")
      
      let removed = 0
      if (existsSync(patternsPath)) {
        rmSync(patternsPath)
        removed++
      }
      if (existsSync(learningsPath)) {
        rmSync(learningsPath)
        removed++
      }
      
      console.log(removed > 0 
        ? `Reset ${removed} learning file(s). Patterns will be rebuilt from future runs.`
        : "No learning files found.")
    })
).pipe(Command.withDescription("Reset all learned patterns (irreversible)"))

const patternsCommand = Command.make("patterns").pipe(
  Command.withDescription("Manage learned patterns for adaptive optimization"),
  Command.withSubcommands([patternsShowCommand, patternsResetCommand])
)

const credentialsCommand = Command.make("credentials").pipe(
  Command.withSubcommands([
    Command.make(
      "init",
      {},
      () => Effect.sync(() => createRalphEnv())
    ).pipe(Command.withDescription("Create ~/.config/ralph/ralph.env template")),
    Command.make(
      "sync",
      { vm: vmOption },
      ({ vm }) => Effect.sync(() => syncCredentials({ vm }))
    ).pipe(Command.withDescription("Sync host credentials into a VM")),
    Command.make(
      "validate",
      {},
      () => Effect.sync(() => {
        const result = validateRalphEnvHost()
        
        if (!result.valid) {
          console.log("❌ ralph.env validation failed:")
          result.issues.forEach(i => console.log(i))
          console.log("\nRun: fabrik credentials init to create template")
          process.exit(1)
        }
        
        console.log("✅ ralph.env is valid")
        console.log("   - All variables properly exported")
        console.log("   - Required keys present")
      })
    ).pipe(Command.withDescription("Validate ralph.env has proper exports and required keys")),
    Command.make(
      "test",
      { vm: vmOption },
      ({ vm }) => Effect.sync(() => {
        console.log(`Testing API keys in VM: ${vm}`)
        console.log("")
        
        const { success, results } = testApiKeysInVm(vm)
        
        for (const [key, value] of Object.entries(results)) {
          const icon = value ? "✅" : "❌"
          console.log(`${icon} ${key}: ${value ? "working" : "failed/missing"}`)
        }
        
        console.log("")
        if (success) {
          console.log("✅ All required API keys working")
        } else {
          console.log("❌ Some API keys not working. Run: fabrik credentials sync --vm " + vm)
          process.exit(1)
        }
      })
    ).pipe(Command.withDescription("Test API keys are working in a VM"))
  ])
)

const vmListCommand = Command.make(
  "list",
  {},
  () => Effect.sync(() => printVmList())
).pipe(Command.withDescription("List all Ralph VMs"))

const vmCleanupCommand = Command.make(
  "cleanup",
  {
    all: Options.boolean("all").pipe(Options.withDefault(false), Options.withDescription("Delete all Ralph VMs")),
    force: Options.boolean("force").pipe(Options.withDefault(false), Options.withDescription("Confirm deletion without prompt")),
    vms: Options.text("vms").pipe(Options.optional, Options.withDescription("Comma-separated VM names to delete"))
  },
  ({ all, force, vms }) =>
    Effect.sync(() => {
      const vmList = vms ? vms.split(",").map(s => s.trim()).filter(Boolean) : undefined
      cleanupVms({ vms: vmList, all, force })
    })
).pipe(Command.withDescription("Cleanup Ralph VMs"))

const vmCommand = Command.make("vm").pipe(
  Command.withDescription("Manage Ralph VMs"),
  Command.withSubcommands([vmListCommand, vmCleanupCommand])
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
        workflow: workflowValue ? resolve(workflowValue) : resolve(defaultRalphHome, "smithers-runner/workflow.tsx"),
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
    patternsCommand,
    feedbackCommand,
    cleanupCommand,
    fleetCommand,
    docsCommand,
    flowCommand,
    knownIssuesCommand,
    runsCommand,
    laosCommand,
    credentialsCommand,
    vmCommand,
    orchestrateCommand
  ])
)

export const run = Command.run(cli, {
  name: "Local Fabrik CLI",
  version: CLI_VERSION
})
