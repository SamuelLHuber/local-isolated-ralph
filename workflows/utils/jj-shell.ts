/**
 * Deterministic JJ shell operations for workflow-owned progress tracking.
 *
 * These commands have fixed semantics and should not be delegated to the
 * coding agent. Keeping them here makes workspace creation, snapshotting, and
 * bookmark pushes reproducible across runs.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type ReportOutput = {
  ticketId: string;
  status: "done" | "partial" | "blocked";
  summary: string;
};

type JjResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function jj(args: string[], cwd: string): Promise<JjResult> {
  const result = await $`jj ${args}`.cwd(cwd).nothrow().quiet();
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

export async function prepareWorkspaces(
  repoRoot: string,
  workspacesDir: string,
  ticketIds: readonly string[],
): Promise<ReportOutput> {
  await $`mkdir -p ${workspacesDir}`.quiet();

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const ticketId of ticketIds) {
    const wsPath = resolve(workspacesDir, ticketId);

    if (existsSync(wsPath)) {
      const check = await jj(["status"], wsPath);
      if (check.ok) {
        skipped.push(ticketId);
        continue;
      }
    }

    const result = await jj(
      ["workspace", "add", wsPath, "--name", ticketId],
      repoRoot,
    );
    if (result.ok) {
      created.push(ticketId);
      continue;
    }

    const fallback = await jj(
      ["workspace", "add", ticketId, wsPath],
      repoRoot,
    );
    if (fallback.ok) {
      created.push(ticketId);
      continue;
    }

    errors.push(`${ticketId}: ${result.stderr || fallback.stderr}`);
  }

  const parts: string[] = [];
  if (created.length > 0) parts.push(`Created: ${created.join(", ")}`);
  if (skipped.length > 0) parts.push(`Existing: ${skipped.join(", ")}`);
  if (errors.length > 0) parts.push(`Errors: ${errors.join("; ")}`);

  return {
    ticketId: "prepare-workspaces",
    status: errors.length > 0 ? "partial" : "done",
    summary: parts.join(". ") || "No workspaces to prepare.",
  };
}

export async function snapshotChange(
  workspacePath: string,
  ticketId: string,
  phase: string,
): Promise<ReportOutput> {
  const status = await jj(["status"], workspacePath);
  if (!status.ok) {
    return {
      ticketId,
      status: "blocked",
      summary: `jj status failed: ${status.stderr}`,
    };
  }

  const hasChanges = !status.stdout.includes("The working copy is clean");
  const message = `${ticketId}: ${phase}`;

  const describe = await jj(["describe", "-m", message], workspacePath);
  if (!describe.ok) {
    return {
      ticketId,
      status: "blocked",
      summary: `jj describe failed: ${describe.stderr}`,
    };
  }

  const newChange = await jj(["new"], workspacePath);
  if (!newChange.ok) {
    return {
      ticketId,
      status: "blocked",
      summary: `jj new failed: ${newChange.stderr}`,
    };
  }

  return {
    ticketId,
    status: "done",
    summary: hasChanges
      ? `Snapshotted: "${message}"`
      : `Described (no file changes): "${message}"`,
  };
}

export async function pushBookmark(
  workspacePath: string,
  bookmarkName: string,
  ticketId: string,
): Promise<ReportOutput> {
  const targetRev = "@-";
  const track = await jj(
    ["bookmark", "track", bookmarkName, "--remote", "origin"],
    workspacePath,
  );
  const trackSummary =
    track.ok || track.stderr === ""
      ? ""
      : ` Tracking remote bookmark reported: ${track.stderr}`;

  const targetCommit = await jj(
    ["log", "-r", targetRev, "--no-graph", "-T", "commit_id"],
    workspacePath,
  );
  if (!targetCommit.ok || !targetCommit.stdout) {
    return {
      ticketId,
      status: "blocked",
      summary: `Failed to resolve target revision for bookmark push: ${targetCommit.stderr}`,
    };
  }

  const move = await jj(
    ["bookmark", "set", bookmarkName, "-r", targetRev, "--allow-backwards"],
    workspacePath,
  );

  if (!move.ok) {
    const create = await jj(
      ["bookmark", "create", "-r", targetRev, bookmarkName],
      workspacePath,
    );
    if (!create.ok) {
      return {
        ticketId,
        status: "blocked",
        summary: `Failed to set bookmark '${bookmarkName}': ${create.stderr}`,
      };
    }
  }

  const push = await jj(
    ["git", "push", "--bookmark", bookmarkName],
    workspacePath,
  );
  if (!push.ok) {
    return {
      ticketId,
      status: "blocked",
      summary: `Bookmark set but push failed: ${push.stderr}${trackSummary}`,
    };
  }

  const remote = await $`git ls-remote origin refs/heads/${bookmarkName}`
    .cwd(workspacePath)
    .nothrow()
    .quiet();
  const remoteCommit = remote.stdout.toString().trim().split(/\s+/)[0] ?? "";
  if (remote.exitCode !== 0 || remoteCommit !== targetCommit.stdout) {
    return {
      ticketId,
      status: "blocked",
      summary:
        `Bookmark push returned success but remote ${bookmarkName} is ${remoteCommit || "missing"} instead of ${targetCommit.stdout}.` +
        trackSummary,
    };
  }

  return {
    ticketId,
    status: "done",
    summary: `Pushed bookmark '${bookmarkName}' to origin at ${targetCommit.stdout}.${trackSummary}`,
  };
}
