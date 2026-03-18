import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CODEX_AUTH_HOME,
  RotatingCodexAgent,
  resetCodexAuthStateForTests,
  withCodexAuthPoolEnv,
} from "./codex-auth";

describe("codex-auth", () => {
  const sourceDir = join(tmpdir(), `fabrik-codex-source-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(sourceDir, { recursive: true });
    process.env.CODEX_AUTH_SOURCE_DIR = sourceDir;
    rmSync(CODEX_AUTH_HOME, { recursive: true, force: true });
    resetCodexAuthStateForTests();
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(CODEX_AUTH_HOME, { recursive: true, force: true });
    delete process.env.CODEX_AUTH_SOURCE_DIR;
    resetCodexAuthStateForTests();
  });

  it("withCodexAuthPoolEnv injects CODEX_HOME", () => {
    expect(withCodexAuthPoolEnv({ FOO: "bar" })).toEqual({
      FOO: "bar",
      CODEX_HOME: CODEX_AUTH_HOME,
    });
  });

  it("prefers auth.json for the initial active credential", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');
    writeFileSync(join(sourceDir, "backup.auth.json"), '{"token":"backup"}');

    let attempts = 0;
    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        attempts += 1;
        throw new Error("unauthorized");
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).rejects.toThrow("unauthorized");
    expect(attempts).toBe(2);
    expect(readFileSync(join(CODEX_AUTH_HOME, "auth.json"), "utf8")).toContain('"backup"');
  });

  it("does not rotate for non-auth failures", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');
    writeFileSync(join(sourceDir, "backup.auth.json"), '{"token":"backup"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("connection refused");
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).rejects.toThrow("connection refused");
    expect(readFileSync(join(CODEX_AUTH_HOME, "auth.json"), "utf8")).toContain('"default"');
  });
});
