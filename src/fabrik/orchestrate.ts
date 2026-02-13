import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { dispatchRun, type DispatchResult } from "./dispatch.js"
import { runCommand, runCommandOutput } from "./exec.js"
import { ensureCommands } from "./prereqs.js"
import { openRunDb, updateRunStatus as updateRunStatusDb } from "./runDb.js"

type OrchestrateOptions = {
  specs: string[]
  vms: string[]
  todo?: string[]
  project?: string
  repoUrl?: string
  repoRef?: string
  repoBranch?: string
  includeGit?: boolean
  workflow?: string
  prompt?: string
  reviewPrompt?: string
  reviewModels?: string
  reviewMax?: number
  requireAgents?: string[]
  branchPrefix?: string
  iterations?: number
  intervalSeconds?: number
}

type RunStatus = {
  vm: string
  runId: number
  reportDir: string
  workdir: string
  specId: string
  dbPath: string
  status: "running" | "blocked" | "done"
  blockedTask?: string
}

const updateRunStatus = (runId: number, status: "running" | "blocked" | "done", exitCode: number | null) => {
  const dbPath = resolve(process.env.HOME ?? "", ".cache", "ralph", "ralph.db")
  if (!existsSync(dbPath)) return
  const { db } = openRunDb(dbPath)
  updateRunStatusDb(db, runId, status, exitCode)
  db.close()
}

const sleep = (ms: number) => new Promise((resolveFn) => setTimeout(resolveFn, ms))

const resolveTodoPath = (specPath: string) => {
  if (specPath.endsWith(".todo.min.json")) return specPath
  if (specPath.endsWith(".min.json")) return specPath.replace(/\.min\.json$/i, ".todo.min.json")
  if (specPath.endsWith(".todo.json")) return specPath
  if (specPath.endsWith(".json")) return specPath.replace(/\.json$/i, ".todo.json")
  return `${specPath}.todo.json`
}

const runRemote = (vm: string, command: string) => {
  if (process.platform === "darwin") {
    return runCommandOutput("limactl", ["shell", "--workdir", "/home/ralph", vm, "bash", "-lc", command], {
      context: `run ${command} on ${vm}`
    })
  }
  if (process.platform === "linux") {
    const ip = runCommandOutput("virsh", ["domifaddr", vm], { context: "find VM IP" })
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes("ipv4"))
      ?.split(/\s+/)[3]
      ?.split("/")[0]
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    return runCommandOutput(
      "ssh",
      ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", `ralph@${ip}`, command],
      { context: `run ${command} on ${vm}` }
    )
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

const findBlockedTask = (vm: string, dbPath: string, runId: number) => {
  const script = `
import json, os, sqlite3
path = "${dbPath}"
run_id = "${runId}"
if not os.path.exists(path):
  raise SystemExit(0)
conn = sqlite3.connect(path)
try:
  cur = conn.execute(
    "SELECT task_id, node_id, status, issues, next FROM task_report WHERE run_id = ? AND status IN ('blocked','failed') ORDER BY node_id LIMIT 1",
    (run_id,)
  )
  row = cur.fetchone()
  if row:
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
    issues = "; ".join(parse_list(issues_raw))
    nxt = "; ".join(parse_list(next_raw))
    print("|".join([str(task_id or node_id or ""), str(status or ""), issues, nxt]))
finally:
  conn.close()
`
  const output = runRemote(vm, `python3 - <<'PY'\n${script}\nPY`).trim()
  return output || ""
}

const readSmithersRunStatus = (vm: string, dbPath: string, runId: number) => {
  const script = `
import os, sqlite3
path = "${dbPath}"
run_id = "${runId}"
if not os.path.exists(path):
  raise SystemExit(0)
conn = sqlite3.connect(path)
try:
  cur = conn.execute("SELECT status FROM _smithers_runs WHERE run_id = ? ORDER BY started_at_ms DESC LIMIT 1", (run_id,))
  row = cur.fetchone()
  if row and row[0]:
    print(str(row[0]))
finally:
  conn.close()
`
  return runRemote(vm, `python3 - <<'PY'\n${script}\nPY`).trim()
}

export const orchestrateRuns = async (options: OrchestrateOptions) => {
  if (options.specs.length !== options.vms.length) {
    throw new Error("orchestrate: specs and vms must have the same length")
  }
  if (process.platform === "darwin") {
    ensureCommands([{ cmd: "limactl" }], "orchestrate requires limactl")
  } else if (process.platform === "linux") {
    ensureCommands([{ cmd: "virsh" }, { cmd: "ssh" }], "orchestrate requires virsh + ssh")
  } else {
    throw new Error(`Unsupported OS: ${process.platform}`)
  }
  const runs: DispatchResult[] = []
  const interval = options.intervalSeconds ?? 30
  const branchPrefix = options.branchPrefix?.trim() || "spec"

  for (let i = 0; i < options.specs.length; i++) {
    const spec = resolve(options.specs[i])
    if (!existsSync(spec)) {
      throw new Error(`Spec not found: ${spec}`)
    }
    const vm = options.vms[i]
    const todo = options.todo?.[i]
    const run = dispatchRun({
      vm,
      spec,
      todo: todo ?? resolveTodoPath(spec),
      project: options.project,
      repoUrl: options.repoUrl,
      repoRef: options.repoRef ?? options.repoBranch,
      includeGit: Boolean(options.includeGit),
      workflow: options.workflow,
      prompt: options.prompt,
      reviewPrompt: options.reviewPrompt,
      reviewModels: options.reviewModels,
      reviewMax: options.reviewMax,
      requireAgents: options.requireAgents,
      branch: `${branchPrefix}-${vm}`,
      iterations: options.iterations,
      follow: false
    })
    runs.push(run)
  }

  console.log("Orchestration started. Watching for completion...")
  const statuses: RunStatus[] = runs.map((run) => {
    const dbName = run.specId ? `${run.specId}.db` : `run-${run.runId}.db`
    return {
      vm: run.vm,
      runId: run.runId,
      reportDir: run.reportDir,
      workdir: run.workdir,
      specId: run.specId,
      dbPath: `${run.controlDir}/.smithers/${dbName}`,
      status: "running"
    }
  })

  while (true) {
    let allDone = true
    for (const status of statuses) {
      if (status.status !== "running") continue
      const blockedPayload = findBlockedTask(status.vm, status.dbPath, status.runId)
      if (blockedPayload) {
        const [taskId] = blockedPayload.split("|")
        status.status = "blocked"
        status.blockedTask = taskId || "unknown"
        console.log(`[${status.vm}] blocked on ${status.blockedTask}`)
        updateRunStatus(status.runId, "blocked", 1)
        continue
      }
      const runStatus = readSmithersRunStatus(status.vm, status.dbPath, status.runId)
      if (["finished", "failed", "cancelled", "waiting-approval"].includes(runStatus)) {
        status.status = "done"
        console.log(`[${status.vm}] done (smithers status=${runStatus || "unknown"})`)
        updateRunStatus(status.runId, "done", runStatus === "failed" ? 1 : 0)
        continue
      }
      allDone = false
    }
    if (allDone) break
    await sleep(interval * 1000)
  }

  return statuses
}
