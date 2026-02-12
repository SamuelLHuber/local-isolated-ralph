import { execFileSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

type RunMode = "inherit" | "capture"

type RunCommandOptions = {
  cwd?: string
  input?: string
  mode?: RunMode
  context?: string
  env?: NodeJS.ProcessEnv
}

type CommandSpec = {
  cmd: string
  hint?: string
  purpose?: string
}

const COMMAND_HINTS: Record<string, string> = {
  limactl: "Install Lima: `brew install lima` (then `limactl start`)",
  virsh: "Install libvirt tools: `sudo apt install libvirt-clients`",
  jj: "Install Jujutsu: https://github.com/martinvonz/jj",
  git: "Install Git (e.g. `brew install git` or `sudo apt install git`)",
  docker: "Install Docker Desktop or Docker Engine: https://docs.docker.com/get-docker/",
  ssh: "Install OpenSSH client (e.g. `sudo apt install openssh-client`)",
  scp: "Install OpenSSH client (e.g. `sudo apt install openssh-client`)",
  tar: "Install tar (e.g. `sudo apt install tar`)",
  bash: "Install bash (e.g. `sudo apt install bash`)"
}

const formatArg = (arg: string) => (/\s|["']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)

const formatCommand = (cmd: string, args: string[]) => [cmd, ...args.map(formatArg)].join(" ")

const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const hasCommand = (cmd: string) => {
  if (!cmd) return false
  if (cmd.includes("/") || isAbsolute(cmd)) return isExecutable(cmd)

  const pathValue = process.env.PATH ?? ""
  if (!pathValue) return false
  const pathExts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""]
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const ext of pathExts) {
      const candidate = join(dir, `${cmd}${ext}`)
      if (isExecutable(candidate)) return true
    }
  }
  return false
}

const buildPrereqError = (missing: CommandSpec[], context?: string) => {
  const lines: string[] = []
  const names = missing.map((spec) => spec.cmd).join(", ")
  lines.push(`Missing required command(s): ${names}`)
  if (context) lines.push(`Context: ${context}`)
  for (const spec of missing) {
    const hint = spec.hint ?? COMMAND_HINTS[spec.cmd]
    if (hint) lines.push(`Hint for ${spec.cmd}: ${hint}`)
    if (spec.purpose) lines.push(`Reason for ${spec.cmd}: ${spec.purpose}`)
  }
  return new Error(lines.join("\n"))
}

export const ensureCommands = (specs: CommandSpec[], context?: string) => {
  const missing = specs.filter((spec) => !hasCommand(spec.cmd))
  if (missing.length) {
    throw buildPrereqError(missing, context)
  }
}

export const ensureAnyCommand = (specs: CommandSpec[], context?: string) => {
  if (specs.some((spec) => hasCommand(spec.cmd))) return
  throw buildPrereqError(specs, context)
}

const buildCommandError = (
  cmd: string,
  args: string[],
  options: RunCommandOptions | undefined,
  error: unknown
) => {
  const details: string[] = []
  details.push(`Command failed: ${formatCommand(cmd, args)}`)
  if (options?.cwd) details.push(`cwd: ${options.cwd}`)
  if (options?.context) details.push(`Context: ${options.context}`)

  const err = error as NodeJS.ErrnoException & { status?: number; signal?: string; stderr?: Buffer }
  if (err.code === "ENOENT") {
    details.push("Reason: command not found in PATH.")
    const hint = COMMAND_HINTS[cmd]
    if (hint) details.push(`Hint: ${hint}`)
  } else {
    if (typeof err.status === "number") details.push(`Exit code: ${err.status}`)
    if (err.signal) details.push(`Signal: ${err.signal}`)
  }

  if (err.stderr && options?.mode === "capture") {
    const snippet = err.stderr.toString().trim()
    if (snippet) details.push(`stderr: ${snippet.slice(0, 2000)}`)
  }

  const wrapped = new Error(details.join("\n"))
  wrapped.cause = error as Error
  return wrapped
}

export const runCommand = (cmd: string, args: string[], options?: RunCommandOptions) => {
  const mode = options?.mode ?? "inherit"
  const stdio =
    mode === "capture"
      ? ["pipe", "pipe", "pipe"]
      : options?.input
        ? ["pipe", "inherit", "inherit"]
        : "inherit"
  try {
    const result = execFileSync(cmd, args, {
      cwd: options?.cwd,
      env: options?.env,
      input: options?.input,
      stdio
    })
    if (mode === "capture") return (result ?? "").toString()
    return ""
  } catch (error) {
    throw buildCommandError(cmd, args, options, error)
  }
}

export const runCommandOutput = (cmd: string, args: string[], options?: RunCommandOptions) =>
  runCommand(cmd, args, { ...options, mode: "capture" })
