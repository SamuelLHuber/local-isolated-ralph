import { readdirSync, readFileSync, existsSync } from "node:fs"
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
