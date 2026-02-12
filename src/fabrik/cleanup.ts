import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { runCommand, runCommandOutput } from "./exec.js"
import { ensureCommands } from "./prereqs.js"
import { openRunDb, resolveDbPath } from "./runDb.js"

type CleanupOptions = {
  vm: string
  keep?: number
  dryRun?: boolean
  dbPath?: string
}

const sshOpts = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]

const getVmIp = (vm: string) => {
  const output = runCommandOutput("virsh", ["domifaddr", vm], { context: "find VM IP" })
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.includes("ipv4"))
  return line?.split(/\s+/)[3]?.split("/")[0]
}

const runRemote = (vm: string, command: string) => {
  if (process.platform === "darwin") {
    return runCommand("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "-i", "--", "bash", "-lc", command], {
      context: `run on ${vm}`
    })
  }
  if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    return runCommand("ssh", [...sshOpts, `ralph@${ip}`, "bash", "-lc", command], { context: `run on ${vm}` })
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

export const cleanupWorkdirs = ({ vm, keep, dryRun, dbPath }: CleanupOptions) => {
  const keepCount = typeof keep === "number" && Number.isFinite(keep) ? keep : 5
  const resolvedDbPath = resolveDbPath(dbPath)
  if (!existsSync(resolvedDbPath)) {
    console.log(`No DB found at ${resolvedDbPath}`)
    return
  }
  const { db } = openRunDb(dbPath)
  const rows = db
    .query<{ workdir: string }>("SELECT workdir FROM runs WHERE vm_name = ? ORDER BY started_at DESC")
    .all(vm)
  db.close()

  const workdirs = rows.map((row) => row.workdir).slice(keepCount)
  if (workdirs.length === 0) {
    console.log(`Nothing to clean for ${vm} (keeping ${keepCount}).`)
    return
  }

  if (process.platform === "darwin") {
    ensureCommands([{ cmd: "limactl" }], "cleanup requires limactl")
  } else if (process.platform === "linux") {
    ensureCommands([{ cmd: "virsh" }, { cmd: "ssh" }], "cleanup requires virsh + ssh")
  } else {
    throw new Error(`Unsupported OS: ${process.platform}`)
  }

  console.log(`Cleaning workdirs for ${vm} (keeping ${keepCount}):`)
  for (const workdir of workdirs) {
    if (!workdir.startsWith(`/home/ralph/work/${vm}/`)) {
      console.log(`Skipping unexpected path: ${workdir}`)
      continue
    }
    if (dryRun) {
      console.log(`[dry-run] rm -rf ${workdir}`)
      continue
    }
    console.log(`rm -rf ${workdir}`)
    runRemote(vm, `rm -rf "${workdir}"`)
  }
}
