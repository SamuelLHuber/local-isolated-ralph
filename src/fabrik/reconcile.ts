import { runCommand, runCommandOutput } from "./exec.js"
import { openRunDb, updateRunStatus as updateRunStatusDb } from "./runDb.js"
import { getVmIp } from "./vm-utils.js"

type RunRecord = {
  id: number
  vm: string
  workdir: string
  status: string
}

const sshOpts = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]

const runRemote = (vm: string, command: string) => {
  if (process.platform === "darwin") {
    return runCommandOutput("limactl", ["shell", "--workdir", "/home/ralph", vm, "bash", "-lc", command], {
      context: `run ${command} on ${vm}`
    })
  }
  if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    return runCommandOutput("ssh", [...sshOpts, `ralph@${ip}`, command], { context: `run ${command} on ${vm}` })
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

const isProcessAlive = (vm: string, pid: string) => {
  const script = `
import os, sys
pid = int(sys.argv[1])
try:
  os.kill(pid, 0)
  print('1')
except Exception:
  print('')
`
  const output = runRemote(vm, `python3 - <<'PY'\n${script}\nPY\n${pid}`).trim()
  return output === "1"
}

const readHeartbeat = (vm: string, controlDir: string) => {
  const script = `
import json, os
path = os.path.join("${controlDir}", "heartbeat.json")
if not os.path.exists(path):
  print('')
  raise SystemExit(0)
try:
  with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)
  print(data.get('ts',''))
except Exception:
  print('')
`
  return runRemote(vm, `python3 - <<'PY'\n${script}\nPY`).trim()
}

const readPid = (vm: string, controlDir: string) => {
  const script = `
import os
path = os.path.join("${controlDir}", "smithers.pid")
if not os.path.exists(path):
  print('')
else:
  try:
    with open(path, 'r', encoding='utf-8') as f:
      print(f.read().strip())
  except Exception:
    print('')
`
  return runRemote(vm, `python3 - <<'PY'\n${script}\nPY`).trim()
}

const readExitCode = (vm: string, controlDir: string) => {
  const script = `
import os
path = os.path.join("${controlDir}", "exit_code")
if not os.path.exists(path):
  print('')
else:
  try:
    with open(path, 'r', encoding='utf-8') as f:
      print(f.read().strip())
  except Exception:
    print('')
`
  const output = runRemote(vm, `python3 - <<'PY'\n${script}\nPY`).trim()
  if (!output) return null
  const parsed = Number(output)
  return Number.isFinite(parsed) ? parsed : null
}

const isHeartbeatStale = (ts: string, thresholdSeconds: number) => {
  if (!ts) return true
  const parsed = Date.parse(ts)
  if (!Number.isFinite(parsed)) return true
  return Date.now() - parsed > thresholdSeconds * 1000
}

const updateRunStatus = (dbPath: string, runId: number, status: string, exitCode: number | null) => {
  const { db } = openRunDb(dbPath)
  updateRunStatusDb(db, runId, status, exitCode)
  db.close()
}

export type ReconcileOptions = {
  dbPath: string
  limit?: number
  heartbeatSeconds?: number
}

export const reconcileRuns = ({ dbPath, limit = 50, heartbeatSeconds = 60 }: ReconcileOptions) => {
  const { db } = openRunDb(dbPath)
  const rows = db
    .query<{ id: number; vm_name: string; workdir: string; status: string }>(
      "SELECT id, vm_name, workdir, status FROM runs ORDER BY started_at DESC LIMIT ?"
    )
    .all(limit)
  db.close()
  if (!rows.length) return
  const runs: RunRecord[] = rows.map((row) => ({
    id: row.id,
    vm: row.vm_name,
    workdir: row.workdir,
    status: row.status
  }))

  for (const run of runs) {
    if (run.status !== "running") continue
    const workBase = run.workdir.split("/").pop() ?? ""
    const controlDir = `/home/ralph/work/${run.vm}/.runs/${workBase}`
    const pid = readPid(run.vm, controlDir)
    const exitCode = readExitCode(run.vm, controlDir)
    if (exitCode !== null) {
      updateRunStatus(dbPath, run.id, exitCode === 0 ? "done" : "failed", exitCode)
      continue
    }
    const heartbeatTs = readHeartbeat(run.vm, controlDir)
    const staleHeartbeat = isHeartbeatStale(heartbeatTs, heartbeatSeconds)
    if (!pid && staleHeartbeat) {
      updateRunStatus(dbPath, run.id, "failed", 1)
      continue
    }
    if (pid && !isProcessAlive(run.vm, pid)) {
      if (staleHeartbeat) {
        updateRunStatus(dbPath, run.id, "failed", 1)
      }
      continue
    }
  }
}
