import { afterEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pushBookmark } from "./jj-shell";

type ShellResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function run(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<ShellResult> {
  const result = await $`${args}`
    .cwd(cwd)
    .env({ ...process.env, ...env })
    .nothrow()
    .quiet();
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

async function git(args: string[], cwd: string): Promise<ShellResult> {
  return run(["git", ...args], cwd);
}

async function jj(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<ShellResult> {
  return run(["jj", ...args], cwd, env);
}

type TestRepos = {
  root: string;
  remote: string;
  wsA: string;
  wsB: string;
  identityEnv: Record<string, string>;
};

const cleanupRoots: string[] = [];

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

async function createRepoPair(): Promise<TestRepos> {
  const root = mkdtempSync(join(tmpdir(), "fabrik-jj-shell-"));
  cleanupRoots.push(root);

  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const wsA = join(root, "ws-a");
  const wsB = join(root, "ws-b");
  const identityEnv = {
    JJ_USER: "Test User",
    JJ_EMAIL: "test@example.com",
  };

  expect((await git(["init", "--bare", remote], root)).ok).toBe(true);
  expect((await git(["clone", remote, seed], root)).ok).toBe(true);
  expect((await git(["config", "user.name", "Test User"], seed)).ok).toBe(true);
  expect((await git(["config", "user.email", "test@example.com"], seed)).ok).toBe(true);

  writeFileSync(join(seed, "README.md"), "seed\n");
  expect((await git(["add", "README.md"], seed)).ok).toBe(true);
  expect((await git(["commit", "-m", "init"], seed)).ok).toBe(true);
  expect((await git(["push", "origin", "HEAD:main"], seed)).ok).toBe(true);

  expect((await jj(["git", "clone", remote, wsA], root, identityEnv)).ok).toBe(true);
  expect((await jj(["git", "clone", remote, wsB], root, identityEnv)).ok).toBe(true);

  return { root, remote, wsA, wsB, identityEnv };
}

async function commitFile(
  workspacePath: string,
  filePath: string,
  content: string,
  message: string,
): Promise<void> {
  writeFileSync(join(workspacePath, filePath), content);
  const describe = await jj(["describe", "-m", message], workspacePath);
  expect(describe.ok).toBe(true);
  const newChange = await jj(["new"], workspacePath);
  expect(newChange.ok).toBe(true);
}

async function remoteBranchCommit(remote: string, branch: string): Promise<string> {
  const lsRemote = await git(["ls-remote", remote, `refs/heads/${branch}`], remote);
  expect(lsRemote.ok).toBe(true);
  return lsRemote.stdout.split(/\s+/)[0] ?? "";
}

async function cloneBranch(remote: string, branch: string, dir: string): Promise<void> {
  const clone = await git(["clone", "--branch", branch, remote, dir], join(dir, ".."));
  expect(clone.ok).toBe(true);
}

describe("pushBookmark", () => {
  it("pushes a new remote bookmark", async () => {
    const { remote, wsA } = await createRepoPair();

    await commitFile(wsA, "a.txt", "from a\n", "add a");

    const report = await pushBookmark(wsA, "feat/new-bookmark", "T-1");

    expect(report.status).toBe("done");
    expect(report.summary).toContain("Pushed bookmark 'feat/new-bookmark'");

    const remoteCommit = await remoteBranchCommit(remote, "feat/new-bookmark");
    expect(remoteCommit.length).toBeGreaterThan(0);

    const verifyDir = join(wsA, "..", "verify-new-bookmark");
    await cloneBranch(remote, "feat/new-bookmark", verifyDir);
    expect(existsSync(join(verifyDir, "a.txt"))).toBe(true);
    expect(readFileSync(join(verifyDir, "a.txt"), "utf8")).toBe("from a\n");
  });

  it("rebases and retries when the remote bookmark moved", async () => {
    const { remote, wsA, wsB } = await createRepoPair();
    const bookmark = "feat/retry-race";

    await commitFile(wsA, "a.txt", "from a\n", "add a");
    await commitFile(wsB, "b.txt", "from b\n", "add b");

    const first = await pushBookmark(wsB, bookmark, "T-2B");
    expect(first.status).toBe("done");

    const report = await pushBookmark(wsA, bookmark, "T-2A");

    expect(report.status).toBe("done");

    const verifyDir = join(wsA, "..", "verify-retry-race");
    await cloneBranch(remote, bookmark, verifyDir);
    expect(existsSync(join(verifyDir, "a.txt"))).toBe(true);
    expect(existsSync(join(verifyDir, "b.txt"))).toBe(true);
    expect(readFileSync(join(verifyDir, "a.txt"), "utf8")).toBe("from a\n");
    expect(readFileSync(join(verifyDir, "b.txt"), "utf8")).toBe("from b\n");
  });

  it("fails clearly when retry rebase introduces conflicts", async () => {
    const { remote, wsA, wsB } = await createRepoPair();
    const bookmark = "feat/retry-conflict";

    writeFileSync(join(wsA, "note.txt"), "from a\n");
    expect((await jj(["describe", "-m", "conflict a"], wsA)).ok).toBe(true);
    expect((await jj(["new"], wsA)).ok).toBe(true);

    writeFileSync(join(wsB, "note.txt"), "from b\n");
    expect((await jj(["describe", "-m", "conflict b"], wsB)).ok).toBe(true);
    expect((await jj(["new"], wsB)).ok).toBe(true);

    const first = await pushBookmark(wsB, bookmark, "T-3B");
    expect(first.status).toBe("done");

    const report = await pushBookmark(wsA, bookmark, "T-3A");

    expect(report.status).toBe("blocked");
    expect(report.summary.toLowerCase()).toContain("rebase");
    expect(report.summary.toLowerCase()).toContain("conflict");

    const verifyDir = join(wsA, "..", "verify-retry-conflict");
    await cloneBranch(remote, bookmark, verifyDir);
    expect(readFileSync(join(verifyDir, "note.txt"), "utf8")).toBe("from b\n");
  });

  it("does not retry non-stale push failures", async () => {
    const { wsA } = await createRepoPair();

    await commitFile(wsA, "a.txt", "from a\n", "add a");

    const setUrl = await git(["remote", "set-url", "origin", "/definitely/missing/remote.git"], wsA);
    expect(setUrl.ok).toBe(true);

    const report = await pushBookmark(wsA, "feat/non-stale-error", "T-4");

    expect(report.status).toBe("blocked");
    expect(report.summary).toContain("push failed");
    expect(report.summary).not.toContain("retries exhausted");
  });
});
