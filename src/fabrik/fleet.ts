import { existsSync, readdirSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { dispatchRun } from "./dispatch.js"
import { runCommandOutput } from "./exec.js"
import { ensureCommands } from "./prereqs.js"

type FleetOptions = {
  specsDir: string
  vmPrefix: string
}

const listSpecs = (specsDir: string) => {
  if (!existsSync(specsDir)) return []
  const entries = readdirSync(specsDir)
  const specFiles = entries
    .filter((entry) => entry.endsWith(".min.json") && !entry.endsWith(".todo.min.json"))
    .map((entry) => resolve(specsDir, entry))
  return specFiles.filter((specPath) => {
    const todoPath = specPath.replace(/\.min\.json$/i, ".todo.min.json")
    if (!existsSync(todoPath)) {
      console.log(`Warning: skipping ${basename(specPath)} (no matching .todo.min.json)`)
      return false
    }
    return true
  })
}

const listVms = (prefix: string) => {
  if (process.platform === "darwin") {
    ensureCommands([{ cmd: "limactl" }], "fleet requires limactl")
    const output = runCommandOutput("limactl", ["list", "--format", "{{.Name}}"], { context: "list VMs" })
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.startsWith(prefix))
  }
  if (process.platform === "linux") {
    ensureCommands([{ cmd: "virsh" }], "fleet requires virsh")
    const output = runCommandOutput("virsh", ["list", "--all", "--name"], { context: "list VMs" })
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name && name.startsWith(prefix))
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

export const dispatchFleet = ({ specsDir, vmPrefix }: FleetOptions) => {
  const specs = listSpecs(resolve(specsDir))
  if (specs.length === 0) {
    throw new Error(`No spec/todo pairs found in ${specsDir}`)
  }
  const cwd = process.cwd()
  const project = existsSync(join(cwd, ".git")) || existsSync(join(cwd, ".jj")) ? cwd : undefined
  if (!project) {
    throw new Error("Fleet dispatch requires running inside a repo (no .git/.jj found).")
  }
  const vms = listVms(vmPrefix)
  if (vms.length === 0) {
    throw new Error(`No VMs found with prefix '${vmPrefix}'.`)
  }

  console.log(`Found ${specs.length} specs and ${vms.length} VMs.`)
  for (let index = 0; index < specs.length; index++) {
    if (index >= vms.length) {
      console.log(`Warning: More specs than VMs. Skipping: ${basename(specs[index])}`)
      continue
    }
    const vm = vms[index]
    const spec = specs[index]
    console.log(`Dispatching ${basename(spec)} -> ${vm}`)
    dispatchRun({
      vm,
      spec,
      todo: spec.replace(/\.min\.json$/i, ".todo.min.json"),
      project,
      includeGit: false,
      follow: false
    })
  }
}
