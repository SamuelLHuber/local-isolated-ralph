import { describe, expect, it } from "bun:test"
import { createApp } from "../src/http/app"

describe("GET /_health", () => {
  it("returns 200 with { status: \"ok\" }", async () => {
    const app = createApp()
    const response = await app.fetch(new Request("http://localhost/_health"))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toMatch(/application\/json/i)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })
})
