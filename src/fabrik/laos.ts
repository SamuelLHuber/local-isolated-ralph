import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"

const defaultRepo = "https://github.com/dtechvision/laos"
const defaultBranch = "master"

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

const assertCommand = (cmd: string): boolean => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const pickVcs = () => {
  const hasJj = assertCommand("jj")
  const hasGit = assertCommand("git")
  if (!hasJj && !hasGit) {
    throw new Error("Required command not found in PATH: jj or git")
  }
  return { hasJj, hasGit }
}

const ensureRepoWithGit = (repoUrl: string, branch: string, dir: string) => {
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true })
    run("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, dir])
    return dir
  }

  const gitDir = join(dir, ".git")
  if (!existsSync(gitDir)) {
    run("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, dir + ".fresh"])
    return dir + ".fresh"
  }

  run("git", ["fetch", "origin"], dir)
  run("git", ["checkout", branch], dir)
  run("git", ["pull", "--ff-only"], dir)
  return dir
}

const ensureRepo = (config: LaosConfig) => {
  const repoUrl = asString(config.repoUrl) ?? defaultRepo
  const branch = asString(config.branch) ?? defaultBranch
  const dir = resolveDir(asString(config.dir))

  const { hasJj } = pickVcs()
  if (!hasJj) {
    return ensureRepoWithGit(repoUrl, branch, dir)
  }

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
  if (!assertCommand("docker")) {
    throw new Error("Required command not found in PATH: docker")
  }
  const dir = ensureRepo(config)
  ensureEnv(dir)
  run("bash", ["./scripts/laos-up.sh"], dir)
}

export const laosDown = (config: LaosConfig) => {
  if (!assertCommand("docker")) {
    throw new Error("Required command not found in PATH: docker")
  }
  const dir = ensureRepo(config)
  run("docker", ["compose", "down"], dir)
}

export const laosStatus = (config: LaosConfig) => {
  if (!assertCommand("docker")) {
    throw new Error("Required command not found in PATH: docker")
  }
  const dir = ensureRepo(config)
  run("docker", ["compose", "ps"], dir)
}

export const laosLogs = (config: LaosConfig, follow: boolean) => {
  if (!assertCommand("docker")) {
    throw new Error("Required command not found in PATH: docker")
  }
  const dir = ensureRepo(config)
  const args = ["compose", "logs"]
  if (follow) args.push("-f")
  run("docker", args, dir)
}
