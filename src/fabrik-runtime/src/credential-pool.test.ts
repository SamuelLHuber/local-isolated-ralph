import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyFailure,
  isRotatableFailure,
  readCredential,
  listCredentials,
  readAllCredentials,
  injectCredentialEnv,
  injectAllCredentialEnvs,
  CredentialFilePool,
  CREDENTIAL_MOUNT_PATH,
} from "./credential-pool";

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe("classifyFailure", () => {
  it("classifies refresh_token_reused", () => {
    expect(classifyFailure("refresh_token_reused")).toBe("refresh_token_reused");
    expect(classifyFailure("refresh token has already been used")).toBe("refresh_token_reused");
  });

  it("classifies auth_invalid", () => {
    expect(classifyFailure("Not logged in · Please run /login")).toBe("auth_invalid");
    expect(classifyFailure("unauthorized")).toBe("auth_invalid");
    expect(classifyFailure("invalid api key")).toBe("auth_invalid");
    expect(classifyFailure("authentication failed")).toBe("auth_invalid");
    expect(classifyFailure("expired token")).toBe("auth_invalid");
  });

  it("classifies usage_limit", () => {
    expect(classifyFailure("usage limit reached")).toBe("usage_limit");
    expect(classifyFailure("rate limit")).toBe("usage_limit");
    expect(classifyFailure("insufficient credits")).toBe("usage_limit");
    expect(classifyFailure("exceeded quota")).toBe("usage_limit");
  });

  it("returns unknown for non-auth errors", () => {
    expect(classifyFailure("connection refused")).toBe("unknown");
    expect(classifyFailure("timeout")).toBe("unknown");
    expect(classifyFailure("some random error")).toBe("unknown");
  });
});

describe("isRotatableFailure", () => {
  it("returns true for auth/credential failures", () => {
    expect(isRotatableFailure("Not logged in")).toBe(true);
    expect(isRotatableFailure("rate limit")).toBe(true);
    expect(isRotatableFailure("refresh_token_reused")).toBe(true);
  });

  it("returns false for non-credential errors", () => {
    expect(isRotatableFailure("connection refused")).toBe(false);
    expect(isRotatableFailure("file not found")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credential reading from mock mounted directory
// ---------------------------------------------------------------------------

describe("credential reading", () => {
  const testDir = join(tmpdir(), `fabrik-cred-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    process.env.FABRIK_CREDENTIAL_PATH = testDir;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.FABRIK_CREDENTIAL_PATH;
  });

  it("readCredential returns null for missing file", () => {
    expect(readCredential("NONEXISTENT_KEY")).toBe(null);
  });

  it("readCredential reads file contents", () => {
    writeFileSync(join(testDir, "ANTHROPIC_API_KEY"), "sk-ant-test-value");
    expect(readCredential("ANTHROPIC_API_KEY")).toBe("sk-ant-test-value");
  });

  it("readCredential trims whitespace", () => {
    writeFileSync(join(testDir, "KEY"), "  value-with-spaces  \n");
    expect(readCredential("KEY")).toBe("value-with-spaces");
  });

  it("listCredentials returns sorted file names", () => {
    writeFileSync(join(testDir, "OPENAI_API_KEY"), "sk-1");
    writeFileSync(join(testDir, "ANTHROPIC_API_KEY"), "sk-2");
    writeFileSync(join(testDir, "FIREWORKS_API_KEY"), "fw-1");
    const keys = listCredentials();
    expect(keys).toEqual(["ANTHROPIC_API_KEY", "FIREWORKS_API_KEY", "OPENAI_API_KEY"]);
  });

  it("listCredentials ignores dotfiles and timestamp markers", () => {
    writeFileSync(join(testDir, "REAL_KEY"), "value");
    writeFileSync(join(testDir, ".hidden"), "ignored");
    writeFileSync(join(testDir, "..timestamp_of_last_update"), "ignored");
    expect(listCredentials()).toEqual(["REAL_KEY"]);
  });

  it("readAllCredentials returns key-value map", () => {
    writeFileSync(join(testDir, "A"), "val-a");
    writeFileSync(join(testDir, "B"), "val-b");
    expect(readAllCredentials()).toEqual({ A: "val-a", B: "val-b" });
  });
});

describe("injectCredentialEnv", () => {
  const testDir = join(tmpdir(), `fabrik-inject-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    process.env.FABRIK_CREDENTIAL_PATH = testDir;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.FABRIK_CREDENTIAL_PATH;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MY_CUSTOM_VAR;
  });

  it("sets env var from credential file", () => {
    writeFileSync(join(testDir, "ANTHROPIC_API_KEY"), "sk-ant-injected");
    const ok = injectCredentialEnv("ANTHROPIC_API_KEY");
    expect(ok).toBe(true);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-injected");
  });

  it("returns false for missing credential", () => {
    const ok = injectCredentialEnv("NONEXISTENT");
    expect(ok).toBe(false);
  });

  it("uses custom env var name", () => {
    writeFileSync(join(testDir, "my-key-file"), "secret-value");
    injectCredentialEnv("my-key-file", "MY_CUSTOM_VAR");
    expect(process.env.MY_CUSTOM_VAR).toBe("secret-value");
  });

  it("injectAllCredentialEnvs sets all keys", () => {
    writeFileSync(join(testDir, "KEY_A"), "a");
    writeFileSync(join(testDir, "KEY_B"), "b");
    const injected = injectAllCredentialEnvs();
    expect(injected).toEqual(["KEY_A", "KEY_B"]);
    expect(process.env.KEY_A).toBe("a");
    expect(process.env.KEY_B).toBe("b");
    delete process.env.KEY_A;
    delete process.env.KEY_B;
  });
});

describe("notification event", () => {
  it("does not include secret values", async () => {
    // notifyFailure should emit structured events without secret content.
    // We verify the event shape, not the webhook (no webhook configured in tests).
    const events: any[] = [];
    const originalWarn = console.error;
    console.error = (...args: any[]) => events.push(args.join(" "));

    const { notifyFailure } = await import("./credential-pool");
    await notifyFailure({
      credentialName: "codex-auth.json",
      kind: "auth_invalid",
      message: "unauthorized",
      agent: "codex",
      namespace: "fabrik-runs",
      runId: "test-run",
    });

    console.error = originalWarn;
    const logged = events.join("\n");
    // Must include the credential name and kind for operator diagnosis
    expect(logged).toContain("codex-auth.json");
    expect(logged).toContain("auth_invalid");
    // Must NOT include any actual secret values
    expect(logged).not.toContain("sk-");
    expect(logged).not.toContain("token");
  });
});

// ---------------------------------------------------------------------------
// CredentialFilePool
// ---------------------------------------------------------------------------

describe("CredentialFilePool", () => {
  const testDir = join(tmpdir(), `fabrik-pool-test-${Date.now()}`);
  const activeDir = join(testDir, "active");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    // Override the mount path for pool scanning
    process.env.FABRIK_CREDENTIAL_PATH = testDir;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.FABRIK_CREDENTIAL_PATH;
  });

  it("init with no pool files is safe", () => {
    const pool = new CredentialFilePool({
      prefix: "codex-auth",
      extension: ".json",
      activeDir,
      activeFilename: "auth.json",
      agent: "codex",
    });
    pool.init();
    expect(pool.available).toBe(0);
    expect(pool.activeName).toBe("");
  });

  it("init activates first pool file", () => {
    writeFileSync(join(testDir, "codex-auth.json"), '{"token":"a"}');
    writeFileSync(join(testDir, "codex-auth-2.json"), '{"token":"b"}');

    const pool = new CredentialFilePool({
      prefix: "codex-auth",
      extension: ".json",
      activeDir,
      activeFilename: "auth.json",
      agent: "codex",
    });
    pool.init();
    expect(pool.available).toBe(2);
    expect(pool.activeName).toBe("codex-auth-2.json");
    // Active file should be written
    expect(existsSync(join(activeDir, "auth.json"))).toBe(true);
  });

  it("rotate cycles to next credential", () => {
    writeFileSync(join(testDir, "codex-auth.json"), '{"token":"a"}');
    writeFileSync(join(testDir, "codex-auth-2.json"), '{"token":"b"}');

    const pool = new CredentialFilePool({
      prefix: "codex-auth",
      extension: ".json",
      activeDir,
      activeFilename: "auth.json",
      agent: "codex",
    });
    pool.init();
    const first = pool.activeName;

    const rotated = pool.rotate("test");
    expect(rotated).toBe(true);
    expect(pool.activeName).not.toBe(first);
  });

  it("rotate returns false when pool exhausted", () => {
    writeFileSync(join(testDir, "codex-auth.json"), '{"token":"a"}');

    const pool = new CredentialFilePool({
      prefix: "codex-auth",
      extension: ".json",
      activeDir,
      activeFilename: "auth.json",
      agent: "codex",
    });
    pool.init();

    // Only one credential, can't rotate
    const rotated = pool.rotate("test");
    expect(rotated).toBe(false);
  });

  it("markFailed reduces available count", async () => {
    writeFileSync(join(testDir, "codex-auth.json"), '{"token":"a"}');
    writeFileSync(join(testDir, "codex-auth-2.json"), '{"token":"b"}');

    const pool = new CredentialFilePool({
      prefix: "codex-auth",
      extension: ".json",
      activeDir,
      activeFilename: "auth.json",
      agent: "codex",
    });
    pool.init();
    expect(pool.available).toBe(2);

    await pool.markFailed("unauthorized");
    expect(pool.available).toBe(1);
  });

  it("handleError returns false for non-rotatable errors", async () => {
    writeFileSync(join(testDir, "codex-auth.json"), '{"token":"a"}');

    const pool = new CredentialFilePool({
      prefix: "codex-auth",
      extension: ".json",
      activeDir,
      activeFilename: "auth.json",
      agent: "codex",
    });
    pool.init();

    const handled = await pool.handleError(new Error("connection refused"));
    expect(handled).toBe(false);
  });

  it("handleError rotates for auth errors", async () => {
    writeFileSync(join(testDir, "codex-auth.json"), '{"token":"a"}');
    writeFileSync(join(testDir, "codex-auth-2.json"), '{"token":"b"}');

    const pool = new CredentialFilePool({
      prefix: "codex-auth",
      extension: ".json",
      activeDir,
      activeFilename: "auth.json",
      agent: "codex",
    });
    pool.init();
    const first = pool.activeName;

    const handled = await pool.handleError(new Error("unauthorized"));
    expect(handled).toBe(true);
    expect(pool.activeName).not.toBe(first);
  });
});
