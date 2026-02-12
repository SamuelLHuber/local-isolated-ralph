import { basename, dirname, join, resolve } from "node:path"
import { runCommand } from "./exec.js"
import { ensureCommands } from "./prereqs.js"
import { getVmIp } from "./vm-utils.js"
import { findLatestRunForVmSpec, findRunById, insertFeedback, openRunDb } from "./runDb.js"

type FeedbackOptions = {
  vm: string
  spec: string
  decision: string
  notes: string
  dbPath?: string
}

const sshOpts = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]

const writeJsonRemote = (vm: string, path: string, json: string) => {
  if (process.platform === "darwin") {
    runCommand("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "tee", path], {
      input: json,
      context: `write ${path} in ${vm}`
    })
    return
  }
  if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    runCommand("ssh", [...sshOpts, `ralph@${ip}`, "bash", "-lc", `cat > '${path}'`], {
      input: json,
      context: `write ${path} in ${vm}`
    })
    return
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

const ensureDirRemote = (vm: string, dir: string) => {
  if (process.platform === "darwin") {
    runCommand("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "mkdir", "-p", dir], {
      context: `create ${dir} in ${vm}`
    })
    return
  }
  if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    runCommand("ssh", [...sshOpts, `ralph@${ip}`, "bash", "-lc", `mkdir -p '${dir}'`], {
      context: `create ${dir} in ${vm}`
    })
    return
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

const writeFeedbackFile = (vm: string, workdir: string, decision: string, notes: string) => {
  const controlDir = join(dirname(workdir), ".runs", basename(workdir))
  const reportDirs = [join(controlDir, "reports"), join(workdir, "reports")]
  const payload = JSON.stringify({ v: 1, decision, notes }, null, 2) + "\n"
  let lastError: unknown = null

  for (const reportDir of reportDirs) {
    try {
      ensureDirRemote(vm, reportDir)
      writeJsonRemote(vm, `${reportDir}/human-feedback.json`, payload)
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

export const recordFeedback = ({ vm, spec, decision, notes, dbPath }: FeedbackOptions) => {
  if (process.platform === "darwin") {
    ensureCommands([{ cmd: "limactl" }], "feedback requires limactl")
  } else if (process.platform === "linux") {
    ensureCommands([{ cmd: "virsh" }, { cmd: "ssh" }], "feedback requires virsh + ssh")
  } else {
    throw new Error(`Unsupported OS: ${process.platform}`)
  }

  const specPath = resolve(spec)
  const { db } = openRunDb(dbPath)
  const run = findLatestRunForVmSpec(db, vm, specPath)
  if (!run) {
    db.close()
    throw new Error(`No run found for vm=${vm} spec=${specPath}`)
  }

  insertFeedback(db, {
    runId: run.id,
    vm,
    spec: specPath,
    decision,
    notes,
    createdAt: new Date().toISOString()
  })
  db.close()

  writeFeedbackFile(vm, run.workdir, decision, notes)
  console.log(`Recorded human feedback for run ${run.id}.`)
}

export const recordFeedbackForRun = (options: { runId: number; decision: string; notes: string; dbPath?: string }) => {
  if (process.platform === "darwin") {
    ensureCommands([{ cmd: "limactl" }], "feedback requires limactl")
  } else if (process.platform === "linux") {
    ensureCommands([{ cmd: "virsh" }, { cmd: "ssh" }], "feedback requires virsh + ssh")
  } else {
    throw new Error(`Unsupported OS: ${process.platform}`)
  }

  const { db } = openRunDb(options.dbPath)
  const run = findRunById(db, options.runId)
  if (!run) {
    db.close()
    throw new Error(`Run not found: ${options.runId}`)
  }

  insertFeedback(db, {
    runId: run.id,
    vm: run.vm_name,
    spec: run.spec_path,
    decision: options.decision,
    notes: options.notes,
    createdAt: new Date().toISOString()
  })
  db.close()

  writeFeedbackFile(run.vm_name, run.workdir, options.decision, options.notes)
  console.log(`Recorded human feedback for run ${run.id}.`)
}
