import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { CLI_VERSION } from "./version.js"
import { requireVmHostTools } from "./prereqs.js"

type DispatchOptions = {
  vm: string
  spec: string
  todo: string
  project?: string
  includeGit: boolean
  workflow?: string
  reportDir?: string
  model?: string
  iterations?: number
  prompt?: string
  reviewPrompt?: string
  reviewModels?: string
  reviewMax?: number
}

const run = (cmd: string, args: string[], input?: string) => {
  execFileSync(cmd, args, { stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", input })
}

const readText = (path?: string) => {
  if (!path) return ""
  if (!existsSync(path)) return ""
  return readFileSync(path, "utf8")
}

const safeRealpath = (path?: string) => {
  if (!path) return undefined
  return resolve(path)
}

const ensureVmRunning = (vm: string) => {
  const list = execFileSync("limactl", ["list", "--format", "{{.Name}} {{.Status}}"]).toString()
  if (!list.split("\n").some((line) => line.startsWith(`${vm} Running`))) {
    console.log(`[${vm}] Starting VM...`)
    run("limactl", ["start", vm])
  }
}

const limactlShell = (vm: string, args: string[], input?: string) =>
  run("limactl", ["shell", "--workdir", "/home/ralph", vm, ...args], input)

const writeFileInVm = (vm: string, dest: string, content: string) => {
  limactlShell(vm, ["bash", "-lc", `sudo -u ralph tee "${dest}" >/dev/null`], content)
}

const syncProject = (vm: string, projectDir: string, workdir: string, includeGit: boolean) => {
  console.log(`[${vm}] Syncing project directory...`)
  const excludes = ["--exclude=node_modules", "--exclude=._*", "--exclude=.DS_Store"]
  if (!includeGit) excludes.push("--exclude=.git")
  const tarArgs = [
    "bash",
    "-lc",
    [
      "COPYFILE_DISABLE=1",
      "tar",
      "-C",
      `"${projectDir}"`,
      "--no-xattrs",
      ...excludes.map((x) => x.replace(/=/g, "=")),
      "-cf",
      "-",
      ".",
      "|",
      "limactl",
      "shell",
      "--workdir",
      "/home/ralph",
      `"${vm}"`,
      "sudo",
      "-u",
      "ralph",
      "tar",
      "--warning=no-unknown-keyword",
      "-C",
      `"${workdir}"`,
      "-xf",
      "-"
    ].join(" ")
  ]
  run(tarArgs[0], tarArgs.slice(1))
}

const verifyGitAndInitJj = (vm: string, workdir: string) => {
  console.log(`[${vm}] Verifying git remote access and initializing jj...`)
  limactlShell(vm, [
    "bash",
    "-lc",
    [
      `cd "${workdir}"`,
      "if [ -f ~/.config/ralph/ralph.env ]; then set -a; source ~/.config/ralph/ralph.env; set +a; fi",
      "if [ -n \"${GITHUB_TOKEN:-}\" ]; then",
      "  git config --global url.\"https://oauth:${GITHUB_TOKEN}@github.com/\".insteadOf \"https://github.com/\"",
      "fi",
      "REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo 'none')",
      "REMOTE_URL_SAFE=$(echo \"$REMOTE_URL\" | sed -E 's|://[^:]+:[^@]+@|://***@|')",
      `echo "[${vm}] Git remote: $REMOTE_URL_SAFE"`,
      "if git ls-remote --exit-code origin HEAD >/dev/null 2>&1; then",
      `  echo "[${vm}] Git remote access: OK"`,
      "else",
      `  echo "[${vm}] WARNING: Cannot access git remote. Push may fail."`,
      `  echo "[${vm}] Ensure GITHUB_TOKEN is set in ~/.config/ralph/ralph.env"`,
      "fi",
      "git config user.email >/dev/null 2>&1 || git config user.email 'ralph@local'",
      "git config user.name >/dev/null 2>&1 || git config user.name 'Ralph Agent'",
      "if [ ! -d .jj ]; then jj git init >/dev/null 2>&1 || true; fi",
      `echo "[${vm}] JJ: $(jj status -s 2>/dev/null | head -1 || echo 'ready')"`,
      ""
    ].join("\n")
  ])
}

const maybeInstallDeps = (vm: string, workdir: string) => {
  limactlShell(vm, [
    "bash",
    "-lc",
    [
      `cd "${workdir}"`,
      "if [ -f package.json ]; then",
      `  echo "[${vm}] Installing dependencies (bun install)..."`,
      "  export PATH=\"$HOME/.bun/bin:$PATH\"",
      "  export BUN_INSTALL_IGNORE_SCRIPTS=0",
      "  export npm_config_ignore_scripts=false",
      "  bun install",
      "fi"
    ].join("\n")
  ])
}

const sshOpts = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]

const getVmIp = (vm: string) => {
  const raw = execFileSync("virsh", ["domifaddr", vm]).toString().split("\n")
  const line = raw.map((l) => l.trim()).find((l) => l.includes("ipv4"))
  return line?.split(/\s+/)[3]?.split("/")[0]
}

const ssh = (ip: string, args: string[]) => run("ssh", [...sshOpts, `ralph@${ip}`, ...args])

const scp = (args: string[]) => run("scp", [...sshOpts, ...args])

const pathWithin = (root: string, target: string) => {
  const rel = relative(root, target)
  return rel && !rel.startsWith("..") && !isAbsolute(rel)
}

const isWritable = (path: string) => {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

const resolveDbPath = () => {
  const baseDir = join(homedir(), ".cache", "ralph")
  const requested = process.env.RALPH_DB_PATH ?? join(baseDir, "ralph.db")
  const requestedDir = dirname(requested)
  const fallbackPath = () => {
    const fallbackDir = join(tmpdir(), "ralph")
    mkdirSync(fallbackDir, { recursive: true })
    const fallback = join(fallbackDir, "ralph.db")
    console.warn(`[WARN] Falling back to writable DB path: ${fallback}`)
    return fallback
  }
  mkdirSync(requestedDir, { recursive: true })
  try {
    chmodSync(requestedDir, 0o700)
  } catch {}
  if (existsSync(requested)) {
    try {
      chmodSync(requested, 0o600)
    } catch {}
  }
  if (existsSync(requested) && !isWritable(requested)) {
    console.warn(`[WARN] DB not writable: ${requested}`)
    return fallbackPath()
  }
  if (!existsSync(requested) && !isWritable(requestedDir)) {
    return fallbackPath()
  }
  return requested
}

const getBinarySha256 = () => {
  try {
    const data = readFileSync(process.execPath)
    return createHash("sha256").update(data).digest("hex")
  } catch {
    return ""
  }
}

const getGitSha = () => {
  try {
    return execFileSync("jj", ["log", "-r", "@", "--no-graph", "--template", "commit_id"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim()
  } catch {
    return ""
  }
}

const insertRunRecord = (dbPath: string, workdir: string, specPath: string, todoPath: string, vm: string) => {
  const auditOs = process.platform
  const auditGitSha = getGitSha()
  const auditBinary = getBinarySha256()
  const script = `
import sqlite3
import sys
from datetime import datetime, timezone

db_path, vm, workdir, spec, todo, cli_version, git_sha, os_name, bin_sha = sys.argv[1:10]
conn = sqlite3.connect(db_path)
conn.execute(\"\"\"
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_name TEXT NOT NULL,
  workdir TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  todo_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  cli_version TEXT,
  git_sha TEXT,
  os TEXT,
  binary_sha256 TEXT
)
\"\"\")
conn.execute(\"CREATE INDEX IF NOT EXISTS runs_vm_started ON runs(vm_name, started_at)\")
cols = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
for col, coltype in [
  ("cli_version", "TEXT"),
  ("git_sha", "TEXT"),
  ("os", "TEXT"),
  ("binary_sha256", "TEXT")
]:
  if col not in cols:
    conn.execute(f"ALTER TABLE runs ADD COLUMN {col} {coltype}")
started_at = datetime.now(timezone.utc).isoformat()
cur = conn.execute(
  "INSERT INTO runs (vm_name, workdir, spec_path, todo_path, started_at, status, cli_version, git_sha, os, binary_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  (
    vm,
    workdir,
    spec,
    todo,
    started_at,
    "running",
    cli_version,
    git_sha or None,
    os_name,
    bin_sha or None,
  )
)
conn.commit()
print(cur.lastrowid)
conn.close()
`
  const output = execFileSync(
    "python3",
    ["-", dbPath, vm, workdir, specPath, todoPath, CLI_VERSION, auditGitSha, auditOs, auditBinary],
    { input: script }
  )
    .toString()
    .trim()
  return output || ""
}

const updateRunStatus = (dbPath: string, runId: string, exitCode: number) => {
  const script = `
import sqlite3
import sys

db_path, run_id, exit_code = sys.argv[1:4]
status = "success" if exit_code == "0" else "failed"
conn = sqlite3.connect(db_path)
conn.execute("UPDATE runs SET status = ?, exit_code = ? WHERE id = ?", (status, int(exit_code), int(run_id)))
conn.commit()
conn.close()
`
  execFileSync("python3", ["-", dbPath, runId, String(exitCode)], { input: script })
}

export const dispatchRun = (options: DispatchOptions) => {
  requireVmHostTools()
  const specPath = safeRealpath(options.spec)!
  const todoPath = safeRealpath(options.todo)!
  const workflowPath = safeRealpath(options.workflow ?? "scripts/smithers-spec-runner.tsx")!
  const promptPath = safeRealpath(options.prompt)
  const reviewPromptPath = safeRealpath(options.reviewPrompt)
  const reviewModelsPath = safeRealpath(options.reviewModels)
  const projectDir = options.project ? safeRealpath(options.project)! : undefined
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
  const projectBase = projectDir ? basename(projectDir) : "task"
  const workSubdir = `${projectBase}-${timestamp}`
  const vmWorkdir = `/home/ralph/work/${options.vm}/${workSubdir}`
  const controlDir = `/home/ralph/work/${options.vm}/.runs/${workSubdir}`
  const reportDir = options.reportDir ?? `${controlDir}/reports`
  const projectRelative = projectDir ? (path: string) => relative(projectDir, path) : undefined
  const dbPath = resolveDbPath()
  let runId = ""
  if (dbPath) {
    try {
      runId = insertRunRecord(dbPath, vmWorkdir, specPath, todoPath, options.vm)
    } catch (error) {
      console.warn("[WARN] Failed to record run in DB:", error)
      runId = ""
    }
  }

  console.log(`[${options.vm}] Dispatching spec: ${specPath}`)
  console.log(`[${options.vm}] Include .git: ${options.includeGit}`)
  console.log(`[${options.vm}] Work dir: ${vmWorkdir}`)

  if (process.platform === "darwin") {
    ensureVmRunning(options.vm)
    limactlShell(options.vm, ["sudo", "-u", "ralph", "mkdir", "-p", vmWorkdir, controlDir])
  }

  if (process.platform === "linux") {
    const ip = getVmIp(options.vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
    ssh(ip, ["mkdir", "-p", vmWorkdir, controlDir])
  }

  let specInVm = `${vmWorkdir}/specs/spec.min.json`
  let todoInVm = `${vmWorkdir}/specs/todo.min.json`
  let workflowInVm = `${vmWorkdir}/smithers-workflow.tsx`

  if (projectDir) {
    if (process.platform === "darwin") {
      syncProject(options.vm, projectDir, vmWorkdir, options.includeGit)
      if (options.includeGit && existsSync(join(projectDir, ".git"))) {
        verifyGitAndInitJj(options.vm, vmWorkdir)
      }
    } else if (process.platform === "linux") {
      const ip = getVmIp(options.vm)
      if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
      console.log(`[${options.vm}] Syncing project directory...`)
      const excludes = ["--exclude=node_modules", "--exclude=._*", "--exclude=.DS_Store"]
      if (!options.includeGit) excludes.push("--exclude=.git")
      run("bash", [
        "-lc",
        [
          "tar",
          "-C",
          `"${projectDir}"`,
          ...excludes.map((x) => x.replace(/=/g, "=")),
          "-cf",
          "-",
          ".",
          "|",
          "ssh",
          ...sshOpts,
          `ralph@${ip}`,
          `tar -C "${vmWorkdir}" -xf -`
        ].join(" ")
      ])
      if (options.includeGit && existsSync(join(projectDir, ".git"))) {
        console.log(`[${options.vm}] Verifying git remote access and initializing jj...`)
        ssh(ip, [
          "bash",
          "-lc",
          [
            `cd "${vmWorkdir}"`,
            "if [ -f ~/.config/ralph/ralph.env ]; then set -a; source ~/.config/ralph/ralph.env; set +a; fi",
            "if [ -n \"${GITHUB_TOKEN:-}\" ]; then",
            "  git config --global url.\"https://oauth:${GITHUB_TOKEN}@github.com/\".insteadOf \"https://github.com/\"",
            "fi",
            "REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo 'none')",
            "REMOTE_URL_SAFE=$(echo \"$REMOTE_URL\" | sed -E 's|://[^:]+:[^@]+@|://***@|')",
            `echo "[${options.vm}] Git remote: $REMOTE_URL_SAFE"`,
            "if git ls-remote --exit-code origin HEAD >/dev/null 2>&1; then",
            `  echo "[${options.vm}] Git remote access: OK"`,
            "else",
            `  echo "[${options.vm}] WARNING: Cannot access git remote. Push may fail."`,
            `  echo "[${options.vm}] Ensure GITHUB_TOKEN is set in ~/.config/ralph/ralph.env"`,
            "fi",
            "git config user.email >/dev/null 2>&1 || git config user.email 'ralph@local'",
            "git config user.name >/dev/null 2>&1 || git config user.name 'Ralph Agent'",
            "if [ ! -d .jj ]; then jj git init >/dev/null 2>&1 || true; fi",
            `echo "[${options.vm}] JJ: $(jj status -s 2>/dev/null | head -1 || echo 'ready')"`
          ].join("\n")
        ])
      }
    }

    if (pathWithin(projectDir, specPath)) {
      specInVm = `${vmWorkdir}/${projectRelative?.(specPath)}`
    } else {
      specInVm = `${vmWorkdir}/specs/${basename(specPath)}`
    }
    if (pathWithin(projectDir, todoPath)) {
      todoInVm = `${vmWorkdir}/${projectRelative?.(todoPath)}`
    } else {
      todoInVm = `${vmWorkdir}/specs/${basename(todoPath)}`
    }
    if (pathWithin(projectDir, workflowPath)) {
      workflowInVm = `${vmWorkdir}/${projectRelative?.(workflowPath)}`
    }
  }

  if (process.platform === "darwin") {
    limactlShell(options.vm, ["sudo", "-u", "ralph", "mkdir", "-p", `${vmWorkdir}/specs`, reportDir])
    if (!projectDir || !pathWithin(projectDir, specPath)) {
      writeFileInVm(options.vm, specInVm, readText(specPath))
    }
    if (!projectDir || !pathWithin(projectDir, todoPath)) {
      writeFileInVm(options.vm, todoInVm, readText(todoPath))
    }
    if (!projectDir || !pathWithin(projectDir, workflowPath)) {
      writeFileInVm(options.vm, workflowInVm, readText(workflowPath))
    }
  } else if (process.platform === "linux") {
    const ip = getVmIp(options.vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
    ssh(ip, ["mkdir", "-p", `${vmWorkdir}/specs`, reportDir])
    if (!projectDir || !pathWithin(projectDir, specPath)) {
      scp([specPath, `ralph@${ip}:${specInVm}`])
    }
    if (!projectDir || !pathWithin(projectDir, todoPath)) {
      scp([todoPath, `ralph@${ip}:${todoInVm}`])
    }
    if (!projectDir || !pathWithin(projectDir, workflowPath)) {
      scp([workflowPath, `ralph@${ip}:${workflowInVm}`])
    }
  }
  if (promptPath) writeFileInVm(options.vm, `${vmWorkdir}/PROMPT.md`, readText(promptPath))
  if (reviewPromptPath) writeFileInVm(options.vm, `${vmWorkdir}/REVIEW_PROMPT.md`, readText(reviewPromptPath))
  if (reviewModelsPath) writeFileInVm(options.vm, `${vmWorkdir}/reviewer-models.json`, readText(reviewModelsPath))

  if (process.platform === "darwin") {
    maybeInstallDeps(options.vm, vmWorkdir)
  } else if (process.platform === "linux") {
    const ip = getVmIp(options.vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
    ssh(ip, [
      "bash",
      "-lc",
      [
        `cd "${vmWorkdir}"`,
        "if [ -f package.json ]; then",
        `  echo "[${options.vm}] Installing dependencies (bun install)..."`,
        "  export PATH=\"$HOME/.bun/bin:$PATH\"",
        "  export BUN_INSTALL_IGNORE_SCRIPTS=0",
        "  export npm_config_ignore_scripts=false",
        "  bun install",
        "fi"
      ].join("\n")
    ])
  }

  console.log(`[${options.vm}] Starting Smithers workflow...`)
  const smithersScript = [
    `cd "${controlDir}"`,
    `echo "[${options.vm}] Control dir: $(pwd)"`,
    "export PATH=\"$HOME/.bun/bin:$PATH\"",
    `export MAX_ITERATIONS=${options.iterations ?? 100}`,
    `export RALPH_AGENT=codex`,
    `export SMITHERS_SPEC_PATH="${specInVm}"`,
    `export SMITHERS_TODO_PATH="${todoInVm}"`,
    `export SMITHERS_REPORT_DIR="${reportDir}"`,
    `export SMITHERS_AGENT=codex`,
    `export SMITHERS_CWD="${vmWorkdir}"`,
    options.model ? `export SMITHERS_MODEL="${options.model}"` : "",
    options.reviewMax ? `export SMITHERS_REVIEW_MAX="${options.reviewMax}"` : "",
    `[ -f "${vmWorkdir}/PROMPT.md" ] && export SMITHERS_PROMPT_PATH="${vmWorkdir}/PROMPT.md" || true`,
    `[ -f "${vmWorkdir}/REVIEW_PROMPT.md" ] && export SMITHERS_REVIEW_PROMPT_PATH="${vmWorkdir}/REVIEW_PROMPT.md" || true`,
    `[ -f "${vmWorkdir}/reviewer-models.json" ] && export SMITHERS_REVIEW_MODELS_FILE="${vmWorkdir}/reviewer-models.json" || true`,
    `smithers "${workflowInVm}"`
  ]
    .filter(Boolean)
    .join("\n")

  let exitCode = 0
  try {
    if (process.platform === "darwin") {
      limactlShell(options.vm, ["bash", "-lc", smithersScript])
    } else if (process.platform === "linux") {
      const ip = getVmIp(options.vm)
      if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
      ssh(ip, ["bash", "-lc", smithersScript])
    }
  } catch (error: any) {
    exitCode = typeof error?.status === "number" ? error.status : 1
    if (dbPath && runId) {
      try {
        updateRunStatus(dbPath, runId, exitCode)
      } catch (dbError) {
        console.warn("[WARN] Failed to update run status:", dbError)
      }
    }
    throw error
  }
  if (dbPath && runId) {
    try {
      updateRunStatus(dbPath, runId, exitCode)
    } catch (dbError) {
      console.warn("[WARN] Failed to update run status:", dbError)
    }
  }
}
