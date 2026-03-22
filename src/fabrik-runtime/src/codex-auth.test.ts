import { beforeEach, afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const loadCodexAuthModule = () => import(`./codex-auth?test=${Date.now()}-${Math.random()}`);

describe("codex-auth", () => {
  const testRoot = join(tmpdir(), `fabrik-codex-${Date.now()}`);
  const sourceDir = join(testRoot, "source");

  beforeEach(() => {
    mkdirSync(sourceDir, { recursive: true });
    process.env.CODEX_AUTH_SOURCE_DIR = sourceDir;
    process.env.SMITHERS_HOME = testRoot;
    process.env.SMITHERS_RUN_ID = "run-test";
    process.env.KUBERNETES_NAMESPACE = "fabrik-runs";
  });

  afterEach(async () => {
    const mod = await loadCodexAuthModule();
    rmSync(testRoot, { recursive: true, force: true });
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    delete process.env.CODEX_AUTH_SOURCE_DIR;
    delete process.env.SMITHERS_HOME;
    delete process.env.SMITHERS_RUN_ID;
    delete process.env.KUBERNETES_NAMESPACE;
    mock.restore();
    mod.resetCodexAuthStateForTests();
  });

  it("withCodexAuthPoolEnv injects the writable tool-native CODEX_HOME", async () => {
    const mod = await loadCodexAuthModule();
    expect(mod.withCodexAuthPoolEnv({ FOO: "bar" })).toEqual({
      FOO: "bar",
      CODEX_HOME: mod.CODEX_AUTH_HOME,
    });
  });

  it("prefers auth.json for the initial active credential", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
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

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    const err = await agent.generate({ prompt: "test" } as any).catch((error) => error);
    expect(err).toBeInstanceOf(mod.CodexAuthBlockedError);
    expect(attempts).toBe(2);
    expect(readFileSync(join(mod.CODEX_AUTH_HOME, "auth.json"), "utf8")).toContain('"backup"');
  });

  it("falls back to the first sorted auth file when auth.json is absent", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "b.auth.json"), '{"token":"b"}');
    writeFileSync(join(sourceDir, "a.auth.json"), '{"token":"a"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        return { ok: true };
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).resolves.toEqual({ ok: true });
    expect(readFileSync(join(mod.CODEX_AUTH_HOME, "auth.json"), "utf8")).toContain('"a"');
  });

  it("copies mounted credentials into the writable tool-native runtime location", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        return { ok: true };
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).resolves.toEqual({ ok: true });
    expect(readFileSync(join(mod.CODEX_AUTH_HOME, "auth.json"), "utf8")).toContain('"default"');
  });

  it("does not rotate for non-auth failures", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');
    writeFileSync(join(sourceDir, "backup.auth.json"), '{"token":"backup"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("connection refused");
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).rejects.toThrow("connection refused");
    expect(readFileSync(join(mod.CODEX_AUTH_HOME, "auth.json"), "utf8")).toContain('"default"');
  });

  it("returns immediately when the first credential succeeds", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');
    writeFileSync(join(sourceDir, "backup.auth.json"), '{"token":"backup"}');

    let attempts = 0;
    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        attempts += 1;
        return { ok: true };
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).resolves.toEqual({ ok: true });
    expect(attempts).toBe(1);
    expect(readFileSync(join(mod.CODEX_AUTH_HOME, "auth.json"), "utf8")).toContain('"default"');
  });

  it("rotates through multiple failed credentials before succeeding", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');
    writeFileSync(join(sourceDir, "backup.auth.json"), '{"token":"backup"}');
    writeFileSync(join(sourceDir, "third.auth.json"), '{"token":"third"}');

    let attempts = 0;
    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        attempts += 1;
        if (attempts < 3) throw new Error("usage limit reached");
        return { ok: true };
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(readFileSync(join(mod.CODEX_AUTH_HOME, "auth.json"), "utf8")).toContain('"third"');
  });

  it("throws a typed recoverable auth exhaustion error when the pool is exhausted", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("usage limit reached");
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    const err = await agent.generate({ prompt: "test" } as any).catch((error) => error);

    expect(err).toBeInstanceOf(mod.CodexAuthBlockedError);
    expect(err.code).toBe("CODEX_AUTH_BLOCKED");
    expect(err.reason).toBe("auth_pool_exhausted");
    expect(err.runId).toBe("run-test");
    expect(err.namespace).toBe("fabrik-runs");
    expect(err.details.total).toBe(1);
    expect(err.details.failed).toBe(1);
    expect(err.details.remaining).toBe(0);
    expect(err.details.activeAuthName).toBe("auth.json");
    expect(err.details.failedAuths).toEqual([
      { authName: "auth.json", kind: "usage_limit" },
    ]);
  });

  it("classifies refresh-token-reused exhaustion distinctly in blocked details", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("refresh_token_reused");
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    const err = await agent.generate({ prompt: "test" } as any).catch((error) => error);

    expect(err).toBeInstanceOf(mod.CodexAuthBlockedError);
    expect(err.details.failedAuths).toEqual([
      { authName: "auth.json", kind: "refresh_token_reused" },
    ]);
  });

  it("accumulates all failed credentials in blocked details after multi-step exhaustion", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');
    writeFileSync(join(sourceDir, "backup.auth.json"), '{"token":"backup"}');

    let attempts = 0;
    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        attempts += 1;
        if (attempts === 1) throw new Error("usage limit reached");
        throw new Error("refresh_token_reused");
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    const err = await agent.generate({ prompt: "test" } as any).catch((error) => error);

    expect(err).toBeInstanceOf(mod.CodexAuthBlockedError);
    expect(err.details.total).toBe(2);
    expect(err.details.failed).toBe(2);
    expect(err.details.remaining).toBe(0);
    expect(err.details.failedAuths).toEqual([
      { authName: "auth.json", kind: "usage_limit" },
      { authName: "backup.auth.json", kind: "refresh_token_reused" },
    ]);
  });

  it("writes a durable resumability marker when auth exhaustion occurs", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("usage limit reached");
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    await agent.generate({ prompt: "test" } as any).catch(() => null);

    const blockerPath = join(testRoot, ".smithers", "blockers", "codex-auth.json");
    expect(existsSync(blockerPath)).toBe(true);

    const blocker = JSON.parse(readFileSync(blockerPath, "utf8"));
    expect(blocker.kind).toBe("auth_pool_exhausted");
    expect(blocker.resumeable).toBe(true);
    expect(blocker.runId).toBe("run-test");
    expect(blocker.namespace).toBe("fabrik-runs");
    expect(blocker.details.remaining).toBe(0);
    expect(blocker.details.failedAuths).toEqual([
      { authName: "auth.json", kind: "usage_limit" },
    ]);
  });

  it("does not write a resumability marker for non-auth failures", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("connection refused");
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    await agent.generate({ prompt: "test" } as any).catch(() => null);

    const blockerPath = join(testRoot, ".smithers", "blockers", "codex-auth.json");
    expect(existsSync(blockerPath)).toBe(false);
  });

  it("keeps resumability markers free of secret material", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"access_token":"super-secret-token"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("usage limit reached");
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    await agent.generate({ prompt: "test" } as any).catch(() => null);

    const blockerPath = join(testRoot, ".smithers", "blockers", "codex-auth.json");
    const blockerText = readFileSync(blockerPath, "utf8");
    expect(blockerText).not.toContain("super-secret-token");
    expect(blockerText).not.toContain("access_token");
  });

  it("emits stable diagnostic log lines for rotation and exhaustion that telemetry can mirror", async () => {
    const mod = await loadCodexAuthModule();
    rmSync(mod.CODEX_AUTH_HOME, { recursive: true, force: true });
    mod.resetCodexAuthStateForTests();
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const originalError = console.error;
    const lines: string[] = [];
    console.error = (...args: any[]) => lines.push(args.join(" "));

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("usage limit reached");
      },
    };

    const agent = new mod.RotatingCodexAgent(fakeAgent as any);
    await agent.generate({ prompt: "test" } as any).catch(() => null);

    console.error = originalError;
    const output = lines.join("\n");
    expect(output).toContain("codex auth pool summary");
    expect(output).toContain("no codex auth left to rotate to");
  });
});
