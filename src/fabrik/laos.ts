import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"

const defaultRepo = "https://github.com/dtechvision/laos"
const defaultBranch = "main"

export type LaosConfig = {
  repoUrl?: string | unknown
  branch?: string | unknown
  dir?: string | unknown
}

const resolveDir = (dir?: string) =>
  dir ?? join(homedir(), ".cache", "fabrik", "laos")

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const run = (cmd: string, args: string[], cwd?: string) => {
  execFileSync(cmd, args, { stdio: "inherit", cwd })
}

const assertCommand = (cmd: string) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" })
  } catch {
    throw new Error(`Required command not found in PATH: ${cmd}`)
  }
}

const ensureRepo = (config: LaosConfig) => {
  assertCommand("jj")
  const repoUrl = asString(config.repoUrl) ?? defaultRepo
  const branch = asString(config.branch) ?? defaultBranch
  const dir = resolveDir(asString(config.dir))

  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true })
    run("jj", ["git", "clone", repoUrl, dir])
    return dir
  }

  const jjDir = join(dir, ".jj")
  if (!existsSync(jjDir)) {
    run("jj", ["git", "clone", repoUrl, dir + ".fresh"])
    return dir + ".fresh"
  }

  try {
    run("jj", ["git", "fetch"], dir)
    run("jj", ["rebase", "-s", "@", "-d", `origin/${branch}`], dir)
  } catch {
    try {
      run("jj", ["rebase", "-s", "@", "-d", "origin/master"], dir)
    } catch {
      // fallback to fresh clone if repo is in bad state
      run("jj", ["git", "clone", repoUrl, dir + ".fresh"])
      return dir + ".fresh"
    }
  }

  return dir
}

const ensureEnv = (dir: string) => {
  const envPath = join(dir, ".env")
  if (existsSync(envPath)) return
  const examplePath = join(dir, ".env.example")
  if (!existsSync(examplePath)) return
  const example = readFileSync(examplePath, "utf8")
  const sentry = randomBytes(32).toString("hex")
  const posthog = randomBytes(32).toString("hex")
  const payload =
    example +
    `\nSENTRY_SECRET_KEY=${sentry}\n` +
    `POSTHOG_SECRET_KEY=${posthog}\n`
  writeFileSync(envPath, payload, "utf8")
}

export const laosUp = (config: LaosConfig) => {
  assertCommand("docker")
  const dir = ensureRepo(config)
  ensureEnv(dir)
  run("docker", ["compose", "up", "-d"], dir)
}

export const laosDown = (config: LaosConfig) => {
  assertCommand("docker")
  const dir = ensureRepo(config)
  run("docker", ["compose", "down"], dir)
}

export const laosStatus = (config: LaosConfig) => {
  assertCommand("docker")
  const dir = ensureRepo(config)
  run("docker", ["compose", "ps"], dir)
}

export const laosLogs = (config: LaosConfig, follow: boolean) => {
  assertCommand("docker")
  const dir = ensureRepo(config)
  const args = ["compose", "logs"]
  if (follow) args.push("-f")
  run("docker", args, dir)
}
