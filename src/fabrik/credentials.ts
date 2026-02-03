import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type SyncConfig = {
  vm: string
}

const run = (cmd: string, args: string[], cwd?: string, input?: string) => {
  execFileSync(cmd, args, { stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", cwd, input })
}

const runShell = (script: string, cwd?: string) => {
  execFileSync("bash", ["-lc", script], { stdio: "inherit", cwd })
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
  const data = existsSync(src) ? execFileSync("cat", [src]).toString() : ""
  if (!data) return false
  run(
    "limactl",
    ["shell", vm, "bash", "-lc", `sudo -u ralph tee "${dest}" >/dev/null`],
    undefined,
    data
  )
  return true
}

const copyTarLima = (vm: string, baseDir: string, entry: string, destDir: string) => {
  const abs = join(baseDir, entry)
  if (!existsSync(abs)) return false
  const script = `COPYFILE_DISABLE=1 tar -C "${baseDir}" -cf - "${entry}" | limactl shell "${vm}" sudo -u ralph tar --warning=no-unknown-keyword -C "${destDir}" -xf -`
  runShell(script)
  return true
}

const copyCredentialsLima = (vm: string) => {
  const home = homedir()
  const userHome = "/home/ralph"

  run("limactl", ["shell", vm, "sudo", "mkdir", "-p", `${userHome}/.config`])
  run("limactl", ["shell", vm, "sudo", "chown", "-R", "ralph:users", `${userHome}/.config`])
  run("limactl", ["shell", vm, "sudo", "-u", "ralph", "chmod", "700", `${userHome}/.config`])

  if (!copyTarLima(vm, home, ".claude", userHome)) {
    console.log("    Note: ~/.claude not found")
  } else {
    run("limactl", ["shell", vm, "chown", "-R", "ralph:users", `${userHome}/.claude`])
  }

  if (copyFileLima(vm, hostPath(".claude.json"), `${userHome}/.claude.json`)) {
    run("limactl", ["shell", vm, "sudo", "-u", "ralph", "chmod", "600", `${userHome}/.claude.json`])
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
    run("limactl", ["shell", vm, "sudo", "-u", "ralph", "mkdir", "-p", `${userHome}/.ssh`])
    run("limactl", ["shell", vm, "sudo", "-u", "ralph", "chmod", "700", `${userHome}/.ssh`])
    copyFileLima(vm, keyPath, `${userHome}/.ssh/${key}`)
    if (existsSync(pubPath)) {
      copyFileLima(vm, pubPath, `${userHome}/.ssh/${key}.pub`)
    }
    run("limactl", ["shell", vm, "sudo", "-u", "ralph", "chmod", "600", `${userHome}/.ssh/${key}`])
  }
  if (!hasKeys) console.log("    Note: No SSH keys found")

  copyTarLima(vm, join(home, ".config"), "gh", `${userHome}/.config`) ||
    console.log("    Warning: Failed to copy ~/.config/gh")

  if (copyFileLima(vm, hostPath(".codex/auth.json"), `${userHome}/.codex/auth.json`)) {
    run("limactl", ["shell", vm, "sudo", "-u", "ralph", "chmod", "600", `${userHome}/.codex/auth.json`])
  }

  if (copyFileLima(vm, hostPath(".config/ralph/ralph.env"), `${userHome}/.config/ralph/ralph.env`)) {
    run("limactl", ["shell", vm, "sudo", "-u", "ralph", "chmod", "600", `${userHome}/.config/ralph/ralph.env`])
  } else {
    console.log("    Note: ~/.config/ralph/ralph.env not found")
  }
}

const ssh = (host: string, args: string[]) => run("ssh", [...sshOpts, `ralph@${host}`, ...args])
const scp = (args: string[]) => run("scp", [...sshOpts, ...args])

const copyCredentialsLinux = (vm: string) => {
  const ip = execFileSync("virsh", ["domifaddr", vm]).toString().split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes("ipv4"))
    ?.split(/\s+/)[3]
    ?.split("/")[0]

  if (!ip) throw new Error(`Could not determine IP for VM '${vm}'`)

  ssh(ip, ["sudo", "mkdir", "-p", "/home/ralph/.config"])
  ssh(ip, ["sudo", "chown", "-R", "ralph:users", "/home/ralph/.config"])
  ssh(ip, ["sudo", "-u", "ralph", "chmod", "700", "/home/ralph/.config"])

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
  } else {
    console.log("    Note: ~/.config/ralph/ralph.env not found")
  }
}

export const syncCredentials = ({ vm }: SyncConfig) => {
  console.log(`\n>>> Copying credentials to VM ${vm}...`)
  if (process.platform === "darwin") {
    copyCredentialsLima(vm)
  } else if (process.platform === "linux") {
    copyCredentialsLinux(vm)
  } else {
    throw new Error(`Unsupported OS: ${process.platform}`)
  }
  console.log("Credentials copied.")
}
