#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

type Manifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const repoRoot = process.cwd()
const packageJsonPath = resolve(repoRoot, "package.json")
const nixModulePath = resolve(repoRoot, "nix/modules/ralph.nix")
const allowNewDeps = process.env.ALLOW_NEW_DEPENDENCIES === "1"
const baseRef = process.env.DEPENDENCY_BASE_REF ?? "origin/master"

const fail = (message: string): never => {
  console.error(`[deps-policy] ${message}`)
  process.exit(1)
}

const readManifest = (source: string): Manifest => JSON.parse(source) as Manifest

const readCurrentManifest = (): Manifest => {
  if (!existsSync(packageJsonPath)) {
    fail(`Missing ${packageJsonPath}`)
  }
  return readManifest(readFileSync(packageJsonPath, "utf8"))
}

const readBaseManifest = (): Manifest | null => {
  try {
    const raw = execFileSync("git", ["show", `${baseRef}:package.json`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
    return readManifest(raw)
  } catch {
    console.warn(`[deps-policy] Could not read ${baseRef}:package.json; skipping new dependency diff check.`)
    return null
  }
}

const mergedDeps = (manifest: Manifest) => ({
  ...(manifest.dependencies ?? {}),
  ...(manifest.devDependencies ?? {})
})

const isDisallowedRange = (version: string): boolean => {
  if (version === "latest") return true
  if (version === "*") return true
  if (version.startsWith("^") || version.startsWith("~")) return true
  if (version.includes("latest")) return true
  return false
}

const currentManifest = readCurrentManifest()
const directDeps = mergedDeps(currentManifest)
const disallowed = Object.entries(directDeps).filter(([, version]) => isDisallowedRange(version))
if (disallowed.length > 0) {
  const list = disallowed.map(([name, version]) => `${name}@${version}`).join(", ")
  fail(`Disallowed dependency version ranges found: ${list}. Use pinned explicit versions.`)
}

const baseManifest = readBaseManifest()
if (baseManifest && !allowNewDeps) {
  const previous = mergedDeps(baseManifest)
  const added = Object.keys(directDeps).filter((name) => !(name in previous))
  if (added.length > 0) {
    fail(
      `New direct dependencies detected: ${added.join(", ")}. ` +
      "Policy blocks adding direct deps by default. Re-run with ALLOW_NEW_DEPENDENCIES=1 if explicitly approved."
    )
  }
}

if (!existsSync(nixModulePath)) {
  fail(`Missing ${nixModulePath}`)
}
const nixSource = readFileSync(nixModulePath, "utf8")
const latestMatches = nixSource.match(/"[A-Za-z0-9@/.-]+@latest"/g) ?? []
if (latestMatches.length > 0) {
  fail(
    `Disallowed @latest usage in nix/modules/ralph.nix: ${latestMatches.join(", ")}. ` +
    "Pin global agent/mcp package versions."
  )
}

console.log("[deps-policy] OK")
