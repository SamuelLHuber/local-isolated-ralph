import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { runCommand, runCommandOutput } from "./exec.js"
import { ensureCommands } from "./prereqs.js"

// Validate ralph.env has export keywords
const validateRalphEnv = (content: string): { valid: boolean; issues: string[] } => {
  const issues: string[] = []
  const lines = content.split("\n")
  
  for (const line of lines) {
    // Skip comments and empty lines
    if (line.trim().startsWith("#") || !line.trim()) continue
    
    // Check for KEY=value without export
    if (line.match(/^[A-Z_][A-Z0-9_]*=/) && !line.match(/^export\s/)) {
      const key = line.split("=")[0]
      issues.push(`  - ${key} (missing 'export' keyword)`)
    }
  }
  
  return { valid: issues.length === 0, issues }
}

type SyncConfig = {
  vm: string
}

const run = (cmd: string, args: string[], cwd?: string, input?: string, context?: string) => {
  runCommand(cmd, args, { cwd, input, context })
}

const runShell = (script: string, cwd?: string, context?: string) => {
  runCommand("bash", ["-lc", script], { cwd, context })
}

const sshOpts = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]

const hostPath = (rel: string) => join(homedir(), rel)

const hasClaudeToken = () => {
  const path = hostPath(".claude.json")
  if (!existsSync(path)) return false
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    return Boolean(
      data.accessToken ||
        data.token ||
        data.oauthToken ||
        data.anthropicApiKey ||
        data.apiKey ||
        data.claudeCodeOAuthToken ||
        data.claude_code_oauth_token
    )
  } catch {
    return false
  }
}

const copyFileLima = (vm: string, src: string, dest: string) => {
  const data = existsSync(src) ? readFileSync(src, "utf8") : ""
  if (!data) return false
  run(
    "limactl",
    ["shell", "--workdir", "/home/ralph", vm, "bash", "-lc", `sudo -u ralph tee "${dest}" >/dev/null`],
    undefined,
    data
  )
  return true
}

const copyTarLima = (vm: string, baseDir: string, entry: string, destDir: string) => {
  const abs = join(baseDir, entry)
  if (!existsSync(abs)) return false
  const script = `COPYFILE_DISABLE=1 tar -C "${baseDir}" -cf - "${entry}" | limactl shell --workdir /home/ralph "${vm}" sudo -u ralph tar --warning=no-unknown-keyword -C "${destDir}" -xf -`
  runShell(script)
  return true
}

const copyCredentialsLima = (vm: string) => {
  const home = homedir()
  const userHome = "/home/ralph"

  run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "mkdir", "-p", `${userHome}/.config`])
  run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "chown", "-R", "ralph:users", `${userHome}/.config`])
  run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "chmod", "700", `${userHome}/.config`])
  run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "mkdir", "-p", `${userHome}/.pi/agent`])
  run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "chown", "-R", "ralph:users", `${userHome}/.pi`])
  run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "chmod", "700", `${userHome}/.pi`])
  run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "chmod", "700", `${userHome}/.pi/agent`])

  if (!copyTarLima(vm, home, ".claude", userHome)) {
    console.log("    Note: ~/.claude not found")
  } else {
    run("limactl", ["shell", "--workdir", "/home/ralph", vm, "chown", "-R", "ralph:users", `${userHome}/.claude`])
  }

  if (copyFileLima(vm, hostPath(".claude.json"), `${userHome}/.claude.json`)) {
    run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "chmod", "600", `${userHome}/.claude.json`])
    if (!hasClaudeToken()) {
      console.log("    Warning: ~/.claude.json has no token. Run `claude setup-token` or set ANTHROPIC_API_KEY in ralph.env.")
    }
  } else {
    console.log("    Note: ~/.claude.json not found")
  }

  if (!copyFileLima(vm, hostPath(".gitconfig"), `${userHome}/.gitconfig`)) {
    console.log("    Warning: Failed to copy ~/.gitconfig")
  }

  const sshKeys = ["id_ed25519", "id_rsa"]
  let hasKeys = false
  for (const key of sshKeys) {
    const keyPath = hostPath(join(".ssh", key))
    const pubPath = `${keyPath}.pub`
    if (!existsSync(keyPath)) continue
    hasKeys = true
    run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "mkdir", "-p", `${userHome}/.ssh`])
    run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "chmod", "700", `${userHome}/.ssh`])
    copyFileLima(vm, keyPath, `${userHome}/.ssh/${key}`)
    if (existsSync(pubPath)) {
      copyFileLima(vm, pubPath, `${userHome}/.ssh/${key}.pub`)
    }
    run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "chmod", "600", `${userHome}/.ssh/${key}`])
  }
  if (!hasKeys) console.log("    Note: No SSH keys found")

  copyTarLima(vm, join(home, ".config"), "gh", `${userHome}/.config`) ||
    console.log("    Warning: Failed to copy ~/.config/gh")

  if (!copyTarLima(vm, join(home, ".pi"), "agent", `${userHome}/.pi`)) {
    console.log("    Note: ~/.pi/agent not found (pi will need login in VM)")
  }

  if (copyFileLima(vm, hostPath(".codex/auth.json"), `${userHome}/.codex/auth.json`)) {
    run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "chmod", "600", `${userHome}/.codex/auth.json`])
  }

  if (copyFileLima(vm, hostPath(".config/ralph/ralph.env"), `${userHome}/.config/ralph/ralph.env`)) {
    run("limactl", ["shell", "--workdir", "/home/ralph", vm, "sudo", "-u", "ralph", "chmod", "600", `${userHome}/.config/ralph/ralph.env`])
    
    // Validate exports after copying
    const content = readFileSync(hostPath(".config/ralph/ralph.env"), "utf8")
    const validation = validateRalphEnv(content)
    if (!validation.valid) {
      console.log("    ⚠️  Warning: ralph.env has variables without 'export' keyword:")
      validation.issues.forEach(i => console.log(i))
      console.log("       This will cause 401 errors. Run: ./scripts/validate-ralph-env.sh")
    }
  } else {
    console.log("    Note: ~/.config/ralph/ralph.env not found")
  }
}

const ssh = (host: string, args: string[]) => run("ssh", [...sshOpts, `ralph@${host}`, ...args])
const scp = (args: string[]) => run("scp", [...sshOpts, ...args])

const copyCredentialsLinux = (vm: string) => {
  const output = runCommandOutput("virsh", ["domifaddr", vm], { context: "find VM IP" })
  const ip = output.split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes("ipv4"))
    ?.split(/\s+/)[3]
    ?.split("/")[0]

  if (!ip) throw new Error(`Could not determine IP for VM '${vm}'`)

  ssh(ip, ["sudo", "mkdir", "-p", "/home/ralph/.config"])
  ssh(ip, ["sudo", "chown", "-R", "ralph:users", "/home/ralph/.config"])
  ssh(ip, ["sudo", "-u", "ralph", "chmod", "700", "/home/ralph/.config"])
  ssh(ip, ["sudo", "mkdir", "-p", "/home/ralph/.pi/agent"])
  ssh(ip, ["sudo", "chown", "-R", "ralph:users", "/home/ralph/.pi"])
  ssh(ip, ["sudo", "-u", "ralph", "chmod", "700", "/home/ralph/.pi"])
  ssh(ip, ["sudo", "-u", "ralph", "chmod", "700", "/home/ralph/.pi/agent"])

  if (existsSync(hostPath(".claude"))) {
    scp(["-r", hostPath(".claude"), `ralph@${ip}:~/`])
  } else {
    console.log("    Note: ~/.claude not found")
  }

  if (existsSync(hostPath(".claude.json"))) {
    scp([hostPath(".claude.json"), `ralph@${ip}:~/`])
    ssh(ip, ["chmod", "600", "~/.claude.json"])
    if (!hasClaudeToken()) {
      console.log("    Warning: ~/.claude.json has no token. Run `claude setup-token` or set ANTHROPIC_API_KEY in ralph.env.")
    }
  } else {
    console.log("    Note: ~/.claude.json not found")
  }

  if (existsSync(hostPath(".gitconfig"))) {
    scp([hostPath(".gitconfig"), `ralph@${ip}:~/`])
  }

  const sshKeys = ["id_ed25519", "id_rsa"]
  let hasKeys = false
  for (const key of sshKeys) {
    const keyPath = hostPath(join(".ssh", key))
    const pubPath = `${keyPath}.pub`
    if (!existsSync(keyPath)) continue
    hasKeys = true
    ssh(ip, ["mkdir", "-p", "~/.ssh"])
    ssh(ip, ["chmod", "700", "~/.ssh"])
    scp([keyPath, pubPath, `ralph@${ip}:~/.ssh/`])
    ssh(ip, ["chmod", "600", `~/.ssh/${key}`])
  }
  if (!hasKeys) console.log("    Note: No SSH keys found")

  if (existsSync(hostPath(".config/gh"))) {
    ssh(ip, ["mkdir", "-p", "~/.config"])
    scp(["-r", hostPath(".config/gh"), `ralph@${ip}:~/.config/`])
  }

  if (existsSync(hostPath(".pi/agent"))) {
    ssh(ip, ["mkdir", "-p", "~/.pi"])
    scp(["-r", hostPath(".pi/agent"), `ralph@${ip}:~/.pi/`])
    ssh(ip, ["chmod", "700", "~/.pi", "~/.pi/agent"])
  } else {
    console.log("    Note: ~/.pi/agent not found (pi will need login in VM)")
    ssh(ip, ["mkdir", "-p", "~/.pi/agent"])
    ssh(ip, ["chmod", "700", "~/.pi", "~/.pi/agent"])
  }

  if (existsSync(hostPath(".codex/auth.json"))) {
    ssh(ip, ["mkdir", "-p", "~/.codex"])
    ssh(ip, ["chmod", "700", "~/.codex"])
    scp([hostPath(".codex/auth.json"), `ralph@${ip}:~/.codex/`])
    ssh(ip, ["chmod", "600", "~/.codex/auth.json"])
  }

  if (existsSync(hostPath(".config/ralph/ralph.env"))) {
    ssh(ip, ["mkdir", "-p", "~/.config/ralph"])
    ssh(ip, ["chmod", "700", "~/.config/ralph"])
    scp([hostPath(".config/ralph/ralph.env"), `ralph@${ip}:~/.config/ralph/`])
    ssh(ip, ["chmod", "600", "~/.config/ralph/ralph.env"])
    
    // Validate exports after copying
    const content = readFileSync(hostPath(".config/ralph/ralph.env"), "utf8")
    const validation = validateRalphEnv(content)
    if (!validation.valid) {
      console.log("    ⚠️  Warning: ralph.env has variables without 'export' keyword:")
      validation.issues.forEach(i => console.log(i))
      console.log("       This will cause 401 errors. Run: ./scripts/validate-ralph-env.sh")
    }
  } else {
    console.log("    Note: ~/.config/ralph/ralph.env not found")
  }
}

export const syncCredentials = ({ vm }: SyncConfig) => {
  console.log(`\n>>> Copying credentials to VM ${vm}...`)
  if (process.platform === "darwin") {
    ensureCommands([{ cmd: "limactl" }, { cmd: "tar" }, { cmd: "bash" }], "credentials sync requires limactl")
    copyCredentialsLima(vm)
  } else if (process.platform === "linux") {
    ensureCommands([{ cmd: "virsh" }, { cmd: "ssh" }, { cmd: "scp" }], "credentials sync requires virsh/ssh/scp")
    copyCredentialsLinux(vm)
  } else {
    throw new Error(`Unsupported OS: ${process.platform}`)
  }
  console.log("Credentials copied.")
}

// Host-side ralph.env validation
export const validateRalphEnvHost = (): { valid: boolean; issues: string[]; hasRequiredKeys: boolean } => {
  const envPath = hostPath(".config/ralph/ralph.env")
  
  if (!existsSync(envPath)) {
    return { valid: false, issues: ["~/.config/ralph/ralph.env not found"], hasRequiredKeys: false }
  }
  
  const content = readFileSync(envPath, "utf8")
  const exportValidation = validateRalphEnv(content)
  
  // Check for required keys
  const requiredPatterns = [
    { name: "GITHUB_TOKEN", pattern: /export\s+GITHUB_TOKEN=/ },
    { name: "LLM API Key (FIREWORKS_API_KEY, API_KEY_MOONSHOT, or ANTHROPIC_API_KEY)", 
      pattern: /export\s+(FIREWORKS_API_KEY|API_KEY_MOONSHOT|ANTHROPIC_API_KEY)=/ }
  ]
  
  const missingKeys: string[] = []
  for (const { name, pattern } of requiredPatterns) {
    if (!pattern.test(content)) {
      missingKeys.push(`  - ${name}`)
    }
  }
  
  const allIssues = [...exportValidation.issues, ...missingKeys]
  
  return {
    valid: exportValidation.valid && missingKeys.length === 0,
    issues: allIssues,
    hasRequiredKeys: missingKeys.length === 0
  }
}

// Test API keys in a VM
export const testApiKeysInVm = (vm: string): { success: boolean; results: Record<string, boolean> } => {
  const results: Record<string, boolean> = {}
  
  const testScript = `
source ~/.config/ralph/ralph.env 2>/dev/null || exit 1

# Test GitHub token
if [[ -n "\${GITHUB_TOKEN:-}" ]]; then
  github_status=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token \$GITHUB_TOKEN" https://api.github.com/user 2>/dev/null)
  if [[ "$github_status" == "200" ]]; then
    echo "github:true"
  else
    echo "github:false (HTTP $github_status)"
  fi
else
  echo "github:missing"
fi

# Test Fireworks (optional)
if [[ -n "\${FIREWORKS_API_KEY:-}" ]]; then
  echo "fireworks:present"
else
  echo "fireworks:missing"
fi

# Test Moonshot (optional)
if [[ -n "\${API_KEY_MOONSHOT:-}" ]]; then
  echo "moonshot:present"
else
  echo "moonshot:missing"
fi

# Test Anthropic (optional)
if [[ -n "\${ANTHROPIC_API_KEY:-}" ]]; then
  echo "anthropic:present"
else
  echo "anthropic:missing"
fi
`
  
  try {
    let output: string
    if (process.platform === "darwin") {
      output = runCommandOutput(
        "limactl",
        ["shell", "--workdir", "/home/ralph", vm, "bash", "-lc", testScript],
        { context: `test API keys in ${vm}` }
      )
    } else {
      // For Linux, we'd need the VM IP
      output = "github:unknown"
    }
    
    for (const line of output.split("\n")) {
      const [key, value] = line.split(":")
      if (key && value) {
        results[key] = value.startsWith("true") || value === "present"
      }
    }
    
    const success = results.github === true
    return { success, results }
  } catch (error) {
    return { success: false, results: { error: false } }
  }
}
