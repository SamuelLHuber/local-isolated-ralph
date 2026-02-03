import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { dispatchRun, type DispatchResult } from "./dispatch.js"

type OrchestrateOptions = {
  specs: string[]
  vms: string[]
  todo?: string[]
  project?: string
  repoUrl?: string
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
  runId: string
  reportDir: string
  workdir: string
  specId: string
  status: "running" | "blocked" | "done"
  blockedTask?: string
}

const updateRunStatus = (runId: string, status: "running" | "blocked" | "done", exitCode: number | null) => {
  const dbPath = resolve(process.env.HOME ?? "", ".cache", "ralph", "ralph.db")
  if (!existsSync(dbPath)) return
  const script = `
import sqlite3, sys
db_path = sys.argv[1]
rid = int(sys.argv[2])
status = sys.argv[3]
exit_code = sys.argv[4]
conn = sqlite3.connect(db_path)
conn.execute('UPDATE runs SET status = ?, exit_code = ? WHERE id = ?', (status, None if exit_code == 'null' else int(exit_code), rid))
conn.commit()
conn.close()
`
  execFileSync("python3", ["-", dbPath, runId, status, exitCode === null ? "null" : String(exitCode)], {
    input: script
  })
}

const sleep = (ms: number) => new Promise((resolveFn) => setTimeout(resolveFn, ms))

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
      repoBranch: options.repoBranch,
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
