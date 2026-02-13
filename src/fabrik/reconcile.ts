import { runCommand, runCommandOutput } from "./exec.js"
import { openRunDb, updateRunStatus as updateRunStatusDb } from "./runDb.js"
import { getVmIp } from "./vm-utils.js"

type RunRecord = {
  id: number
  vm: string
  workdir: string
  status: string
  exitCode: number | null
  failureReason: string | null
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

const readFailureReason = (vm: string, reportDir: string) => {
  const script = `
import os
path = os.path.join("${reportDir}", "smithers.log")
if not os.path.exists(path):
  print('')
  raise SystemExit(0)
try:
  with open(path, 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.read().splitlines()
except Exception:
  print('')
  raise SystemExit(0)
window = lines[-80:]
errors = [line for line in window if '✗' in line or 'ERROR' in line or 'Error:' in line or 'Task failed' in line]
if not errors:
  errors = window[-20:]
text = '\\n'.join(errors).strip()
if len(text) > 2000:
  text = text[-2000:]
print(text)
`
  return runRemote(vm, `python3 - <<'PY'\n${script}\nPY`).trim()
}

const isHeartbeatStale = (ts: string, thresholdSeconds: number) => {
  if (!ts) return true
  const parsed = Date.parse(ts)
  if (!Number.isFinite(parsed)) return true
  return Date.now() - parsed > thresholdSeconds * 1000
}

const updateRunStatus = (
  dbPath: string,
  runId: number,
  status: string,
  exitCode: number | null,
  failureReason?: string | null
) => {
  const { db } = openRunDb(dbPath)
  updateRunStatusDb(db, runId, status, exitCode, failureReason ?? null)
  db.close()
}

export type ReconcileOptions = {
  dbPath: string
  limit?: number
  heartbeatSeconds?: number
}

export const reconcileRuns = ({ dbPath, limit = 50, heartbeatSeconds = 120 }: ReconcileOptions) => {
  const { db } = openRunDb(dbPath)
  const rows = db
    .query<{ id: number; vm_name: string; workdir: string; status: string; exit_code: number | null; failure_reason: string | null }>(
      "SELECT id, vm_name, workdir, status, exit_code, failure_reason FROM runs ORDER BY started_at DESC LIMIT ?"
    )
    .all(limit)
  db.close()
  if (!rows.length) return
  const runs: RunRecord[] = rows.map((row) => ({
    id: row.id,
    vm: row.vm_name,
    workdir: row.workdir,
    status: row.status,
    exitCode: row.exit_code,
    failureReason: row.failure_reason
  }))

  for (const run of runs) {
    const workBase = run.workdir.split("/").pop() ?? ""
    const controlDir = `/home/ralph/work/${run.vm}/.runs/${workBase}`
    const reportDir = `${controlDir}/reports`

    if (run.status !== "running") {
      if (run.status === "failed" && !run.failureReason) {
        const exitCode = run.exitCode ?? readExitCode(run.vm, controlDir)
        const failureReason = readFailureReason(run.vm, reportDir)
        if (exitCode !== null || failureReason) {
          updateRunStatus(dbPath, run.id, "failed", exitCode ?? 1, failureReason || null)
        }
      }
      continue
    }

    const pid = readPid(run.vm, controlDir)
    const exitCode = readExitCode(run.vm, controlDir)
    if (exitCode !== null) {
      const failureReason = exitCode === 0 ? null : readFailureReason(run.vm, reportDir)
      updateRunStatus(dbPath, run.id, exitCode === 0 ? "done" : "failed", exitCode, failureReason || null)
      continue
    }
    const heartbeatTs = readHeartbeat(run.vm, controlDir)
    const staleHeartbeat = isHeartbeatStale(heartbeatTs, heartbeatSeconds)
    if (!pid && staleHeartbeat) {
      updateRunStatus(dbPath, run.id, "failed", 1, "stale_process")
      continue
    }
    if (pid && !isProcessAlive(run.vm, pid)) {
      if (staleHeartbeat) {
        updateRunStatus(dbPath, run.id, "failed", 1, "stale_process")
      }
      continue
    }
  }
}
