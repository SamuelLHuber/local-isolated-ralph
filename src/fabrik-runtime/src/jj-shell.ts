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

const PUSH_RETRY_LIMIT = 3;
const STALE_REF_PATTERNS = [
  "unexpectedly moved on the remote",
  "reason: stale info",
];

async function jj(args: string[], cwd: string): Promise<JjResult> {
  const result = await $`jj ${args}`.cwd(cwd).nothrow().quiet();
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

function isStaleRefPushFailure(result: JjResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return STALE_REF_PATTERNS.some((pattern) => text.includes(pattern));
}

function summarizeJjResult(label: string, result: JjResult): string {
  const details = [result.stdout, result.stderr].filter(Boolean).join(" | ");
  return `${label} exit=${result.exitCode}${details ? ` ${details}` : ""}`;
}

async function hasConflicts(workspacePath: string): Promise<boolean> {
  const conflicts = await jj(["log", "-r", "conflicts()", "--no-graph", "-T", "commit_id"], workspacePath);
  if (!conflicts.ok) {
    return true;
  }
  return conflicts.stdout.trim().length > 0;
}

async function trackRemoteBookmark(
  workspacePath: string,
  bookmarkName: string,
): Promise<JjResult> {
  return jj(["bookmark", "track", `glob:${bookmarkName}`, "--remote", "origin"], workspacePath);
}

async function setBookmarkToTarget(
  workspacePath: string,
  bookmarkName: string,
  targetRev: string,
): Promise<JjResult> {
  const move = await jj(
    ["bookmark", "set", bookmarkName, "-r", targetRev, "--allow-backwards"],
    workspacePath,
  );
  if (move.ok) {
    return move;
  }

  return jj(["bookmark", "create", "-r", targetRev, bookmarkName], workspacePath);
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
  const track = await trackRemoteBookmark(workspacePath, bookmarkName);
  const trackSummary =
    track.ok || track.stderr === ""
      ? ""
      : ` Tracking remote bookmark reported: ${track.stderr}`;

  let lastAttemptSummary = "";

  for (let attempt = 1; attempt <= PUSH_RETRY_LIMIT; attempt += 1) {
    if (attempt > 1) {
      const fetch = await jj(["git", "fetch"], workspacePath);
      if (!fetch.ok) {
        return {
          ticketId,
          status: "blocked",
          summary:
            `Bookmark push retry ${attempt}/${PUSH_RETRY_LIMIT} failed during fetch: ${fetch.stderr || fetch.stdout}.` +
            trackSummary +
            (lastAttemptSummary ? ` Last push state: ${lastAttemptSummary}` : ""),
        };
      }

      const retryTrack = await trackRemoteBookmark(workspacePath, bookmarkName);
      if (!retryTrack.ok && retryTrack.stderr !== "") {
        lastAttemptSummary = `${lastAttemptSummary} ${summarizeJjResult("track", retryTrack)}`.trim();
      }

      const rebase = await jj(
        ["rebase", "-s", `roots(${bookmarkName}@origin..${targetRev})`, "-d", `${bookmarkName}@origin`],
        workspacePath,
      );
      if (!rebase.ok) {
        return {
          ticketId,
          status: "blocked",
          summary:
            `Bookmark push retry ${attempt}/${PUSH_RETRY_LIMIT} failed during rebase: ${rebase.stderr || rebase.stdout}.` +
            trackSummary +
            (lastAttemptSummary ? ` Last push state: ${lastAttemptSummary}` : ""),
        };
      }

      if (await hasConflicts(workspacePath)) {
        return {
          ticketId,
          status: "blocked",
          summary:
            `Bookmark push retry ${attempt}/${PUSH_RETRY_LIMIT} stopped after rebase conflict on '${bookmarkName}'.` +
            ` ${summarizeJjResult("rebase", rebase)}` +
            trackSummary,
        };
      }
    }

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

    const move = await setBookmarkToTarget(workspacePath, bookmarkName, targetRev);
    if (!move.ok) {
      return {
        ticketId,
        status: "blocked",
        summary: `Failed to set bookmark '${bookmarkName}': ${move.stderr}`,
      };
    }

    const push = await jj(
      ["git", "push", "--bookmark", bookmarkName],
      workspacePath,
    );
    if (!push.ok) {
      lastAttemptSummary = [
        `attempt ${attempt}/${PUSH_RETRY_LIMIT}`,
        summarizeJjResult("push", push),
      ].join(" ");

      if (isStaleRefPushFailure(push) && attempt < PUSH_RETRY_LIMIT) {
        continue;
      }

      const exhausted = isStaleRefPushFailure(push) && attempt === PUSH_RETRY_LIMIT;
      return {
        ticketId,
        status: "blocked",
        summary:
          `${exhausted ? `Bookmark push retries exhausted for '${bookmarkName}'.` : "Bookmark set but push failed:"} ${push.stderr || push.stdout}` +
          trackSummary +
          (lastAttemptSummary ? ` Last attempt: ${lastAttemptSummary}` : ""),
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

  return {
    ticketId,
    status: "blocked",
    summary: `Bookmark push retries exhausted for '${bookmarkName}'.${trackSummary}${lastAttemptSummary ? ` Last attempt: ${lastAttemptSummary}` : ""}`,
  };
}
