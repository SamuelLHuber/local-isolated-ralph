import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

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

export const dispatchRun = (options: DispatchOptions) => {
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
  const reportDir = options.reportDir ?? `${vmWorkdir}/reports`

  console.log(`[${options.vm}] Dispatching spec: ${specPath}`)
  console.log(`[${options.vm}] Include .git: ${options.includeGit}`)
  console.log(`[${options.vm}] Work dir: ${vmWorkdir}`)

  ensureVmRunning(options.vm)
  limactlShell(options.vm, ["sudo", "-u", "ralph", "mkdir", "-p", vmWorkdir])

  if (projectDir) {
    syncProject(options.vm, projectDir, vmWorkdir, options.includeGit)
    if (options.includeGit && existsSync(join(projectDir, ".git"))) {
      verifyGitAndInitJj(options.vm, vmWorkdir)
    }
  }

  // Always write control files after sync so they cannot be clobbered.
  limactlShell(options.vm, ["sudo", "-u", "ralph", "mkdir", "-p", `${vmWorkdir}/specs`, reportDir])
  writeFileInVm(options.vm, `${vmWorkdir}/SPEC.md`, readText(specPath))
  writeFileInVm(options.vm, `${vmWorkdir}/specs/spec.min.json`, readText(specPath))
  writeFileInVm(options.vm, `${vmWorkdir}/specs/todo.min.json`, readText(todoPath))
  writeFileInVm(options.vm, `${vmWorkdir}/smithers-workflow.tsx`, readText(workflowPath))
  if (promptPath) writeFileInVm(options.vm, `${vmWorkdir}/PROMPT.md`, readText(promptPath))
  if (reviewPromptPath) writeFileInVm(options.vm, `${vmWorkdir}/REVIEW_PROMPT.md`, readText(reviewPromptPath))
  if (reviewModelsPath) writeFileInVm(options.vm, `${vmWorkdir}/reviewer-models.json`, readText(reviewModelsPath))

  maybeInstallDeps(options.vm, vmWorkdir)

  console.log(`[${options.vm}] Starting Smithers workflow...`)
  limactlShell(options.vm, [
    "bash",
    "-lc",
    [
      `cd "${vmWorkdir}"`,
      `echo "[${options.vm}] Working in: $(pwd)"`,
      "export PATH=\"$HOME/.bun/bin:$PATH\"",
      `export MAX_ITERATIONS=${options.iterations ?? 100}`,
      `export RALPH_AGENT=codex`,
      `export SMITHERS_SPEC_PATH="${vmWorkdir}/specs/spec.min.json"`,
      `export SMITHERS_TODO_PATH="${vmWorkdir}/specs/todo.min.json"`,
      `export SMITHERS_REPORT_DIR="${reportDir}"`,
      `export SMITHERS_AGENT=codex`,
      options.model ? `export SMITHERS_MODEL="${options.model}"` : "",
      options.reviewMax ? `export SMITHERS_REVIEW_MAX="${options.reviewMax}"` : "",
      `[ -f "${vmWorkdir}/PROMPT.md" ] && export SMITHERS_PROMPT_PATH="${vmWorkdir}/PROMPT.md" || true`,
      `[ -f "${vmWorkdir}/REVIEW_PROMPT.md" ] && export SMITHERS_REVIEW_PROMPT_PATH="${vmWorkdir}/REVIEW_PROMPT.md" || true`,
      `[ -f "${vmWorkdir}/reviewer-models.json" ] && export SMITHERS_REVIEW_MODELS_FILE="${vmWorkdir}/reviewer-models.json" || true`,
      `smithers "${vmWorkdir}/smithers-workflow.tsx"`,
      ""
    ]
      .filter(Boolean)
      .join("\n")
  ])
}
