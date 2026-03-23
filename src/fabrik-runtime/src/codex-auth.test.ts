import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCodexAuthHome,
  withCodexAuthPoolEnv,
  RotatingCodexAgent,
  CodexAuthBlockedError,
} from "./codex-auth";

describe("codex-auth", () => {
  const testRoot = join(tmpdir(), `fabrik-codex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourceDir = join(testRoot, "source");
  const codexHome = join(testRoot, "codex-home");

  beforeEach(() => {
    mkdirSync(sourceDir, { recursive: true });
    process.env.CODEX_AUTH_SOURCE_DIR = sourceDir;
    process.env.CODEX_AUTH_HOME = codexHome;
    process.env.SMITHERS_HOME = testRoot;
    process.env.SMITHERS_RUN_ID = "run-test";
    process.env.KUBERNETES_NAMESPACE = "fabrik-runs";
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    delete process.env.CODEX_AUTH_SOURCE_DIR;
    delete process.env.CODEX_AUTH_HOME;
    delete process.env.SMITHERS_HOME;
    delete process.env.SMITHERS_RUN_ID;
    delete process.env.KUBERNETES_NAMESPACE;
  });

  it("withCodexAuthPoolEnv injects the writable tool-native CODEX_HOME", () => {
    expect(withCodexAuthPoolEnv({ FOO: "bar" })).toEqual({
      FOO: "bar",
      CODEX_HOME: getCodexAuthHome(),
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
    const err = await agent.generate({ prompt: "test" } as any).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(CodexAuthBlockedError);
    expect(attempts).toBe(2);
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toContain('"backup"');
  });

  it("falls back to the first sorted auth file when auth.json is absent", async () => {
    writeFileSync(join(sourceDir, "b.auth.json"), '{"token":"b"}');
    writeFileSync(join(sourceDir, "a.auth.json"), '{"token":"a"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        return { ok: true };
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).resolves.toEqual({ ok: true });
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toContain('"a"');
  });

  it("copies mounted credentials into the writable tool-native runtime location", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        return { ok: true };
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).resolves.toEqual({ ok: true });
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toContain('"default"');
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
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toContain('"default"');
  });

  it("returns immediately when the first credential succeeds", async () => {
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

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).resolves.toEqual({ ok: true });
    expect(attempts).toBe(1);
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toContain('"default"');
  });

  it("rotates through multiple failed credentials before succeeding", async () => {
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

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toContain('"third"');
  });

  it("throws a typed recoverable auth exhaustion error when the pool is exhausted", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("usage limit reached");
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    const err = await agent.generate({ prompt: "test" } as any).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(CodexAuthBlockedError);
    expect((err as CodexAuthBlockedError).code).toBe("CODEX_AUTH_BLOCKED");
    expect((err as CodexAuthBlockedError).reason).toBe("auth_pool_exhausted");
    expect((err as CodexAuthBlockedError).runId).toBe("run-test");
    expect((err as CodexAuthBlockedError).namespace).toBe("fabrik-runs");
    expect((err as CodexAuthBlockedError).details.total).toBe(1);
    expect((err as CodexAuthBlockedError).details.failed).toBe(1);
    expect((err as CodexAuthBlockedError).details.remaining).toBe(0);
    expect((err as CodexAuthBlockedError).details.activeAuthName).toBe("auth.json");
    expect((err as CodexAuthBlockedError).details.failedAuths).toEqual([
      { authName: "auth.json", kind: "usage_limit" },
    ]);
  });

  it("classifies refresh-token-reused exhaustion distinctly in blocked details", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("refresh_token_reused");
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    const err = await agent.generate({ prompt: "test" } as any).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(CodexAuthBlockedError);
    expect((err as CodexAuthBlockedError).details.failedAuths).toEqual([
      { authName: "auth.json", kind: "refresh_token_reused" },
    ]);
  });

  it("accumulates all failed credentials in blocked details after multi-step exhaustion", async () => {
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

    const agent = new RotatingCodexAgent(fakeAgent as any);
    const err = await agent.generate({ prompt: "test" } as any).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(CodexAuthBlockedError);
    expect((err as CodexAuthBlockedError).details.total).toBe(2);
    expect((err as CodexAuthBlockedError).details.failed).toBe(2);
    expect((err as CodexAuthBlockedError).details.remaining).toBe(0);
    expect((err as CodexAuthBlockedError).details.failedAuths).toEqual([
      { authName: "auth.json", kind: "usage_limit" },
      { authName: "backup.auth.json", kind: "refresh_token_reused" },
    ]);
  });

  it("writes a durable resumability marker when auth exhaustion occurs", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("usage limit reached");
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await agent.generate({ prompt: "test" } as any).catch(() => null);

    const blockerPath = join(testRoot, ".smithers", "blockers", "codex-auth.json");
    expect(existsSync(blockerPath)).toBe(true);

    const blocker = JSON.parse(readFileSync(blockerPath, "utf8"));
    expect(blocker.kind).toBe("auth_pool_exhausted");
    expect(blocker.resumable).toBe(true);
    expect(blocker.runId).toBe("run-test");
    expect(blocker.namespace).toBe("fabrik-runs");
    expect(blocker.details.remaining).toBe(0);
    expect(blocker.details.failedAuths).toEqual([
      { authName: "auth.json", kind: "usage_limit" },
    ]);
  });

  it("does not write a resumability marker for non-auth failures", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("connection refused");
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await agent.generate({ prompt: "test" } as any).catch(() => null);

    const blockerPath = join(testRoot, ".smithers", "blockers", "codex-auth.json");
    expect(existsSync(blockerPath)).toBe(false);
  });

  it("keeps resumability markers free of secret material", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"access_token":"super-secret-token"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        throw new Error("usage limit reached");
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await agent.generate({ prompt: "test" } as any).catch(() => null);

    const blockerPath = join(testRoot, ".smithers", "blockers", "codex-auth.json");
    const blockerText = readFileSync(blockerPath, "utf8");
    expect(blockerText).not.toContain("super-secret-token");
    expect(blockerText).not.toContain("access_token");
  });

  it("reuses a credential file after its contents change", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"old"}');

    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        const active = readFileSync(join(codexHome, "auth.json"), "utf8");
        if (!active.includes('"new"')) {
          throw new Error("usage limit reached");
        }
        return { ok: true };
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await expect(agent.generate({ prompt: "test" } as any)).rejects.toBeInstanceOf(
      CodexAuthBlockedError,
    );

    writeFileSync(join(sourceDir, "auth.json"), '{"token":"new"}');

    await expect(agent.generate({ prompt: "test" } as any)).resolves.toEqual({ ok: true });
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toContain('"new"');
  });

  it("keeps auth failure state isolated per rotating agent instance", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');
    writeFileSync(join(sourceDir, "backup.auth.json"), '{"token":"backup"}');

    let firstAttempts = 0;
    const firstAgent = new RotatingCodexAgent({
      id: "first",
      tools: [],
      async generate() {
        firstAttempts += 1;
        if (firstAttempts === 1) throw new Error("usage limit reached");
        return { ok: true, agent: "first" };
      },
    } as any);

    let secondAttempts = 0;
    const secondAgent = new RotatingCodexAgent({
      id: "second",
      tools: [],
      async generate() {
        secondAttempts += 1;
        return { ok: true, agent: "second" };
      },
    } as any);

    await expect(firstAgent.generate({ prompt: "test" } as any)).resolves.toEqual({
      ok: true,
      agent: "first",
    });
    await expect(secondAgent.generate({ prompt: "test" } as any)).resolves.toEqual({
      ok: true,
      agent: "second",
    });
    expect(firstAttempts).toBe(2);
    expect(secondAttempts).toBe(1);
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toContain('"default"');
  });

  it("does not emit spurious rotation telemetry on repeated generate calls", async () => {
    writeFileSync(join(sourceDir, "auth.json"), '{"token":"default"}');

    const originalError = console.error;
    const lines: string[] = [];
    console.error = (...args: any[]) => lines.push(args.join(" "));

    let calls = 0;
    const fakeAgent = {
      id: "fake",
      tools: [],
      async generate() {
        calls += 1;
        return { ok: true };
      },
    };

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await agent.generate({ prompt: "test" } as any);
    await agent.generate({ prompt: "test" } as any);
    await agent.generate({ prompt: "test" } as any);

    console.error = originalError;
    const rotationLines = lines.filter((l) => l.includes("codex auth rotation"));
    // Only one rotation log — the initial activation, not per-call.
    expect(rotationLines.length).toBe(1);
    expect(rotationLines[0]).toContain("initial");
    expect(calls).toBe(3);
  });

  it("emits stable diagnostic log lines for rotation and exhaustion that telemetry can mirror", async () => {
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

    const agent = new RotatingCodexAgent(fakeAgent as any);
    await agent.generate({ prompt: "test" } as any).catch(() => null);

    console.error = originalError;
    const output = lines.join("\n");
    expect(output).toContain("codex auth pool summary");
    expect(output).toContain("no codex auth left to rotate to");
  });
});
