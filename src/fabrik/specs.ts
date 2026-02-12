import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

type SpecStatus = {
  id: string
  title?: string
  status?: string
  path: string
}

const isSpecFile = (name: string) =>
  name.endsWith(".json") && !name.endsWith(".todo.json") && !name.endsWith(".min.json")

export const listSpecs = (dir: string): SpecStatus[] => {
  const abs = resolve(dir)
  if (!existsSync(abs)) return []
  const files = readdirSync(abs).filter(isSpecFile)
  return files.map((file) => {
    const path = join(abs, file)
    try {
      const raw = readFileSync(path, "utf8")
      const json = JSON.parse(raw) as { id?: string; title?: string; status?: string }
      return {
        id: json.id ?? file.replace(/\.json$/, ""),
        title: json.title,
        status: json.status,
        path
      }
    } catch {
      return { id: file.replace(/\.json$/, ""), path }
    }
  })
}

const isJson = (name: string) => name.endsWith(".json") && !name.endsWith(".min.json")

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const onlyKeys = (obj: object, keys: string[]) =>
  Object.keys(obj).every((key) => keys.includes(key))

const validateSpec = (file: string, obj: Record<string, unknown>, errors: string[]) => {
  const keys = [
    "v",
    "id",
    "title",
    "status",
    "version",
    "lastUpdated",
    "supersedes",
    "dependsOn",
    "goals",
    "nonGoals",
    "req",
    "cfg",
    "accept",
    "assume"
  ]

  if (!onlyKeys(obj, keys)) {
    errors.push(`${file}: unexpected top-level keys`)
  }

  for (const key of ["v", "id", "title", "status", "version", "lastUpdated", "goals", "nonGoals", "req", "accept", "assume"]) {
    if (!(key in obj)) {
      errors.push(`${file}: missing ${key}`)
    }
  }

  if (obj.v !== 1) errors.push(`${file}: v must be 1`)
  for (const key of ["id", "title", "status", "version", "lastUpdated"]) {
    if (typeof obj[key] !== "string") errors.push(`${file}: ${key} must be string`)
  }

  for (const key of ["supersedes", "dependsOn", "goals", "nonGoals", "accept", "assume"]) {
    const value = obj[key]
    if (value !== undefined && !isStringArray(value)) {
      errors.push(`${file}: ${key} must be string[]`)
    }
  }

  const req = obj.req
  if (typeof req !== "object" || req === null) {
    errors.push(`${file}: req must be object`)
  } else {
    const reqKeys = ["api", "behavior", "obs"]
    if (!onlyKeys(req, reqKeys)) errors.push(`${file}: req has unexpected keys`)
    for (const key of reqKeys) {
      const value = (req as Record<string, unknown>)[key]
      if (value === undefined) errors.push(`${file}: req missing ${key}`)
      else if (!isStringArray(value)) errors.push(`${file}: req.${key} must be string[]`)
    }
  }

  const cfg = obj.cfg
  if (cfg !== undefined) {
    if (typeof cfg !== "object" || cfg === null) {
      errors.push(`${file}: cfg must be object`)
    } else {
      const cfgKeys = ["env"]
      if (!onlyKeys(cfg, cfgKeys)) errors.push(`${file}: cfg has unexpected keys`)
      const env = (cfg as Record<string, unknown>).env
      if (env !== undefined && !isStringArray(env)) errors.push(`${file}: cfg.env must be string[]`)
    }
  }
}

const validateTodo = (file: string, obj: Record<string, unknown>, errors: string[]) => {
  const keys = ["v", "id", "tdd", "dod", "tasks"]
  if (!onlyKeys(obj, keys)) errors.push(`${file}: unexpected top-level keys`)
  for (const key of keys) {
    if (!(key in obj)) errors.push(`${file}: missing ${key}`)
  }
  if (obj.v !== 1) errors.push(`${file}: v must be 1`)
  if (typeof obj.id !== "string") errors.push(`${file}: id must be string`)
  if (typeof obj.tdd !== "boolean") errors.push(`${file}: tdd must be boolean`)
  if (!isStringArray(obj.dod)) errors.push(`${file}: dod must be string[]`)

  if (!Array.isArray(obj.tasks)) {
    errors.push(`${file}: tasks must be array`)
  } else {
    for (const [index, task] of obj.tasks.entries()) {
      if (typeof task !== "object" || task === null) {
        errors.push(`${file}: tasks[${index}] must be object`)
        continue
      }
      const taskKeys = ["id", "do", "verify"]
      if (!onlyKeys(task, taskKeys)) errors.push(`${file}: tasks[${index}] unexpected keys`)
      for (const key of taskKeys) {
        const value = (task as Record<string, unknown>)[key]
        if (value === undefined) errors.push(`${file}: tasks[${index}] missing ${key}`)
        else if (typeof value !== "string") errors.push(`${file}: tasks[${index}].${key} must be string`)
      }
    }
  }
}

export const validateSpecs = (dir: string) => {
  const abs = resolve(dir)
  const entries = existsSync(abs) ? readdirSync(abs) : []
  const errors: string[] = []

  for (const entry of entries) {
    const fullPath = join(abs, entry)
    if (!existsSync(fullPath)) continue
    if (!isJson(entry)) continue

    const raw = readFileSync(fullPath, "utf8")
    const json = JSON.parse(raw) as Record<string, unknown>
    if (entry.endsWith(".todo.json")) validateTodo(entry, json, errors)
    else validateSpec(entry, json, errors)
  }

  if (errors.length > 0) {
    throw new Error(`Schema validation errors:\n${errors.join("\n")}`)
  }
}

export const minifySpecs = (dir: string) => {
  const abs = resolve(dir)
  const entries = existsSync(abs) ? readdirSync(abs) : []
  for (const entry of entries) {
    const fullPath = join(abs, entry)
    if (!existsSync(fullPath)) continue
    if (!isJson(entry)) continue
    const raw = readFileSync(fullPath, "utf8")
    const json = JSON.parse(raw)
    const minPath = fullPath.replace(/\.json$/, ".min.json")
    writeFileSync(minPath, JSON.stringify(json), "utf8")
  }
}
