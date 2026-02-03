import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, lstatSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { homedir } from "node:os"

const args = process.argv.slice(2)

type Pair = { from: string; to: string }

type Options = {
  root: string
  pairs: Pair[]
  intervalMs: number
  once: boolean
  role?: string
  cwd?: string
}

const parseArgs = (): { cmd: string; options: Options } => {
  const cmd = args[0] ?? ""
  const options: Options = {
    root: resolve(process.env.RALPH_QUEUE_DIR ?? join(homedir(), ".cache", "ralph", "queue")),
    pairs: [],
    intervalMs: 2000,
    once: false
  }

  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i]
    const next = args[i + 1]
    if (flag === "--root" && next) {
      options.root = resolve(next)
      i += 1
      continue
    }
    if (flag === "--pair" && next) {
      const [from, to] = next.split(":")
      if (from && to) options.pairs.push({ from, to })
      i += 1
      continue
    }
    if (flag === "--interval" && next) {
      options.intervalMs = Number(next)
      i += 1
      continue
    }
    if (flag === "--once") {
      options.once = true
      continue
    }
    if (flag === "--role" && next) {
      options.role = next
      i += 1
      continue
    }
    if (flag === "--cwd" && next) {
      options.cwd = resolve(next)
      i += 1
      continue
    }
  }

  if (options.pairs.length === 0) {
    options.pairs = [
      { from: "implementer", to: "reviewer" },
      { from: "reviewer", to: "implementer" }
    ]
  }

  return { cmd, options }
}

const ensureDir = (path: string) => {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

const mailboxPath = (root: string, role: string, box: "inbox" | "outbox" | "sent") =>
  join(root, role, box)

const initMailboxes = (root: string, role?: string) => {
  const roles = role ? [role] : ["implementer", "reviewer", "human"]
  roles.forEach((r) => {
    ensureDir(mailboxPath(root, r, "inbox"))
    ensureDir(mailboxPath(root, r, "outbox"))
    ensureDir(mailboxPath(root, r, "sent"))
  })
}

const linkMailbox = (root: string, role: string, cwd: string) => {
  const localInbox = join(cwd, "inbox")
  const localOutbox = join(cwd, "outbox")
  const inbox = mailboxPath(root, role, "inbox")
  const outbox = mailboxPath(root, role, "outbox")
  ensureDir(inbox)
  ensureDir(outbox)

  const ensureLink = (localPath: string, target: string) => {
    try {
      if (existsSync(localPath)) {
        const stat = lstatSync(localPath)
        if (stat.isDirectory() || stat.isSymbolicLink()) return
        return
      }
      const { symlinkSync } = require("node:fs")
      symlinkSync(target, localPath, "dir")
    } catch {
      ensureDir(localPath)
    }
  }

  ensureLink(localInbox, inbox)
  ensureLink(localOutbox, outbox)
}

const uniqueDest = (destDir: string, name: string) => {
  const base = basename(name)
  const candidate = join(destDir, base)
  if (!existsSync(candidate)) return candidate
  const stamp = new Date().toISOString().replace(/[:.]/g, "")
  return join(destDir, `${stamp}-${base}`)
}

const pumpPair = (root: string, from: string, to: string) => {
  const fromOutbox = mailboxPath(root, from, "outbox")
  const toInbox = mailboxPath(root, to, "inbox")
  const sentDir = mailboxPath(root, from, "sent")

  ensureDir(fromOutbox)
  ensureDir(toInbox)
  ensureDir(sentDir)

  const files = readdirSync(fromOutbox).filter((name) => !name.startsWith("."))
  files.forEach((name) => {
    const src = join(fromOutbox, name)
    const dest = uniqueDest(toInbox, name)
    const archived = uniqueDest(sentDir, name)
    try {
      copyFileSync(src, dest)
      renameSync(src, archived)
    } catch (error) {
      console.error(`[queue] Failed to move ${src} -> ${dest}: ${String(error)}`)
    }
  })
}

const watchPairs = (root: string, pairs: Pair[], intervalMs: number) => {
  const loop = () => {
    pairs.forEach((pair) => pumpPair(root, pair.from, pair.to))
  }
  loop()
  if (intervalMs <= 0) return
  setInterval(loop, intervalMs)
}

const { cmd, options } = parseArgs()

if (!cmd || cmd === "help") {
  console.log(`Usage: bun run scripts/message-queue.ts <init|pump|watch> [options]

Options:
  --root <dir>        Queue root (default: ~/.cache/ralph/queue)
  --pair a:b          Pump from a->b (repeatable). Default implementer<->reviewer
  --interval <ms>     Watch interval (default: 2000)
  --once              Run watch once and exit
  --role <name>       Role name (init)
  --cwd <dir>         Create ./inbox and ./outbox links in this dir (init)
`)
  process.exit(0)
}

if (cmd === "init") {
  initMailboxes(options.root, options.role)
  if (options.role) {
    const cwd = options.cwd ?? process.cwd()
    linkMailbox(options.root, options.role, cwd)
  }
  process.exit(0)
}

if (cmd === "pump") {
  initMailboxes(options.root)
  options.pairs.forEach((pair) => pumpPair(options.root, pair.from, pair.to))
  process.exit(0)
}

if (cmd === "watch") {
  initMailboxes(options.root)
  if (options.once) {
    options.pairs.forEach((pair) => pumpPair(options.root, pair.from, pair.to))
    process.exit(0)
  }
  watchPairs(options.root, options.pairs, options.intervalMs)
  return
}

console.error(`[queue] Unknown command: ${cmd}`)
process.exit(1)
