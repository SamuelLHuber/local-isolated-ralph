import { existsSync, readFileSync, accessSync, constants, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, join, resolve, relative, isAbsolute } from "node:path"
import { runCommand, runCommandOutput } from "./exec.js"
import { ensureAnyCommand, ensureCommands, hasCommand } from "./prereqs.js"
import { insertRun, openRunDb } from "./runDb.js"
import { getVmIp } from "./vm-utils.js"
import { CLI_VERSION } from "./version.js"
import { validateBeforeDispatch, printValidationResults } from "./validate-workflow.js"

type DispatchOptions = {
  vm: string
  spec: string
  todo: string
  project?: string
  repoUrl?: string
  repoRef?: string
  repoBranch?: string
  includeGit: boolean
  workflow?: string
  reportDir?: string
  model?: string
  iterations?: number
  prompt?: string
  reviewPrompt?: string
  reviewModels?: string
  reviewMax?: number
  branch?: string
  requireAgents?: string[]
  follow?: boolean
  dynamic?: boolean
  learn?: boolean
}

export type DispatchResult = {
  runId: number
  vm: string
  workdir: string
  controlDir: string
  reportDir: string
  branch: string
  specId: string
}

const run = (cmd: string, args: string[], input?: string, context?: string) => {
  runCommand(cmd, args, { input, context })
}

const readText = (path?: string) => {
  if (!path) return ""
  if (!existsSync(path)) return ""
  return readFileSync(path, "utf8")
}

const minifyJson = (path: string) => {
  if (!existsSync(path)) {
    const isTodo = path.includes(".todo.") || path.endsWith(".todo.json")
    const fileType = isTodo ? "todo" : "spec"
    const createCmd = isTodo ? "fabrik todo generate" : "fabrik spec interview"
    throw new Error(
      `Missing JSON file: ${path}\n\n` +
      `To create this ${fileType} file, run:\n` +
      `  ${createCmd}\n\n` +
      `This will output a complete guide for generating ${fileType} files. ` +
      `Save the generated JSON to the path above and retry.`
    )
  }
  try {
    const raw = readFileSync(path, "utf8")
    const json = JSON.parse(raw)
    return JSON.stringify(json)
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${path}\n${String(error)}`)
  }
}

const toMinName = (path: string) => {
  const name = basename(path)
  if (name.endsWith(".min.json")) return name
  if (name.endsWith(".json")) return name.replace(/\.json$/i, ".min.json")
  return `${name}.min.json`
}

const buildRunContext = (options: {
  runId: number
  vm: string
  specPath: string
  todoPath: string
  promptPath?: string
  reviewPromptPath?: string
  reviewModelsPath?: string
  reviewersDir?: string
  repoUrl?: string
  repoRef?: string
  cliVersion: string
  osInfo: string
  binaryHash: string
  gitSha: string
}) => {
  const reviewers = options.reviewersDir && existsSync(options.reviewersDir)
    ? readdirSync(options.reviewersDir)
        .filter((entry) => entry.toLowerCase().endsWith(".md"))
        .map((entry) => {
          const full = join(options.reviewersDir as string, entry)
          return { file: entry, path: full, sha256: sha256(full) }
        })
    : []

  return JSON.stringify(
    {
      v: 1,
      run_id: options.runId,
      vm: options.vm,
      created_at: new Date().toISOString(),
      spec_path: options.specPath,
      todo_path: options.todoPath,
      prompt_path: options.promptPath ?? null,
      review_prompt_path: options.reviewPromptPath ?? null,
      review_models_path: options.reviewModelsPath ?? null,
      reviewers_dir: options.reviewersDir ?? null,
      reviewers,
      spec_sha256: sha256(options.specPath),
      todo_sha256: sha256(options.todoPath),
      prompt_sha256: sha256(options.promptPath ?? ""),
      review_prompt_sha256: sha256(options.reviewPromptPath ?? ""),
      review_models_sha256: sha256(options.reviewModelsPath ?? ""),
      prompt_text: readText(options.promptPath).trim(),
      review_prompt_text: readText(options.reviewPromptPath).trim(),
      review_models_text: readText(options.reviewModelsPath).trim(),
      repo_url: options.repoUrl ?? null,
      repo_ref: options.repoRef ?? null,
      cli_version: options.cliVersion,
      os: options.osInfo,
      binary_hash: options.binaryHash,
      git_sha: options.gitSha
    },
    null,
    2
  ) + "\n"
}

const workflowAgentNeeds = (workflowPath: string) => {
  const text = readText(workflowPath)
  if (!text) return { needsPi: false, needsCodex: false, needsClaude: false }
  const needsPi = /\bPiAgent\b/.test(text)
  const needsCodex = /\bCodexAgent\b/.test(text)
  const needsClaude = /\bClaudeCodeAgent\b/.test(text)
  return { needsPi, needsCodex, needsClaude }
}

const requireFile = (label: string, path: string, hint: string) => {
  if (existsSync(path)) return
  const message = [
    `Missing ${label}: ${path}`,
    hint
  ]
  throw new Error(message.join("\n"))
}

const readSpecId = (path: string) => {
  try {
    const raw = readFileSync(path, "utf8")
    
    // Handle markdown specs
    if (path.endsWith(".md") || path.endsWith(".mdx")) {
      // Try frontmatter
      const frontmatterMatch = raw.match(/^---\s*\n[\s\S]*?id:\s*(.+?)\s*\n[\s\S]*?---/m)
      if (frontmatterMatch) return frontmatterMatch[1].trim()
      
      // Try filename
      const base = basename(path).replace(/\.mdx?$/, "").replace(/^spec[-_]/, "")
      if (base) return base
      
      // Try H1
      const titleMatch = raw.match(/^#\s+(.+)$/m)
      if (titleMatch) {
        return titleMatch[1]
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 50)
      }
      
      return ""
    }
    
    // JSON specs
    const parsed = JSON.parse(raw) as { id?: string }
    return typeof parsed.id === "string" ? parsed.id : ""
  } catch {
    return ""
  }
}

const sha256 = (path: string) => {
  try {
    const data = readFileSync(path)
    return createHash("sha256").update(data).digest("hex")
  } catch {
    return ""
  }
}

const isWritable = (path: string) => {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

const getBinaryHash = () => {
  const candidates = [process.execPath, process.argv[0]].filter(Boolean) as string[]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return sha256(candidate)
    }
  }
  return ""
}

const getGitSha = () => {
  if (!hasCommand("git")) return ""
  try {
    return runCommandOutput("git", ["rev-parse", "HEAD"], { context: "read git SHA" }).trim()
  } catch {
    return ""
  }
}

const sanitizeBranch = (name: string) =>
  name
    .trim()
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)

const safeRealpath = (path?: string) => {
  if (!path) return undefined
  return resolve(path)
}

const ensureVmRunning = (vm: string) => {
  const list = runCommandOutput("limactl", ["list", "--format", "{{.Name}} {{.Status}}"], {
    context: "check limactl status"
  })
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

const writeFileRemote = (vm: string, dest: string, content: string) => {
  if (process.platform === "darwin") {
    writeFileInVm(vm, dest, content)
    return
  }
  if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    ssh(ip, ["bash", "-lc", `cat > \"${dest}\"`], content)
    return
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

const copyDirRemote = (vm: string, srcDir: string, destDir: string) => {
  if (!existsSync(srcDir)) return
  // Use limactl copy for all platforms (uses rsync when available, falls back to scp)
  run("limactl", ["copy", "-r", `${srcDir}/`, `${vm}:${destDir}`])
}

const ensureBunReady = (vm: string) => {
  const script = [
    "export PATH=\"$HOME/.bun/bin:$PATH\"",
    "BUN_CHECK_OUTPUT=$(bun --version 2>&1 || true)",
    "if echo \"$BUN_CHECK_OUTPUT\" | grep -q 'postinstall script was not run'; then",
    `  echo "[${vm}] Fixing bun postinstall..."`,
    "  if command -v node >/dev/null 2>&1 && [ -f \"$HOME/.bun/install/global/node_modules/bun/install.js\" ]; then",
    "    node \"$HOME/.bun/install/global/node_modules/bun/install.js\"",
    "  fi",
    "fi"
  ].join("\n")

  if (process.platform === "darwin") {
    limactlShell(vm, ["bash", "-lc", script])
  } else if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    ssh(ip, ["bash", "-lc", script])
  }
}

const syncProject = (vm: string, projectDir: string, workdir: string, includeGit: boolean) => {
  console.log(`[${vm}] Syncing project directory...`)
  // Use limactl copy for efficient rsync-based transfer
  const excludes = ["node_modules", ".git", "._*", ".DS_Store"]
  const excludeArgs = excludes.flatMap(e => ["--exclude", e])
  
  run("limactl", ["copy", ...excludeArgs, "-r", `${projectDir}/`, `${vm}:${workdir}`])
}

const syncSmithersRunner = (vm: string, ralphHome: string, workdir: string) => {
  const runnerDir = join(ralphHome, "smithers-runner")
  if (!existsSync(runnerDir)) {
    console.log(`[${vm}] Warning: smithers-runner directory not found at ${runnerDir}`)
    return false
  }
  
  console.log(`[${vm}] Syncing smithers-runner...`)
  const destDir = `${workdir}/smithers-runner`
  
  // Use limactl copy (uses rsync when available)
  run("limactl", ["copy", "-r", `${runnerDir}/`, `${vm}:${destDir}`])
  return true
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
      "  export GH_TOKEN=\"${GITHUB_TOKEN}\"",
      "  git config --global url.\"https://oauth:${GITHUB_TOKEN}@github.com/\".insteadOf \"https://github.com/\"",
      "else",
      `  echo "[${vm}] WARNING: GITHUB_TOKEN not set in ~/.config/ralph/ralph.env. GitHub auth will fail."`,
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
      "git config user.email >/dev/null 2>&1 || git config user.email 'ralph@fabrik.sh'",
      "git config user.name >/dev/null 2>&1 || git config user.name 'Ralph Agent'",
      "if [ ! -d .jj ]; then jj git init >/dev/null 2>&1 || true; fi",
      "JJ_NAME=$(jj config get user.name 2>/dev/null || true)",
      "JJ_EMAIL=$(jj config get user.email 2>/dev/null || true)",
      "JJ_NEEDS_IDENTITY=0",
      "if [ -z \"$JJ_NAME\" ]; then",
      "  GIT_NAME=$(git config user.name 2>/dev/null || true)",
      "  JJ_NAME=${GIT_NAME:-Ralph Agent}",
      "  jj config set --user user.name \"$JJ_NAME\" >/dev/null 2>&1 || true",
      "  JJ_NEEDS_IDENTITY=1",
      "fi",
      "if [ -z \"$JJ_EMAIL\" ]; then",
      "  GIT_EMAIL=$(git config user.email 2>/dev/null || true)",
      "  JJ_EMAIL=${GIT_EMAIL:-ralph@fabrik.sh}",
      "  jj config set --user user.email \"$JJ_EMAIL\" >/dev/null 2>&1 || true",
      "  JJ_NEEDS_IDENTITY=1",
      "fi",
      `echo "[${vm}] JJ identity: ${"$"}{JJ_NAME:-unknown} <${"$"}{JJ_EMAIL:-unknown}"`,
      `if [ "${"$"}JJ_NEEDS_IDENTITY" = "1" ]; then echo "[${vm}] Set JJ identity with: jj config set --user user.name 'Your Name' && jj config set --user user.email 'you@company.com'"; fi`,
      `echo "[${vm}] JJ: $(jj status -s 2>/dev/null | head -1 || echo 'ready')"`,
      ""
    ].join("\n")
  ])
}

const cloneRepoInVm = (vm: string, workdir: string, repoUrl: string, repoRef?: string) => {
  const ref = repoRef ? repoRef.replace(/"/g, "") : ""
  const cloneScript = [
    `cd "${workdir}"`,
    "if [ -f ~/.config/ralph/ralph.env ]; then set -a; source ~/.config/ralph/ralph.env; set +a; fi",
    "if [ -n \"${GITHUB_TOKEN:-}\" ]; then",
    "  export GH_TOKEN=\"${GITHUB_TOKEN}\"",
    "  git config --global url.\"https://oauth:${GITHUB_TOKEN}@github.com/\".insteadOf \"https://github.com/\"",
    "fi",
    "if command -v jj >/dev/null 2>&1; then",
    "  if [ ! -d repo/.jj ]; then jj git clone \"" + repoUrl + "\" repo; fi",
    "  if [ -n \"" + ref + "\" ]; then",
    "    jj -R repo git fetch >/dev/null 2>&1 || true",
    "    jj -R repo checkout \"" + ref + "\" >/dev/null 2>&1 || true",
    "  fi",
    "else",
    "  if [ ! -d repo/.git ]; then git clone --depth 1 \"" + repoUrl + "\" repo; fi",
    "  if [ -n \"" + ref + "\" ]; then git -C repo fetch --depth 1 origin \"" + ref + "\" >/dev/null 2>&1 || true; fi",
    "  if [ -n \"" + ref + "\" ]; then git -C repo checkout \"" + ref + "\" || true; fi",
    "fi"
  ].join("\n")
  if (process.platform === "darwin") {
    limactlShell(vm, ["bash", "-lc", cloneScript])
  } else if (process.platform === "linux") {
    const ip = getVmIp(vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${vm}'. Is it running?`)
    ssh(ip, ["bash", "-lc", cloneScript])
  }
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
      "  BUN_CHECK_OUTPUT=$(bun --version 2>&1 || true)",
      "  if echo \"$BUN_CHECK_OUTPUT\" | grep -q 'postinstall script was not run'; then",
      `    echo "[${vm}] Fixing bun postinstall..."`,
      "    if command -v node >/dev/null 2>&1 && [ -f \"$HOME/.bun/install/global/node_modules/bun/install.js\" ]; then",
      "      node \"$HOME/.bun/install/global/node_modules/bun/install.js\"",
      "    fi",
      "  fi",
      "  bun install",
      "fi"
    ].join("\n")
  ])
}

const sshOpts = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]

const ssh = (ip: string, args: string[], input?: string) =>
  run("ssh", [...sshOpts, `ralph@${ip}`, ...args], input)

const scp = (args: string[]) => run("scp", [...sshOpts, ...args])

const pathWithin = (root: string, target: string) => {
  const rel = relative(root, target)
  return rel && !rel.startsWith("..") && !isAbsolute(rel)
}

export const dispatchRun = (options: DispatchOptions): DispatchResult => {
  // Validate workflow before dispatch
  const workflowToValidate = options.workflow ?? (options.dynamic 
    ? "scripts/smithers-dynamic-runner.tsx"
    : "scripts/smithers-spec-runner.tsx")
  const workflowPath = safeRealpath(workflowToValidate)!
  
  console.log(`[${options.vm}] Validating workflow...`)
  const validation = validateBeforeDispatch(workflowPath, options.project)
  printValidationResults(validation)
  
  if (!validation.valid) {
    throw new Error(
      `Workflow validation failed. Fix errors before dispatching:\n` +
      validation.errors.map(e => `  - ${e}`).join("\n")
    )
  }
  
  const specPath = safeRealpath(options.spec)!
  const isMarkdownSpec = specPath.endsWith(".md") || specPath.endsWith(".mdx")
  
  // In dynamic mode, todo is optional (generated at runtime)
  const todoPath = options.dynamic 
    ? (options.todo ? safeRealpath(options.todo)! : `${specPath}.dynamic-todo.json`)
    : safeRealpath(options.todo)!
  
  // Use dynamic workflow if --dynamic flag set
  const defaultWorkflow = options.dynamic
    ? "scripts/smithers-dynamic-runner.tsx"
    : "scripts/smithers-spec-runner.tsx"
  const workflowSha = sha256(workflowPath)
  const workflowNeeds = workflowAgentNeeds(workflowPath)
  const requiredAgents = options.requireAgents?.map((a) => a.trim().toLowerCase()).filter(Boolean) ?? []
  const ralphHome = resolve(dirname(workflowPath), "..")
  const defaultPrompt = join(ralphHome, "prompts", "DEFAULT-IMPLEMENTER.md")
  const defaultReviewPrompt = join(ralphHome, "prompts", "DEFAULT-REVIEWER.md")
  const reviewersDir = existsSync(join(ralphHome, "prompts", "reviewers"))
    ? join(ralphHome, "prompts", "reviewers")
    : undefined
  const promptCandidate = options.prompt ?? (existsSync(defaultPrompt) ? defaultPrompt : undefined)
  const reviewPromptCandidate = options.reviewPrompt ?? (existsSync(defaultReviewPrompt) ? defaultReviewPrompt : undefined)
  const promptPath = safeRealpath(promptCandidate)
  const reviewPromptPath = safeRealpath(reviewPromptCandidate)
  const reviewModelsPath = safeRealpath(options.reviewModels)
  const projectDir = options.project ? safeRealpath(options.project)! : undefined
  const repoUrl = options.repoUrl?.trim()
  const repoRef = options.repoRef?.trim() ?? options.repoBranch?.trim()
  const agentKind = (process.env.SMITHERS_AGENT ?? process.env.RALPH_AGENT ?? "pi").toLowerCase()
  const specId = readSpecId(specPath)
  const runStamp = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`
  const branch = sanitizeBranch(options.branch ?? (specId ? `spec-${specId}` : `spec-run-${runStamp}`))
  const timestamp = runStamp

  if (process.platform === "darwin") {
    ensureCommands(
      [{ cmd: "limactl" }, { cmd: "tar" }, { cmd: "bash" }],
      "dispatch requires limactl on macOS"
    )
  } else if (process.platform === "linux") {
    ensureCommands(
      [{ cmd: "virsh" }, { cmd: "ssh" }, { cmd: "scp" }, { cmd: "tar" }, { cmd: "bash" }],
      "dispatch requires virsh/ssh/scp on Linux"
    )
  } else {
    throw new Error(`Unsupported OS: ${process.platform}`)
  }

  ensureAnyCommand([{ cmd: "jj" }, { cmd: "git" }], "dispatch requires jj or git")

  if (projectDir && repoUrl) {
    throw new Error("Provide either --project or --repo, not both.")
  }
  if (!projectDir && !repoUrl) {
    throw new Error(
      [
        "Missing project repository.",
        "Dispatch requires a repo to apply tasks.",
        "Provide --project /path/to/repo or --repo <git-url> (optional --repo-ref)."
      ].join("\n")
    )
  }

  if (!options.includeGit) {
    console.log(`[${options.vm}] WARNING: --include-git not set; push will be disabled in the VM.`)
  }
  if (projectDir && !isWritable(projectDir)) {
    console.log(`[${options.vm}] WARNING: project dir is not writable: ${projectDir}`)
  }

  const projectBase = projectDir ? basename(projectDir) : "repo"
  const workSubdir = `${projectBase}-${timestamp}`
  const vmWorkdir = `/home/ralph/work/${options.vm}/${workSubdir}`
  const controlDir = `/home/ralph/work/${options.vm}/.runs/${workSubdir}`
  const reportDir = options.reportDir ?? `${controlDir}/reports`
  const projectRelative = projectDir ? (path: string) => relative(projectDir, path) : undefined
  const projectRootInVm = repoUrl ? `${vmWorkdir}/repo` : vmWorkdir
  if (repoUrl && repoRef && !repoRef.length) {
    throw new Error("repo ref provided but empty.")
  }

  // Handle markdown specs in dynamic mode
  const specMinified = isMarkdownSpec && options.dynamic
    ? JSON.stringify({ _type: "markdown", path: specPath, content: readText(specPath) })
    : minifyJson(specPath)
  
  // In dynamic mode, todo may not exist yet (generated at runtime)
  const todoMinified = options.dynamic && !existsSync(todoPath)
    ? JSON.stringify({ _type: "dynamic", generated: true, tickets: [] })
    : minifyJson(todoPath)

  const osInfo = `${process.platform}-${process.arch}`
  const binaryHash = getBinaryHash()
  const gitSha = getGitSha()
  const { db } = openRunDb()
  const runId = insertRun(db, {
    vm_name: options.vm,
    workdir: vmWorkdir,
    spec_path: specPath,
    todo_path: todoPath,
    repo_url: repoUrl ?? null,
    repo_ref: repoRef ?? null,
    started_at: new Date().toISOString(),
    status: "running",
    exit_code: null,
    cli_version: CLI_VERSION,
    os: osInfo,
    binary_hash: binaryHash || null,
    git_sha: gitSha || null
  })
  db.close()
  const smithersDbName = specId ? `${specId}.db` : `run-${runId}.db`
  const smithersDbPath = `${controlDir}/.smithers/${smithersDbName}`

  console.log(`[${options.vm}] Dispatching spec: ${specPath}`)
  console.log(`[${options.vm}] Include .git: ${options.includeGit}`)
  console.log(`[${options.vm}] Work dir: ${vmWorkdir}`)
  console.log(`[${options.vm}] Branch: ${branch}`)
  const detectedAgents = [
    workflowNeeds.needsPi ? "pi" : null,
    workflowNeeds.needsCodex ? "codex" : null,
    workflowNeeds.needsClaude ? "claude" : null
  ].filter(Boolean)
  console.log(`[${options.vm}] Workflow agents detected: ${detectedAgents.length ? detectedAgents.join(", ") : "none"}`)
  if (!detectedAgents.length && !requiredAgents.length) {
    throw new Error(
      [
        "No agent components detected in workflow.",
        "Provide explicit requirements with --require-agents pi,codex,claude (comma-separated)."
      ].join("\n")
    )
  }

  const needsPi =
    workflowNeeds.needsPi || requiredAgents.includes("pi") || agentKind === "pi"
  const needsCodex =
    workflowNeeds.needsCodex || requiredAgents.includes("codex") || agentKind === "codex"
  const needsClaude =
    workflowNeeds.needsClaude || requiredAgents.includes("claude") || agentKind === "claude"

  if (needsPi) {
    const piDir = join(process.env.HOME ?? "", ".pi", "agent")
    if (!existsSync(piDir)) {
      console.log("    Note: ~/.pi/agent not found (pi will need login in VM).")
    }
  }

  if (needsCodex) {
    requireFile(
      "Codex auth",
      join(process.env.HOME ?? "", ".codex/auth.json"),
      "Run `codex login` or copy ~/.codex/auth.json before dispatch."
    )
  }

  if (needsClaude) {
    const claudeJson = join(process.env.HOME ?? "", ".claude.json")
    const claudeDir = join(process.env.HOME ?? "", ".claude")
    if (!existsSync(claudeJson) && !existsSync(claudeDir)) {
      throw new Error(
        [
          "Missing Claude auth (~/.claude.json or ~/.claude).",
          "Run `claude login` or set ANTHROPIC_API_KEY in ~/.config/ralph/ralph.env before dispatch."
        ].join("\n")
      )
    }
  }

  if (process.platform === "darwin") {
    ensureVmRunning(options.vm)
    limactlShell(options.vm, ["sudo", "-u", "ralph", "mkdir", "-p", vmWorkdir, controlDir])
  }

  if (process.platform === "linux") {
    const ip = getVmIp(options.vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
    ssh(ip, ["mkdir", "-p", vmWorkdir, controlDir])
  }

  let specInVm = `${vmWorkdir}/specs/${toMinName(specPath)}`
  let todoInVm = `${vmWorkdir}/specs/${toMinName(todoPath)}`
  let workflowInVm = `${vmWorkdir}/smithers-workflow.tsx`

  if (projectDir) {
    if (process.platform === "darwin") {
      syncProject(options.vm, projectDir, vmWorkdir, options.includeGit)
      // Sync smithers-runner for self-contained execution
      syncSmithersRunner(options.vm, ralphHome, vmWorkdir)
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
            "  export GH_TOKEN=\"${GITHUB_TOKEN}\"",
            "  git config --global url.\"https://oauth:${GITHUB_TOKEN}@github.com/\".insteadOf \"https://github.com/\"",
            "else",
            `  echo "[${options.vm}] WARNING: GITHUB_TOKEN not set in ~/.config/ralph/ralph.env. GitHub auth will fail."`,
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
            "git config user.email >/dev/null 2>&1 || git config user.email 'ralph@fabrik.sh'",
            "git config user.name >/dev/null 2>&1 || git config user.name 'Ralph Agent'",
            "if [ ! -d .jj ]; then jj git init >/dev/null 2>&1 || true; fi",
            "JJ_NAME=$(jj config get user.name 2>/dev/null || true)",
            "JJ_EMAIL=$(jj config get user.email 2>/dev/null || true)",
            "JJ_NEEDS_IDENTITY=0",
            "if [ -z \"$JJ_NAME\" ]; then",
            "  GIT_NAME=$(git config user.name 2>/dev/null || true)",
            "  JJ_NAME=${GIT_NAME:-Ralph Agent}",
            "  jj config set --user user.name \"$JJ_NAME\" >/dev/null 2>&1 || true",
            "  JJ_NEEDS_IDENTITY=1",
            "fi",
            "if [ -z \"$JJ_EMAIL\" ]; then",
            "  GIT_EMAIL=$(git config user.email 2>/dev/null || true)",
            "  JJ_EMAIL=${GIT_EMAIL:-ralph@fabrik.sh}",
            "  jj config set --user user.email \"$JJ_EMAIL\" >/dev/null 2>&1 || true",
            "  JJ_NEEDS_IDENTITY=1",
            "fi",
            `echo "[${options.vm}] JJ identity: ${"$"}{JJ_NAME:-unknown} <${"$"}{JJ_EMAIL:-unknown}"`,
            `if [ "${"$"}JJ_NEEDS_IDENTITY" = "1" ]; then echo "[${options.vm}] Set JJ identity with: jj config set --user user.name 'Your Name' && jj config set --user user.email 'you@company.com'"; fi`,
            `echo "[${options.vm}] JJ: $(jj status -s 2>/dev/null | head -1 || echo 'ready')"`
          ].join("\n")
        ])
      }
    }

    if (pathWithin(projectDir, workflowPath)) {
      workflowInVm = `${vmWorkdir}/${projectRelative?.(workflowPath)}`
    }
  }

  if (process.platform === "darwin") {
    limactlShell(options.vm, ["sudo", "-u", "ralph", "mkdir", "-p", `${vmWorkdir}/specs`, reportDir])
  } else if (process.platform === "linux") {
    const ip = getVmIp(options.vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
    ssh(ip, ["mkdir", "-p", `${vmWorkdir}/specs`, reportDir])
  }

  writeFileRemote(options.vm, specInVm, specMinified)
  writeFileRemote(options.vm, todoInVm, todoMinified)
  if (!projectDir || !pathWithin(projectDir, workflowPath)) {
    writeFileRemote(options.vm, workflowInVm, readText(workflowPath))
  }
  if (promptPath) writeFileRemote(options.vm, `${vmWorkdir}/PROMPT.md`, readText(promptPath))
  if (reviewPromptPath) writeFileRemote(options.vm, `${vmWorkdir}/REVIEW_PROMPT.md`, readText(reviewPromptPath))
  if (reviewModelsPath) writeFileRemote(options.vm, `${vmWorkdir}/reviewer-models.json`, readText(reviewModelsPath))
  if (reviewersDir) {
    const reviewersVmDir = `${vmWorkdir}/reviewers`
    if (process.platform === "darwin") {
      limactlShell(options.vm, ["sudo", "-u", "ralph", "mkdir", "-p", reviewersVmDir])
    } else if (process.platform === "linux") {
      const ip = getVmIp(options.vm)
      if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
      ssh(ip, ["bash", "-lc", `mkdir -p \"${reviewersVmDir}\"`])
    }
    copyDirRemote(options.vm, reviewersDir, reviewersVmDir)
  }

  const runContext = buildRunContext({
    runId,
    vm: options.vm,
    specPath,
    todoPath,
    promptPath,
    reviewPromptPath,
    reviewModelsPath,
    reviewersDir,
    repoUrl: repoUrl ?? undefined,
    repoRef: repoRef ?? undefined,
    cliVersion: CLI_VERSION,
    osInfo,
    binaryHash,
    gitSha
  })
  writeFileRemote(options.vm, `${reportDir}/run-context.json`, runContext)

  if (repoUrl) {
    cloneRepoInVm(options.vm, vmWorkdir, repoUrl, repoRef)
    verifyGitAndInitJj(options.vm, projectRootInVm)
  }

  ensureBunReady(options.vm)

  if (process.platform === "darwin") {
    maybeInstallDeps(options.vm, projectRootInVm)
  } else if (process.platform === "linux") {
    const ip = getVmIp(options.vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
    ssh(ip, [
      "bash",
      "-lc",
      [
        `cd "${projectRootInVm}"`,
        "if [ -f package.json ]; then",
        `  echo "[${options.vm}] Installing dependencies (bun install)..."`,
        "  export PATH=\"$HOME/.bun/bin:$PATH\"",
        "  export BUN_INSTALL_IGNORE_SCRIPTS=0",
        "  export npm_config_ignore_scripts=false",
        "  BUN_CHECK_OUTPUT=$(bun --version 2>&1 || true)",
        "  if echo \"$BUN_CHECK_OUTPUT\" | grep -q 'postinstall script was not run'; then",
        `    echo "[${options.vm}] Fixing bun postinstall..."`,
        "    if command -v node >/dev/null 2>&1 && [ -f \"$HOME/.bun/install/global/node_modules/bun/install.js\" ]; then",
        "      node \"$HOME/.bun/install/global/node_modules/bun/install.js\"",
        "    fi",
        "  fi",
        "  bun install",
        "fi"
      ].join("\n")
    ])
  }

  console.log(`[${options.vm}] Starting Smithers workflow...`)
  const follow = options.follow === true
  const smithersScript = [
    `cd "${controlDir}"`,
    `echo "[${options.vm}] Control dir: $(pwd)"`,
    `LOG_FILE="${reportDir}/smithers.log"`,
    "mkdir -p \"$(dirname \"$LOG_FILE\")\"",
    "touch \"$LOG_FILE\"",
    "exec > >(tee -a \"$LOG_FILE\") 2>&1",
    "export PATH=\"$HOME/.bun/bin:$HOME/.bun/install/global/node_modules/.bin:$PATH\"",
    `# Check for global smithers (installed by NixOS)`,
    `if ! command -v smithers &>/dev/null; then`,
    `  echo "[${options.vm}] WARNING: smithers not found in PATH. Installing locally..."`,
    `  cd "${vmWorkdir}" && bun init -y 2>/dev/null || true`,
    `  cd "${vmWorkdir}" && bun add smithers-orchestrator@github:evmts/smithers#ea5ece3b156ebd32990ec9c528f9435c601a0403 zod 2>&1 || true`,
    `  export PATH="${vmWorkdir}/node_modules/.bin:$PATH"`,
    `else`,
    `  echo "[${options.vm}] Using global smithers ($(which smithers))"`,
      `  export NODE_PATH="$HOME/.bun/install/global/node_modules:$NODE_PATH"`,
    `fi`,
        `cd "${controlDir}"`,
    "if [ -f ~/.config/ralph/ralph.env ]; then set -a; source ~/.config/ralph/ralph.env; set +a; fi",
    "if [ -n \"${GITHUB_TOKEN:-}\" ]; then export GH_TOKEN=\"${GITHUB_TOKEN}\"; fi",
    `export MAX_ITERATIONS=${options.iterations ?? 100}`,
    `export RALPH_AGENT="${agentKind}"`,
    `export SMITHERS_SPEC_PATH="${specInVm}"`,
    `export SMITHERS_TODO_PATH="${todoInVm}"`,
    `export SMITHERS_REPORT_DIR="${reportDir}"`,
    `export SMITHERS_AGENT="${agentKind}"`,
    `export SMITHERS_CWD="${projectRootInVm}"`,
    `export SMITHERS_BRANCH="${branch}"`,
    `export SMITHERS_RUN_ID="${runId}"`,
    `export SMITHERS_DB_PATH="${smithersDbPath}"`,
    "mkdir -p \"$(dirname \"$SMITHERS_DB_PATH\")\"",
    workflowSha ? `export SMITHERS_WORKFLOW_SHA="${workflowSha}"` : "",
    options.model ? `export SMITHERS_MODEL="${options.model}"` : "",
    options.reviewMax ? `export SMITHERS_REVIEW_MAX="${options.reviewMax}"` : "",
    options.learn ? `export SMITHERS_LEARN="1"` : "",
    options.dynamic ? `export SMITHERS_DYNAMIC="1"` : "",
    `[ -f "${vmWorkdir}/PROMPT.md" ] && export SMITHERS_PROMPT_PATH="${vmWorkdir}/PROMPT.md" || true`,
    `[ -f "${vmWorkdir}/REVIEW_PROMPT.md" ] && export SMITHERS_REVIEW_PROMPT_PATH="${vmWorkdir}/REVIEW_PROMPT.md" || true`,
    `[ -f "${vmWorkdir}/reviewer-models.json" ] && export SMITHERS_REVIEW_MODELS_FILE="${vmWorkdir}/reviewer-models.json" || true`,
    `[ -d "${vmWorkdir}/reviewers" ] && export SMITHERS_REVIEWERS_DIR="${vmWorkdir}/reviewers" || true`,
    "SMITHERS_VERSION=$(smithers --version 2>&1 || true)",
    "if [ -z \"$SMITHERS_VERSION\" ]; then echo \"Smithers missing or not executable.\"; exit 1; fi",
    `printf '{"v":1,"version":"%s"}\n' "$SMITHERS_VERSION" > "${reportDir}/smithers-version.json"`,
    `CONTROL_DIR="${controlDir}"`,
    "PID_FILE=\"${CONTROL_DIR}/smithers.pid\"",
    "HEARTBEAT_FILE=\"${CONTROL_DIR}/heartbeat.json\"",
    "DB_PATH=\"${SMITHERS_DB_PATH:-${controlDir}/.smithers/${smithersDbName}}\"",
    "HEARTBEAT_SECONDS=30",
    "export CONTROL_DIR PID_FILE HEARTBEAT_FILE DB_PATH HEARTBEAT_SECONDS",
    "if [ -f \"$PID_FILE\" ]; then",
    "  OLD_PID=$(cat \"$PID_FILE\" || true)",
    "  if [ -n \"$OLD_PID\" ] && ! kill -0 \"$OLD_PID\" 2>/dev/null; then",
    "    python3 - <<'PY'",
    "import json, os, sqlite3, time",
    "db_path = os.environ.get('DB_PATH','')",
    "run_id = os.environ.get('SMITHERS_RUN_ID','')",
    "if not db_path or not os.path.exists(db_path):",
    "    raise SystemExit(0)",
    "try:",
    "    conn = sqlite3.connect(db_path)",
    "    payload = json.dumps({'reason': 'stale_process'})",
    "    now_ms = int(time.time() * 1000)",
    "    if run_id:",
    "        conn.execute(\"UPDATE _smithers_runs SET status='failed', finished_at_ms=?, error_json=? WHERE run_id=? AND status='running'\", (now_ms, payload, run_id))",
    "    else:",
    "        conn.execute(\"UPDATE _smithers_runs SET status='failed', finished_at_ms=?, error_json=? WHERE status='running'\", (now_ms, payload))",
    "    conn.commit()",
    "    conn.close()",
    "except Exception:",
    "    pass",
    "PY",
    "    rm -f \"$PID_FILE\"",
    "  fi",
    "fi",
    `# Run from smithers-runner directory with its own dependencies`,
    `cd "${vmWorkdir}/smithers-runner" && bun install 2>&1 | tail -5`,
    `echo "[${options.vm}] Starting workflow from smithers-runner..."`,
    `cd "${vmWorkdir}/smithers-runner" && bun run workflow.tsx &`,
    "SMITHERS_PID=$!",
    "export SMITHERS_PID",
    "echo \"$SMITHERS_PID\" > \"$PID_FILE\"",
    "(\nwhile kill -0 \"$SMITHERS_PID\" 2>/dev/null; do\n  python3 - <<'PY'\nimport json, os, sqlite3\nfrom datetime import datetime, timezone\nheartbeat = os.environ.get('HEARTBEAT_FILE','')\nrun_id = os.environ.get('SMITHERS_RUN_ID','')\nspec_path = os.environ.get('SMITHERS_SPEC_PATH','')\ndb_path = os.environ.get('DB_PATH','')\nphase = ''\ntry:\n    if db_path and os.path.exists(db_path) and run_id:\n        conn = sqlite3.connect(db_path)\n        cur = conn.execute(\"SELECT status FROM _smithers_runs WHERE run_id=? ORDER BY started_at_ms DESC LIMIT 1\", (run_id,))\n        row = cur.fetchone()\n        if row and row[0]:\n            phase = str(row[0])\n        conn.close()\nexcept Exception:\n    pass\npayload = {\n  'v': 1,\n  'ts': datetime.now(timezone.utc).isoformat(),\n  'pid': int(os.environ.get('SMITHERS_PID','0') or 0),\n  'run_id': run_id,\n  'spec_path': spec_path,\n  'phase': phase\n}\ntry:\n    with open(heartbeat, 'w', encoding='utf-8') as f:\n        json.dump(payload, f)\nexcept Exception:\n    pass\nPY\n  sleep \"$HEARTBEAT_SECONDS\"\ndone\n) &",
    "wait \"$SMITHERS_PID\"",
    "EXIT_CODE=$?",
    "echo \"$EXIT_CODE\" > \"${CONTROL_DIR}/exit_code\"",
    "rm -f \"$PID_FILE\""
  ]
    .filter(Boolean)
    .join("\n")

  if (process.platform === "darwin") {
    const runScriptPath = `${controlDir}/run.sh`
    writeFileInVm(options.vm, runScriptPath, `${smithersScript}\n`)
    const runCmd = follow
      ? `bash "${runScriptPath}"`
      : `nohup bash "${runScriptPath}" >/dev/null 2>&1 &`
    limactlShell(options.vm, ["bash", "-lc", runCmd])
  } else if (process.platform === "linux") {
    const ip = getVmIp(options.vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
    const runScriptPath = `${controlDir}/run.sh`
    const script = `cat <<'EOF' > "${runScriptPath}"\n${smithersScript}\nEOF\nchmod +x "${runScriptPath}"`
    ssh(ip, ["bash", "-lc", script])
    const runCmd = follow
      ? `bash "${runScriptPath}"`
      : `nohup bash "${runScriptPath}" >/dev/null 2>&1 &`
    ssh(ip, ["bash", "-lc", runCmd])
  }

  return {
    runId,
    vm: options.vm,
    workdir: vmWorkdir,
    controlDir,
    reportDir,
    branch,
    specId
  }
}
