import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { embeddedAssets } from "./embeddedAssets.js"

const computeHash = () => {
  const hash = createHash("sha256")
  for (const asset of embeddedAssets) {
    hash.update(asset.path)
    hash.update("\0")
    hash.update(asset.contents)
    hash.update("\0")
    if (asset.mode) hash.update(String(asset.mode))
    hash.update("\0")
  }
  return hash.digest("hex").slice(0, 12)
}

export const ensureEmbeddedHome = (): string => {
  const root = join(homedir(), ".cache", "fabrik", "embedded", computeHash())
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true })
  }

  for (const asset of embeddedAssets) {
    const target = join(root, asset.path)
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, asset.contents, "utf8")
      if (asset.mode) chmodSync(target, asset.mode)
    }
  }

  return root
}

export const resolveRalphHome = (candidate: string): string => {
  const sentinel = join(candidate, "smithers-runner", "workflow.tsx")
  if (existsSync(sentinel)) return candidate
  return ensureEmbeddedHome()
}
