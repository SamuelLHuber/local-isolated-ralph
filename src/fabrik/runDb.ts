import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { Database } from "bun:sqlite"

export type RunRecord = {
  id: number
  vm_name: string
  workdir: string
  spec_path: string
  todo_path: string
  repo_url: string | null
  repo_ref: string | null
  started_at: string
  status: string
  exit_code: number | null
  cli_version: string | null
  os: string | null
  binary_hash: string | null
  git_sha: string | null
}

export type RunInsert = Omit<RunRecord, "id" | "exit_code"> & { exit_code?: number | null }

const DEFAULT_DB = resolve(homedir(), ".cache", "ralph", "ralph.db")

const ensureParent = (path: string) => {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

const ensureRunsTable = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vm_name TEXT NOT NULL,
      workdir TEXT NOT NULL,
      spec_path TEXT NOT NULL,
      todo_path TEXT NOT NULL,
      repo_url TEXT,
      repo_ref TEXT,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      cli_version TEXT,
      os TEXT,
      binary_hash TEXT,
      git_sha TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_vm_started ON runs(vm_name, started_at);
  `)

  const columns = db.query("PRAGMA table_info(runs)").all() as { name: string }[]
  const existing = new Set(columns.map((col) => col.name))
  const ensureColumn = (name: string, type: string) => {
    if (existing.has(name)) return
    db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`)
  }

  ensureColumn("repo_url", "TEXT")
  ensureColumn("repo_ref", "TEXT")
  ensureColumn("cli_version", "TEXT")
  ensureColumn("os", "TEXT")
  ensureColumn("binary_hash", "TEXT")
  ensureColumn("git_sha", "TEXT")
}

const ensureFeedbackTable = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      vm_name TEXT NOT NULL,
      spec_path TEXT NOT NULL,
      decision TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
}

export const resolveDbPath = (path?: string) => path ? resolve(path) : DEFAULT_DB

export const openRunDb = (path?: string) => {
  const dbPath = resolveDbPath(path)
  ensureParent(dbPath)
  const db = new Database(dbPath)
  ensureRunsTable(db)
  ensureFeedbackTable(db)
  return { db, path: dbPath }
}

export const insertRun = (db: Database, record: RunInsert) => {
  const statement = db.query(`
    INSERT INTO runs (
      vm_name, workdir, spec_path, todo_path, repo_url, repo_ref,
      started_at, status, exit_code, cli_version, os, binary_hash, git_sha
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const info = statement.run(
    record.vm_name,
    record.workdir,
    record.spec_path,
    record.todo_path,
    record.repo_url ?? null,
    record.repo_ref ?? null,
    record.started_at,
    record.status,
    record.exit_code ?? null,
    record.cli_version ?? null,
    record.os ?? null,
    record.binary_hash ?? null,
    record.git_sha ?? null
  )
  return Number(info.lastInsertRowid)
}

export const updateRunStatus = (db: Database, runId: number, status: string, exitCode: number | null) => {
  db.query("UPDATE runs SET status = ?, exit_code = ? WHERE id = ?").run(status, exitCode, runId)
}

export const findRunById = (db: Database, runId: number) => {
  return db.query<RunRecord>(
    "SELECT id, vm_name, workdir, spec_path, todo_path, repo_url, repo_ref, started_at, status, exit_code, cli_version, os, binary_hash, git_sha FROM runs WHERE id = ?"
  ).get(runId) as RunRecord | undefined
}

export const listRuns = (db: Database, limit: number) =>
  db.query<RunRecord>(
    "SELECT id, vm_name, workdir, spec_path, todo_path, repo_url, repo_ref, started_at, status, exit_code, cli_version, os, binary_hash, git_sha FROM runs ORDER BY started_at DESC LIMIT ?"
  ).all(limit) as RunRecord[]

export const findLatestRunForVm = (db: Database, vm: string) =>
  db
    .query<RunRecord>(
      "SELECT id, vm_name, workdir, spec_path, todo_path, repo_url, repo_ref, started_at, status, exit_code, cli_version, os, binary_hash, git_sha FROM runs WHERE vm_name = ? ORDER BY started_at DESC LIMIT 1"
    )
    .get(vm) as RunRecord | undefined

export const findLatestRunForVmSpec = (db: Database, vm: string, spec: string) =>
  db
    .query<RunRecord>(
      "SELECT id, vm_name, workdir, spec_path, todo_path, repo_url, repo_ref, started_at, status, exit_code, cli_version, os, binary_hash, git_sha FROM runs WHERE vm_name = ? AND spec_path = ? ORDER BY started_at DESC LIMIT 1"
    )
    .get(vm, spec) as RunRecord | undefined

export const insertFeedback = (
  db: Database,
  data: { runId: number; vm: string; spec: string; decision: string; notes: string; createdAt: string }
) => {
  db.query(
    "INSERT INTO human_feedback (run_id, vm_name, spec_path, decision, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(data.runId, data.vm, data.spec, data.decision, data.notes, data.createdAt)
}
