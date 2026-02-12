import { runCommandOutput } from "./exec.js"

export const getVmIp = (vm: string) => {
  const output = runCommandOutput("virsh", ["domifaddr", vm], { context: "find VM IP" })
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.includes("ipv4"))
  return line?.split(/\s+/)[3]?.split("/")[0]
}
