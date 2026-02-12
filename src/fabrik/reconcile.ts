import { execFileSync } from "node:child_process"

type RunRecord = {
  id: number
  vm: string
  workdir: string
  status: string
}

const sshOpts = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]

const getVmIp = (vm: string) => {
  const raw = execFileSync("virsh", ["domifaddr", vm]).toString().split("\n")
  const line = raw.map((l) => l.trim()).find((l) => l.includes("ipv4"))
  return line?.split(/\s+/)[3]?.split("/")[0]
}

const runRemote = (vm: string, command: string) => {
  if (process.platform === "darwin") {
    return execFileSync("limactl", ["shell", "--workdir", "/home/ralph", vm, "bash", "-lc", command]).toString()
  }
  if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    return execFileSync("ssh", [...sshOpts, `ralph@${ip}`, command]).toString()
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
  endReason: string | null = null
) => {
  const script = `
import sqlite3, sys
db_path = sys.argv[1]
run_id = int(sys.argv[2])
status = sys.argv[3]
exit_code = sys.argv[4]
end_reason = sys.argv[5]
conn = sqlite3.connect(db_path)
try:
  conn.execute('ALTER TABLE runs ADD COLUMN end_reason TEXT')
except Exception:
  pass
conn.execute(
  'UPDATE runs SET status = ?, exit_code = ?, end_reason = ? WHERE id = ?',
  (
    status,
    None if exit_code == 'null' else int(exit_code),
    None if end_reason == 'null' else end_reason,
    run_id
  )
)
conn.commit()
conn.close()
`
  execFileSync(
    "python3",
    ["-", dbPath, String(runId), status, exitCode === null ? "null" : String(exitCode), endReason ?? "null"],
    { input: script }
  )
}

export type ReconcileOptions = {
  dbPath: string
  limit?: number
  heartbeatSeconds?: number
}

export const reconcileRuns = ({ dbPath, limit = 50, heartbeatSeconds = 60 }: ReconcileOptions) => {
  const script = `
import sqlite3, sys
db_path = sys.argv[1]
limit = int(sys.argv[2])
conn = sqlite3.connect(db_path)
cur = conn.execute('SELECT id, vm_name, workdir, status FROM runs ORDER BY started_at DESC LIMIT ?', (limit,))
rows = cur.fetchall()
conn.close()
for row in rows:
  print('|'.join(str(x) for x in row))
`
  const output = execFileSync("python3", ["-", dbPath, String(limit)], { input: script }).toString().trim()
  if (!output) return
  const lines = output.split("\n")
  const runs: RunRecord[] = lines.map((line) => {
    const [id, vm, workdir, status] = line.split("|")
    return { id: Number(id), vm, workdir, status }
  })

  for (const run of runs) {
    if (run.status !== "running") continue
    const workBase = run.workdir.split("/").pop() ?? ""
    const controlDir = `/home/ralph/work/${run.vm}/.runs/${workBase}`
    const pid = readPid(run.vm, controlDir)
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
