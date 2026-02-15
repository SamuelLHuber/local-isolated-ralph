import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { runCommand, runCommandOutput } from "./exec.js"
import { ensureCommands } from "./prereqs.js"

export type VmInfo = {
  name: string
  status: string
  cpu: string
  memory: string
  disk: string
  ip?: string
}

const getLimaVms = (): VmInfo[] => {
  try {
    const output = runCommandOutput("limactl", ["list", "--format", "{{.Name}}|{{.Status}}|{{.CPUs}}|{{.Memory}}|{{.Disk}}"], { context: "list lima VMs" })
    return output.split("\n")
      .filter(line => line.trim())
      .map(line => {
        const [name, status, cpu, memory, disk] = line.split("|")
        return { name, status, cpu, cpu: cpu || "-", memory: memory || "-", disk: disk || "-" }
      })
  } catch {
    return []
  }
}

const getLibvirtVms = (): VmInfo[] => {
  try {
    const output = runCommandOutput("virsh", ["list", "--all"], { context: "list libvirt VMs" })
    const lines = output.split("\n").slice(2, -1).filter(line => line.trim())
    
    return lines.map(line => {
      const parts = line.trim().split(/\s+/)
      const name = parts[1]
      const status = parts[2]
      
      let ip = "-"
      if (status === "running") {
        try {
          const addrOutput = runCommandOutput("virsh", ["domifaddr", name], { context: "get VM IP" })
          const ipv4Line = addrOutput.split("\n").find(l => l.includes("ipv4"))
          if (ipv4Line) {
            ip = ipv4Line.split(/\s+/)[3]?.split("/")[0] || "pending..."
          }
        } catch {
          ip = "pending..."
        }
      }
      
      return { name, status, cpu: "-", memory: "-", disk: "-", ip }
    })
  } catch {
    return []
  }
}

export const listVms = (): VmInfo[] => {
  if (process.platform === "darwin") {
    ensureCommands([{ cmd: "limactl" }], "VM listing requires limactl")
    return getLimaVms()
  } else if (process.platform === "linux") {
    ensureCommands([{ cmd: "virsh" }], "VM listing requires virsh")
    return getLibvirtVms()
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

export const listRalphVms = (): VmInfo[] => {
  return listVms().filter(vm => vm.name.startsWith("ralph"))
}

export const printVmList = () => {
  const vms = listVms()
  const ralphVms = vms.filter(vm => vm.name.startsWith("ralph"))
  
  console.log("Ralph VM Fleet Status")
  console.log("=====================")
  console.log("")
  
  if (process.platform === "darwin") {
    console.log(`${"NAME".padEnd(20)} ${"STATUS".padEnd(12)} ${"CPU".padEnd(6)} ${"MEMORY".padEnd(8)} ${"DISK".padEnd(10)}`)
    console.log(`${"----".padEnd(20)} ${"------".padEnd(12)} ${"---".padEnd(6)} ${"------".padEnd(8)} ${"----".padEnd(10)}`)
    
    for (const vm of ralphVms) {
      console.log(`${vm.name.padEnd(20)} ${vm.status.padEnd(12)} ${vm.cpu.padEnd(6)} ${vm.memory.padEnd(8)} ${vm.disk.padEnd(10)}`)
    }
  } else {
    console.log(`${"NAME".padEnd(20)} ${"STATUS".padEnd(12)} ${"IP".padEnd(15)}`)
    console.log(`${"----".padEnd(20)} ${"------".padEnd(12)} ${"--".padEnd(15)}`)
    
    for (const vm of ralphVms) {
      console.log(`${vm.name.padEnd(20)} ${vm.status.padEnd(12)} ${(vm.ip || "-").padEnd(15)}`)
    }
  }
  
  console.log("")
  console.log(`${ralphVms.length} Ralph VM(s)`)
}

export type CleanupOptions = {
  vms?: string[]
  all?: boolean
  force?: boolean
}

export const cleanupVms = (options: CleanupOptions) => {
  let vmsToDelete: string[] = options.vms || []
  
  if (options.all) {
    vmsToDelete = listRalphVms().map(vm => vm.name)
  }
  
  if (vmsToDelete.length === 0) {
    console.log("No VMs to delete.")
    return
  }
  
  console.log("VMs to delete:")
  for (const vm of vmsToDelete) {
    console.log(`  - ${vm}`)
  }
  console.log("")
  
  if (!options.force) {
    // In a real CLI, we'd use readline or a prompt library
    // For now, we'll just warn and require force flag
    console.log("Use --force to confirm deletion")
    return
  }
  
  for (const vm of vmsToDelete) {
    console.log(`Deleting: ${vm}`)
    
    if (process.platform === "darwin") {
      try {
        runCommand("limactl", ["stop", vm], { context: `stop ${vm}` })
      } catch {
        // VM might not be running
      }
      try {
        runCommand("limactl", ["delete", vm, "--force"], { context: `delete ${vm}` })
      } catch {
        console.log(`  Failed to delete ${vm}`)
      }
    } else if (process.platform === "linux") {
      try {
        runCommand("virsh", ["destroy", vm], { context: `destroy ${vm}` })
      } catch {
        // VM might not be running
      }
      try {
        runCommand("virsh", ["undefine", vm, "--remove-all-storage"], { context: `undefine ${vm}` })
      } catch {
        console.log(`  Failed to delete ${vm}`)
      }
      
      // Clean up cloud-init files
      try {
        const home = homedir()
        const cloudInitDir = join(home, "vms", "ralph", `${vm}-cloud-init`)
        const cloudInitIso = join(home, "vms", "ralph", `${vm}-cloud-init.iso`)
        if (existsSync(cloudInitDir)) {
          runCommand("rm", ["-rf", cloudInitDir], { context: "cleanup cloud-init dir" })
        }
        if (existsSync(cloudInitIso)) {
          runCommand("rm", ["-f", cloudInitIso], { context: "cleanup cloud-init iso" })
        }
      } catch {
        // Best effort cleanup
      }
    }
    
    console.log(`  Deleted: ${vm}`)
  }
  
  console.log("")
  console.log(`Cleanup complete. ${vmsToDelete.length} VM(s) deleted.`)
}

const RALPH_ENV_TEMPLATE = `# Ralph shared environment (sourced by VM scripts)
# Add or update values as needed:
export CLAUDE_CODE_OAUTH_TOKEN=""
export ANTHROPIC_API_KEY=""
export GITHUB_TOKEN=""
export GIT_AUTHOR_NAME="Your Name"
export GIT_AUTHOR_EMAIL="you@example.com"
export GIT_COMMITTER_NAME="Your Name"
export GIT_COMMITTER_EMAIL="you@example.com"

# LLM Provider API Keys (at least one required)
export FIREWORKS_API_KEY=""
export API_KEY_MOONSHOT=""

# LAOS (Local Analytics and Observability Stack) - runs on host
# See: https://github.com/dtechvision/laos
#
# Required: Set LAOS_HOST based on your platform
# macOS (Lima): export LAOS_HOST="host.lima.internal"
# Linux (libvirt): export LAOS_HOST="192.168.122.1"
#
# Telemetry endpoints (auto-configure from LAOS_HOST):
# export OTEL_EXPORTER_OTLP_ENDPOINT="http://\${LAOS_HOST}:4317"
# export LOKI_URL="http://\${LAOS_HOST}:3100"
# export SENTRY_DSN="http://<key>@\${LAOS_HOST}:9000/1"
# export POSTHOG_HOST="http://\${LAOS_HOST}:8001"
# export POSTHOG_API_KEY="phc_xxx"
`

export const createRalphEnv = () => {
  const envDir = join(homedir(), ".config", "ralph")
  const envFile = join(envDir, "ralph.env")
  
  if (!existsSync(envDir)) {
    mkdirSync(envDir, { recursive: true })
    chmodSync(envDir, 0o700)
  }
  
  if (!existsSync(envFile)) {
    writeFileSync(envFile, RALPH_ENV_TEMPLATE, { mode: 0o600 })
    console.log(`Created ${envFile}`)
  } else {
    console.log(`Exists: ${envFile}`)
  }
  
  console.log("Edit the file to add secrets, then run:")
  console.log("  fabrik credentials sync --vm <vm-name>")
}
