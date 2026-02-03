import { describe, expect, it } from "bun:test"
import { createServer } from "../src/server"

describe("GET /_health", () => {
  it("returns status ok", async () => {
    const app = createServer()
    const response = await app.fetch(new Request("http://localhost/_health"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })

  it("rejects unsupported methods", async () => {
    const app = createServer()
    const response = await app.fetch(
      new Request("http://localhost/_health", { method: "POST" })
    )

    expect(response.status).toBe(405)
  })
})
