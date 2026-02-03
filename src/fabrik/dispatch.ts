import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, join, resolve, relative, isAbsolute } from "node:path"
import ts from "typescript"

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
  branch?: string
  requireAgents?: string[]
  follow?: boolean
}

export type DispatchResult = {
  runId: string
  vm: string
  workdir: string
  controlDir: string
  reportDir: string
  branch: string
  specId: string
}

const run = (cmd: string, args: string[], input?: string) => {
  execFileSync(cmd, args, { stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", input })
}

const readText = (path?: string) => {
  if (!path) return ""
  if (!existsSync(path)) return ""
  return readFileSync(path, "utf8")
}

const workflowAgentNeeds = (workflowPath: string) => {
  const text = readText(workflowPath)
  if (!text) return { needsCodex: false, needsClaude: false, needsOpencode: false }
  const source = ts.createSourceFile(workflowPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let needsCodex = false
  let needsClaude = false
  let needsOpencode = false
  const checkTag = (tagName: string) => {
    if (tagName === "Codex") needsCodex = true
    if (tagName === "Claude") needsClaude = true
    if (tagName === "OpenCode") needsOpencode = true
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName
      if (ts.isIdentifier(tag)) {
        checkTag(tag.text)
      } else if (ts.isPropertyAccessExpression(tag)) {
        const base = tag.expression
        if (ts.isIdentifier(base) && base.text === "Orchestrator") {
          checkTag(tag.name.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { needsCodex, needsClaude, needsOpencode }
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

export const dispatchRun = (options: DispatchOptions): DispatchResult => {
  const specPath = safeRealpath(options.spec)!
  const todoPath = safeRealpath(options.todo)!
  const workflowPath = safeRealpath(options.workflow ?? "scripts/smithers-spec-runner.tsx")!
  const workflowSha = sha256(workflowPath)
  const workflowNeeds = workflowAgentNeeds(workflowPath)
  const requiredAgents = options.requireAgents?.map((a) => a.trim().toLowerCase()).filter(Boolean) ?? []
  const promptPath = safeRealpath(options.prompt)
  const reviewPromptPath = safeRealpath(options.reviewPrompt)
  const reviewModelsPath = safeRealpath(options.reviewModels)
  const projectDir = options.project ? safeRealpath(options.project)! : undefined
  const agentKind = (process.env.SMITHERS_AGENT ?? process.env.RALPH_AGENT ?? "codex").toLowerCase()
  const specId = readSpecId(specPath)
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`
  const branch = sanitizeBranch(options.branch ?? (specId ? `spec-${specId}` : `spec-run-${runId}`))
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

  console.log(`[${options.vm}] Dispatching spec: ${specPath}`)
  console.log(`[${options.vm}] Include .git: ${options.includeGit}`)
  console.log(`[${options.vm}] Work dir: ${vmWorkdir}`)
  console.log(`[${options.vm}] Branch: ${branch}`)
  const detectedAgents = [
    workflowNeeds.needsCodex ? "codex" : null,
    workflowNeeds.needsClaude ? "claude" : null,
    workflowNeeds.needsOpencode ? "opencode" : null
  ].filter(Boolean)
  console.log(`[${options.vm}] Workflow agents detected: ${detectedAgents.length ? detectedAgents.join(", ") : "none"}`)
  if (!detectedAgents.length && !requiredAgents.length) {
    throw new Error(
      [
        "No agent components detected in workflow.",
        "Provide explicit requirements with --require-agents codex,opencode (comma-separated)."
      ].join("\n")
    )
  }

  const needsCodex =
    workflowNeeds.needsCodex || requiredAgents.includes("codex") || agentKind === "codex"
  const needsOpencode =
    workflowNeeds.needsOpencode || requiredAgents.includes("opencode") || agentKind === "opencode"
  const needsClaude =
    workflowNeeds.needsClaude || requiredAgents.includes("claude") || agentKind === "claude"

  if (needsCodex) {
    requireFile(
      "Codex auth",
      join(process.env.HOME ?? "", ".codex/auth.json"),
      "Run `codex login` or copy ~/.codex/auth.json before dispatch."
    )
  }

  if (needsOpencode) {
    requireFile(
      "OpenCode auth",
      join(process.env.HOME ?? "", ".local/share/opencode/auth.json"),
      "Run `opencode auth login` or copy ~/.local/share/opencode/auth.json before dispatch."
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

  ensureBunReady(options.vm)

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
  const follow = options.follow !== false
  const smithersScript = [
    `cd "${controlDir}"`,
    `echo "[${options.vm}] Control dir: $(pwd)"`,
    "export PATH=\"$HOME/.bun/bin:$PATH\"",
    "if [ -f ~/.config/ralph/ralph.env ]; then set -a; source ~/.config/ralph/ralph.env; set +a; fi",
    "if [ -n \"${GITHUB_TOKEN:-}\" ]; then export GH_TOKEN=\"${GITHUB_TOKEN}\"; fi",
    `export MAX_ITERATIONS=${options.iterations ?? 100}`,
    `export RALPH_AGENT=codex`,
    `export SMITHERS_SPEC_PATH="${specInVm}"`,
    `export SMITHERS_TODO_PATH="${todoInVm}"`,
    `export SMITHERS_REPORT_DIR="${reportDir}"`,
    `export SMITHERS_AGENT=codex`,
    `export SMITHERS_CWD="${vmWorkdir}"`,
    `export SMITHERS_BRANCH="${branch}"`,
    `export SMITHERS_RUN_ID="${runId}"`,
    workflowSha ? `export SMITHERS_WORKFLOW_SHA="${workflowSha}"` : "",
    options.model ? `export SMITHERS_MODEL="${options.model}"` : "",
    options.reviewMax ? `export SMITHERS_REVIEW_MAX="${options.reviewMax}"` : "",
    `[ -f "${vmWorkdir}/PROMPT.md" ] && export SMITHERS_PROMPT_PATH="${vmWorkdir}/PROMPT.md" || true`,
    `[ -f "${vmWorkdir}/REVIEW_PROMPT.md" ] && export SMITHERS_REVIEW_PROMPT_PATH="${vmWorkdir}/REVIEW_PROMPT.md" || true`,
    `[ -f "${vmWorkdir}/reviewer-models.json" ] && export SMITHERS_REVIEW_MODELS_FILE="${vmWorkdir}/reviewer-models.json" || true`,
    `smithers "${workflowInVm}"`
  ]
    .filter(Boolean)
    .join("\n")

  if (process.platform === "darwin") {
    const runScriptPath = `${controlDir}/run.sh`
    writeFileInVm(options.vm, runScriptPath, `${smithersScript}\n`)
    const runCmd = follow
      ? `bash "${runScriptPath}"`
      : `nohup bash "${runScriptPath}" > "${controlDir}/smithers.log" 2>&1 &`
    limactlShell(options.vm, ["bash", "-lc", runCmd])
  } else if (process.platform === "linux") {
    const ip = getVmIp(options.vm)
    if (!ip) throw new Error(`Could not determine IP for VM '${options.vm}'. Is it running?`)
    const runScriptPath = `${controlDir}/run.sh`
    const script = `cat <<'EOF' > "${runScriptPath}"\n${smithersScript}\nEOF\nchmod +x "${runScriptPath}"`
    ssh(ip, ["bash", "-lc", script])
    const runCmd = follow
      ? `bash "${runScriptPath}"`
      : `nohup bash "${runScriptPath}" > "${controlDir}/smithers.log" 2>&1 &`
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
