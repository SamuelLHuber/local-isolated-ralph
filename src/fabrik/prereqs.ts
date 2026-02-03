import { execFileSync } from "node:child_process"

type PrereqHint = {
  title: string
  details: string[]
}

const commandExists = (cmd: string): boolean => {
  try {
    execFileSync("bash", ["-lc", `command -v ${cmd}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const formatHints = (hints: PrereqHint[]) =>
  hints
    .map((hint) => {
      const header = hint.title ? `Hint: ${hint.title}` : "Hint:"
      const lines = hint.details.map((line) => `  - ${line}`).join("\n")
      return `${header}\n${lines}`
    })
    .join("\n")

const failMissing = (cmd: string, hints: PrereqHint[]) => {
  const message = [
    `Required command not found in PATH: ${cmd}`,
    hints.length ? formatHints(hints) : ""
  ]
    .filter(Boolean)
    .join("\n")
  throw new Error(message)
}

export const requireCommand = (cmd: string, hints: PrereqHint[]) => {
  if (!commandExists(cmd)) {
    failMissing(cmd, hints)
  }
}

export const requireVcs = () => {
  const hasJj = commandExists("jj")
  const hasGit = commandExists("git")
  if (!hasJj && !hasGit) {
    failMissing("jj or git", [
      {
        title: "Install Jujutsu (preferred) or Git",
        details: [
          "macOS: brew install jj  (or brew install git)",
          "Linux: sudo apt install jujutsu  (or sudo apt install git)"
        ]
      }
    ])
  }
  return { hasJj, hasGit }
}

export const requireDocker = () => {
  requireCommand("docker", [
    {
      title: "Install Docker and ensure the daemon is running",
      details: [
        "macOS: Install Docker Desktop or Colima, then ensure docker is on PATH",
        "Linux: Install docker engine and ensure `docker info` works"
      ]
    }
  ])
}

export const requireVmHostTools = () => {
  if (process.platform === "darwin") {
    requireCommand("limactl", [
      {
        title: "Install Lima/Colima for VM management",
        details: ["macOS: brew install lima (or brew install colima)", "Verify: limactl list"]
      }
    ])
    return
  }
  if (process.platform === "linux") {
    requireCommand("virsh", [
      {
        title: "Install libvirt/virsh for VM management",
        details: [
          "Linux: sudo apt install libvirt-daemon-system libvirt-clients qemu-kvm",
          "Verify: virsh list --all"
        ]
      }
    ])
    return
  }
  throw new Error(`Unsupported OS: ${process.platform}`)
}

export { commandExists }
