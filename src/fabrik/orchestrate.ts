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

const findBlockedTask = (vm: string, reportDir: string) => {
  const script = `
import json, os
path = "${reportDir}"
if not os.path.isdir(path):
  raise SystemExit(0)
for name in os.listdir(path):
  if not name.endswith(".report.json"):
    continue
  try:
    with open(os.path.join(path, name)) as f:
      data = json.load(f)
    if data.get("status") == "blocked":
      print(data.get("taskId", ""))
      raise SystemExit(0)
  except Exception:
    continue
`
  const output = runRemote(vm, `python3 - <<'PY'\n${script}\nPY`).trim()
  return output || ""
}

const hasHumanGate = (vm: string, reportDir: string) => {
  const script = `
import os
print("1" if os.path.exists("${reportDir}/human-gate.json") else "")
`
  return runRemote(vm, `python3 - <<'PY'\n${script}\nPY`).trim() === "1"
}

const isSmithersDone = (vm: string, workdir: string, specId: string) => {
  if (!specId) return false
  const script = `
import os, sqlite3
db_path = "${workdir}/.smithers/${specId}.db"
if not os.path.exists(db_path):
  raise SystemExit(0)
conn = sqlite3.connect(db_path)
try:
  cur = conn.execute("SELECT value FROM state WHERE key = 'task.done' LIMIT 1")
  row = cur.fetchone()
  if row and str(row[0]) == "1":
    print("1")
finally:
  conn.close()
`
  return runRemote(vm, `python3 - <<'PY'\n${script}\nPY`).trim() === "1"
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
      todo: todo ?? spec.replace(/\.min\.json$/i, ".todo.min.json"),
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
  const statuses: RunStatus[] = runs.map((run) => ({
    vm: run.vm,
    runId: run.runId,
    reportDir: run.reportDir,
    workdir: run.workdir,
    specId: run.specId,
    status: "running"
  }))

  while (true) {
    let allDone = true
    for (const status of statuses) {
      if (status.status !== "running") continue
      const blockedTask = findBlockedTask(status.vm, status.reportDir)
      if (blockedTask) {
        status.status = "blocked"
        status.blockedTask = blockedTask
        console.log(`[${status.vm}] blocked on ${blockedTask}`)
        updateRunStatus(status.runId, "blocked", 1)
        continue
      }
      if (isSmithersDone(status.vm, status.workdir, status.specId)) {
        status.status = "done"
        console.log(`[${status.vm}] done (smithers task.done=1)`)
        updateRunStatus(status.runId, "done", 0)
        continue
      }
      if (hasHumanGate(status.vm, status.reportDir)) {
        status.status = "done"
        console.log(`[${status.vm}] done (human gate written)`)
        updateRunStatus(status.runId, "done", 0)
        continue
      }
      allDone = false
    }
    if (allDone) break
    await sleep(interval * 1000)
  }

  return statuses
}
