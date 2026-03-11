/**
 * Deterministic JJ shell operations using Bun's $ shell.
 *
 * Why: Workspace preparation and bookmark pushing are deterministic operations
 * that should NOT be delegated to an LLM agent. They have fixed command
 * sequences with predictable outcomes. Using Bun Shell (`$`) ensures:
 * - Exact command execution (no agent interpretation drift)
 * - Proper error handling with exit codes
 * - Cross-platform safety via Bun's built-in escaping
 * - Reproducible results on every run
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types matching the workflow report schema
// ---------------------------------------------------------------------------
type ReportOutput = {
  ticketId: string;
  status: "done" | "partial" | "blocked";
  summary: string;
};

// ---------------------------------------------------------------------------
// Shell helper: run a jj command, return structured result
// ---------------------------------------------------------------------------
type JjResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function jj(args: string[], cwd: string): Promise<JjResult> {
  // Bun Shell treats each array element as a separate, safely-escaped argument
  const result = await $`jj ${args}`.cwd(cwd).nothrow().quiet();
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

// ---------------------------------------------------------------------------
// Prepare JJ workspaces for a list of ticket IDs
// ---------------------------------------------------------------------------
export async function prepareWorkspaces(
  repoRoot: string,
  workspacesDir: string,
  ticketIds: readonly string[],
): Promise<ReportOutput> {
  // Ensure the workspaces directory exists
  await $`mkdir -p ${workspacesDir}`.quiet();

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const ticketId of ticketIds) {
    const wsPath = resolve(workspacesDir, ticketId);

    if (existsSync(wsPath)) {
      // Workspace directory already exists — check if it's a valid jj workspace
      const check = await jj(["status"], wsPath);
      if (check.ok) {
        skipped.push(ticketId);
        continue;
      }
      // Directory exists but is not a valid workspace — try to re-add
    }

    // Create workspace using jj workspace add
    // Try the standard syntax first: jj workspace add <path> --name <name>
    const result = await jj(
      ["workspace", "add", wsPath, "--name", ticketId],
      repoRoot,
    );

    if (result.ok) {
      created.push(ticketId);
      continue;
    }

    // Fallback: try legacy syntax (name, path)
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

// ---------------------------------------------------------------------------
// Snapshot: describe the current change and open a new one for the next task
// ---------------------------------------------------------------------------
export async function snapshotChange(
  workspacePath: string,
  ticketId: string,
  phase: string,
): Promise<ReportOutput> {
  // Check if there are actual changes to snapshot
  const status = await jj(["status"], workspacePath);
  if (!status.ok) {
    return {
      ticketId,
      status: "blocked",
      summary: `jj status failed: ${status.stderr}`,
    };
  }

  // If working copy is clean, still describe for history but note it
  const hasChanges = !status.stdout.includes("The working copy is clean");

  // Describe the current change with a structured message
  const message = `${ticketId}: ${phase}`;
  const describe = await jj(["describe", "-m", message], workspacePath);
  if (!describe.ok) {
    return {
      ticketId,
      status: "blocked",
      summary: `jj describe failed: ${describe.stderr}`,
    };
  }

  // Open a new empty change so the next agent task writes into a fresh change
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

// ---------------------------------------------------------------------------
// Push a bookmark to origin for a specific ticket workspace
// ---------------------------------------------------------------------------
export async function pushBookmark(
  workspacePath: string,
  bookmarkName: string,
  ticketId: string,
): Promise<ReportOutput> {
  // Step 1: Try to move the bookmark to current change, or create it
  const move = await jj(
    ["bookmark", "move", "-r", "@", bookmarkName],
    workspacePath,
  );

  if (!move.ok) {
    // Bookmark may not exist yet — create it
    const create = await jj(
      ["bookmark", "create", "-r", "@", bookmarkName],
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

  // Step 2: Push the bookmark to origin
  const push = await jj(
    ["git", "push", "--bookmark", bookmarkName],
    workspacePath,
  );

  if (!push.ok) {
    return {
      ticketId,
      status: "blocked",
      summary: `Bookmark set but push failed: ${push.stderr}`,
    };
  }

  return {
    ticketId,
    status: "done",
    summary: `Pushed bookmark '${bookmarkName}' to origin.`,
  };
}
