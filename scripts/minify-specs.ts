import { readdir, readFile, writeFile, stat } from "node:fs/promises"
import { join } from "node:path"

const isJson = (name: string) => name.endsWith(".json") && !name.endsWith(".min.json")

const minifyFile = async (filePath: string) => {
  const raw = await readFile(filePath, "utf8")
  const json = JSON.parse(raw)
  const minPath = filePath.replace(/\.json$/, ".min.json")
  await writeFile(minPath, JSON.stringify(json), "utf8")
}

const minifyDir = async (dir: string) => {
  const entries = await readdir(dir)
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const info = await stat(fullPath)
    if (!info.isFile()) {
      continue
    }
    if (isJson(entry)) {
      await minifyFile(fullPath)
    }
  }
}

const target = process.argv[2] ?? "specs"

minifyDir(target)
  .then(() => {
    console.log(`Minified JSON in ${target}`)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
