#!/usr/bin/env bun
/**
 * Fabrik Sequential Workflow (Default)
 * 
 * For small-to-medium specs with clear milestones.
 * Sequential task implementation with full review loop and human gate.
 * 
 * Flow:
 * 1. TaskRalph (per task): Implement → Validate → LightReview → ReviewFix (loop)
 * 2. FullReviewRalph (all tasks done): AllReviewers → ReviewFix → Re-validate (loop)  
 * 3. HumanGate (needsApproval): Approve or reject → feedback → TaskRalph if rejected
 */

import { Sequence, Parallel, Branch, Ralph } from "smithers-orchestrator";
import { Workflow, Task, smithers, tables, createSmithers, type TaskContext } from "./smithers";
import { PiAgent, CodexAgent, ClaudeCodeAgent } from "smithers-orchestrator";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execSync } from "node:child_process";

// VCS-aware branch setup - supports both jj (Jujutsu) and git
const targetBranch = process.env.SMITHERS_BRANCH || "master";
const cwd = process.env.SMITHERS_CWD || process.cwd();

function vcsBranchSetup() {
  // Detect VCS type by checking for .jj or .git directories
  const hasJj = existsSync(join(cwd, ".jj"));
  const hasGit = existsSync(join(cwd, ".git"));
  
  if (!hasJj && !hasGit) {
    console.log(`[workflow] No VCS detected (.jj or .git), skipping branch setup`);
    return;
  }
  
  try {
    if (hasJj) {
      // JJ (Jujutsu) workflow - colocated with git
      // In jj, we use bookmarks for git branch integration
      try {
        // Check if we're already on a change with the target bookmark
        const currentBookmark = execSync("jj bookmark list --current 2>/dev/null || true", { cwd, encoding: "utf8" }).trim();
        if (currentBookmark.includes(targetBranch)) {
          console.log(`[workflow] JJ: Already on bookmark ${targetBranch}`);
        } else {
          // Create/track bookmark if it doesn't exist
          console.log(`[workflow] JJ: Setting up bookmark ${targetBranch}...`);
          execSync(`jj bookmark create ${targetBranch} 2>/dev/null || true`, { cwd, stdio: "pipe" });
          execSync(`jj bookmark track ${targetBranch} --remote=origin 2>/dev/null || true`, { cwd, stdio: "pipe" });
          console.log(`[workflow] JJ: Bookmark ${targetBranch} ready`);
        }
      } catch (e) {
        console.warn(`[workflow] JJ bookmark setup failed: ${e}`);
      }
    } else if (hasGit) {
      // Pure Git workflow
      const currentBranch = execSync("git branch --show-current", { cwd, encoding: "utf8" }).trim();
      if (currentBranch !== targetBranch) {
        console.log(`[workflow] Git: Switching from ${currentBranch} to ${targetBranch}...`);
        try {
          execSync(`git checkout -b ${targetBranch} 2>/dev/null || git checkout ${targetBranch}`, { cwd, stdio: "pipe" });
          console.log(`[workflow] Git: Now on branch: ${targetBranch}`);
        } catch (e) {
          console.warn(`[workflow] Git branch checkout failed: ${e}`);
        }
      } else {
        console.log(`[workflow] Git: Already on branch: ${targetBranch}`);
      }
    }
  } catch (e) {
    console.warn(`[workflow] Branch setup failed: ${e}`);
  }
}

vcsBranchSetup();

// Config from environment
const specPath = resolve(process.env.SMITHERS_SPEC_PATH || "specs/spec.md");
const todoPath = resolve(process.env.SMITHERS_TODO_PATH || `${specPath}.todo.json`);
const isMarkdown = specPath.endsWith(".md") || specPath.endsWith(".mdx");
const reviewersDir = process.env.SMITHERS_REVIEWERS_DIR;

// Load pre-defined tickets from todo file if available
function loadPredefinedTickets(): Ticket[] | null {
  try {
    if (!existsSync(todoPath)) return null;
    const raw = readFileSync(todoPath, "utf8");
    const json = JSON.parse(raw);
    if (json.tickets && Array.isArray(json.tickets) && json.tickets.length > 0) {
      console.log(`[workflow] Using ${json.tickets.length} pre-defined tickets from ${todoPath}`);
      return json.tickets as Ticket[];
    }
    return null;
  } catch {
    return null;
  }
}

// Helper to limit output size for SQLite storage (max ~500KB per field to stay well under 1GB limit)
const MAX_OUTPUT_SIZE = 500000;
function limitOutputSize(obj: unknown): unknown {
  if (typeof obj === "string") {
    if (obj.length > MAX_OUTPUT_SIZE) {
      return obj.slice(0, MAX_OUTPUT_SIZE) + `\n[TRUNCATED: was ${obj.length} chars]`;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    // Limit array items and check total size
    const limited = obj.slice(0, 1000).map(limitOutputSize);
    const json = JSON.stringify(limited);
    if (json.length > MAX_OUTPUT_SIZE) {
      return limited.slice(0, Math.floor(limited.length / 2));
    }
    return limited;
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = limitOutputSize(value);
    }
    // Check final JSON size
    const json = JSON.stringify(result);
    if (json.length > MAX_OUTPUT_SIZE) {
      // Truncate the entire object if too large
      return { 
        _truncated: true, 
        _originalSize: json.length,
        _message: "Object was too large for storage"
      };
    }
    return result;
  }
  return obj;
}

const predefinedTickets = loadPredefinedTickets();

// Parse spec with size limits for SQLite safety
const MAX_SPEC_SIZE = 100000; // ~100KB max for spec content
function parseSpec(path: string) {
  const raw = readFileSync(path, "utf8");
  return {
    id: basename(path).replace(/\.mdx?$/, "").replace(/^spec[-_]/, ""),
    title: raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Untitled",
    goals: [],
    raw: raw.slice(0, MAX_SPEC_SIZE),
    _truncated: raw.length > MAX_SPEC_SIZE ? { was: raw.length, limit: MAX_SPEC_SIZE } : undefined,
  };
}

const spec = isMarkdown ? parseSpec(specPath) : JSON.parse(readFileSync(specPath, "utf8"));

// Agent factory - Pi with JSON mode
function makeAgent(tier: "cheap" | "standard" | "powerful") {
  const kind = (process.env.RALPH_AGENT || "pi").toLowerCase();
  const cwd = process.env.SMITHERS_CWD || process.cwd();
  const base = { cwd };
  
  if (kind === "claude") return new ClaudeCodeAgent({ ...base, model: "claude-opus-4", dangerouslySkipPermissions: true });
  if (kind === "codex") return new CodexAgent({ ...base, model: "gpt-5.2-codex", sandbox: "danger-full-access" });
  
  // Pi: Fireworks preferred, fallback to moonshot
  const fw = process.env.FIREWORKS_API_KEY;
  const ms = process.env.API_KEY_MOONSHOT;
  const provider = fw ? "fireworks" : ms ? "moonshot" : undefined;
  const model = fw ? "fireworks/kimi-k2p5" : ms ? "kimi-k2.5" : "claude-opus-4";
  
  return new PiAgent({ ...base, model, provider, mode: "json", noSession: true });
}

// Helpers
const getReviewers = (names?: string[]): string[] => {
  if (!reviewersDir || !existsSync(reviewersDir)) return [];
  const all = readdirSync(reviewersDir).filter(f => f.endsWith(".md"));
  if (!names) return all.map(f => join(reviewersDir, f));
  return names.map(n => join(reviewersDir, n.replace(/\.md$/, "") + ".md")).filter(existsSync);
};

const readPrompt = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

// VCS push helper - enforces push to remote after changes
function vcsPush(): { success: boolean; output: string } {
  const hasJj = existsSync(join(cwd, ".jj"));
  const hasGit = existsSync(join(cwd, ".git"));
  
  if (!hasJj && !hasGit) {
    return { success: true, output: "No VCS detected, skipping push" };
  }
  
  try {
    if (hasJj) {
      // JJ push - handles both colocated git and pure jj
      try {
        // First try pushing with bookmark
        execSync(`jj git push --bookmark ${targetBranch} 2>&1`, { cwd, encoding: "utf8", stdio: "pipe" });
        return { success: true, output: `jj git push --bookmark ${targetBranch} succeeded` };
      } catch (e) {
        // If bookmark push fails, try tracking then pushing
        try {
          execSync(`jj bookmark track ${targetBranch} --remote=origin 2>/dev/null || true`, { cwd, stdio: "pipe" });
          execSync(`jj git push --bookmark ${targetBranch} 2>&1`, { cwd, encoding: "utf8", stdio: "pipe" });
          return { success: true, output: `jj git push --bookmark ${targetBranch} succeeded after track` };
        } catch (e2) {
          // Fallback: push current change
          execSync(`jj git push --change @ 2>&1`, { cwd, encoding: "utf8", stdio: "pipe" });
          return { success: true, output: "jj git push --change @ succeeded" };
        }
      }
    } else if (hasGit) {
      // Pure git push
      execSync(`git push origin ${targetBranch} 2>&1`, { cwd, encoding: "utf8", stdio: "pipe" });
      return { success: true, output: `git push origin ${targetBranch} succeeded` };
    }
    return { success: false, output: "Unknown VCS state" };
  } catch (e: any) {
    const error = e?.stderr || e?.message || String(e);
    return { success: false, output: `Push failed: ${error}` };
  }
}

interface Ticket { id: string; title: string; description: string; tier: "T1" | "T2" | "T3" | "T4"; model: "cheap" | "standard" | "powerful"; }

// Discover tasks from spec
function Discover({ ctx }: { ctx: TaskContext }) {
  return (
    <Task id="discover" output={tables.discover} agent={makeAgent("powerful")}>
      {`DISCOVER TASKS from spec: ${spec.id}

Break into sequential implementation tasks (5-10 tasks).
Each task: coherent, testable, committable.

OUTPUT JSON:
{
  "v": 1,
  "tickets": [{ "id": "slug", "title": "...", "description": "...", "tier": "T1|T2|T3|T4", "acceptanceCriteria": [], "dependencies": null, "layersRequired": [], "reviewsRequired": [], "gates": ["lint","typecheck","test"], "model": "cheap|standard|powerful" }],
  "reasoning": "...",
  "batchComplete": true
}`}
    </Task>
  );
}

// Phase 1: Per-task Ralph loop
function TaskRalph({ ticket, ctx }: { ticket: Ticket; ctx: TaskContext }) {
  const light = getReviewers(["CODE-QUALITY.md", "MAINTAINABILITY.md"]);
  const impl = ctx.latest(tables.report, `${ticket.id}:impl`);
  const val = ctx.latest(tables.gate, `${ticket.id}:val`);
  const reviews = light.map((_, i) => ctx.latest(tables.report, `${ticket.id}:rv-${i}`));
  const hasReviews = reviews.length > 0;
  const issues = reviews.flatMap((r, i) => r?.status === "changes_requested" ? [{ rev: basename(light[i]), issues: r.issues }] : []);
  const approved = hasReviews && reviews.every(r => r?.status === "approved");

  return (
    <Ralph id={`${ticket.id}:loop`} until={approved} maxIterations={5} onMaxReached="return-last">
      <Sequence>
        <Task id={`${ticket.id}:impl`} output={tables.report} agent={makeAgent(ticket.model)} onFinished={(output) => {
          // VCS enforcement: push must succeed before task completes
          const pushResult = vcsPush();
          if (!pushResult.success) {
            throw new Error(`VCS push failed for ${ticket.id}: ${pushResult.output}`);
          }
          console.log(`[workflow] VCS push succeeded for ${ticket.id}: ${pushResult.output}`);
        }}>
          {`IMPLEMENT: ${ticket.title}\n${ticket.description}\n${issues.length ? `FEEDBACK:\n${JSON.stringify(issues)}` : ""}\n1. Read spec, study codebase\n2. Implement with tests\n3. Run gates\n4. Commit with reasoning\n5. PUSH TO VCS: jj git push --bookmark ${targetBranch} (or git push origin ${targetBranch})\n   - If push fails with "Refusing to create new remote bookmark", run: jj bookmark track ${targetBranch} --remote=origin\n   - Then retry: jj git push --bookmark ${targetBranch}\n   - If still failing: jj git push --change @\n   CRITICAL: Task is NOT complete until push succeeds.\nOUTPUT: { "v": 1, "taskId": "${ticket.id}", "status": "done", "work": [], "files": [], "tests": [], "issues": [], "next": [] }`}
        </Task>

        <Task id={`${ticket.id}:val`} output={tables.gate} agent={makeAgent("cheap")}>
          {`VALIDATE: run lint, typecheck, test\nOUTPUT: { "v": 1, "passed": bool }`}
        </Task>

        <Branch if={val?.passed !== false} then={
          <Parallel maxConcurrency={2}>
            {light.map((p, i) => (
              <Task key={i} id={`${ticket.id}:rv-${i}`} output={tables.report} agent={makeAgent("standard")} continueOnFail>
                {`${readPrompt(p)}\nReview: ${ticket.title}\nOUTPUT: { "v": 1, "status": "approved|changes_requested", "issues": [] }`}
              </Task>
            ))}
          </Parallel>
        } />
      </Sequence>
    </Ralph>
  );
}

// Phase 2: Full review Ralph loop
function FullReviewRalph({ ctx }: { ctx: TaskContext }) {
  const all = getReviewers();
  const names = all.map(basename);
  const reviews = names.map((_, i) => ctx.latest(tables.report, `fr-${i}`));
  const hasReviews = reviews.length > 0;
  const issues = reviews.flatMap((r, i) => r?.status === "changes_requested" ? [{ rev: names[i], issues: r.issues }] : []);
  const approved = hasReviews && reviews.every(r => r?.status === "approved");

  return (
    <Ralph id="full-review" until={approved} maxIterations={5} onMaxReached="return-last">
      <Sequence>
        <Parallel maxConcurrency={8}>
          {all.map((p, i) => (
            <Task key={i} id={`fr-${i}`} output={tables.report} agent={makeAgent("standard")} continueOnFail>
              {`${readPrompt(p)}\nReview entire implementation.\nOUTPUT: { "v": 1, "status": "approved|changes_requested", "issues": [] }`}
            </Task>
          ))}
        </Parallel>
        
        <Branch if={issues.length > 0} then={
          <Sequence>
            <Task id="full-fix" output={tables.report} agent={makeAgent("powerful")} onFinished={(output) => {
              // VCS enforcement: push must succeed before task completes
              const pushResult = vcsPush();
              if (!pushResult.success) {
                throw new Error(`VCS push failed for full-fix: ${pushResult.output}`);
              }
              console.log(`[workflow] VCS push succeeded for full-fix: ${pushResult.output}`);
            }}>
              {`FIX ALL:\n${JSON.stringify(issues)}\nAddress each issue, re-validate, commit with reasoning.\n\nCRITICAL: After committing, you MUST push to VCS:\n- jj git push --bookmark ${targetBranch} (preferred)\n- If that fails: jj bookmark track ${targetBranch} --remote=origin, then retry push\n- Fallback: jj git push --change @\n- For pure git: git push origin ${targetBranch}\n\nTask is NOT complete until push succeeds.`}
            </Task>
            <Task id="full-reval" output={tables.gate} agent={makeAgent("cheap")}>{`Re-validate`}</Task>
          </Sequence>
        } />
      </Sequence>
    </Ralph>
  );
}

// Phase 3: Human gate
function HumanGate({ ctx }: { ctx: TaskContext }) {
  return (
    <Task id="human-gate" output={tables.report} needsApproval label={`Approve: ${spec.id}`}>
      {`HUMAN REVIEW: ${spec.id}\n\nAll automated reviews passed.\nReview implementation and VCS history.\nApprove or reject with feedback.`}
    </Task>
  );
}

// Main
export default smithers((ctx) => {
  const discover = ctx.latest(tables.discover, "discover");
  // Use pre-defined tickets if available, otherwise fall back to discovered tickets
  const tickets: Ticket[] = predefinedTickets ?? discover?.tickets ?? [];
  const hasPredefinedTickets = predefinedTickets !== null;
  const allDone = tickets.length > 0 && tickets.every(t => ctx.latest(tables.report, `${t.id}:impl`)?.status === "done");
  const fullReview = ctx.latest(tables.report, "fr-0") !== undefined;
  const human = ctx.latest(tables.report, "human-gate");

  return (
    <Workflow name={spec.id}>
      <Sequence>
        {/* Skip discover if we have pre-defined tickets from todo file */}
        <Branch if={!tickets.length && !hasPredefinedTickets} then={<Discover ctx={ctx} />} />
        {tickets.map(t => <TaskRalph key={t.id} ticket={t} ctx={ctx} />)}
        <Branch if={allDone && !fullReview} then={<FullReviewRalph ctx={ctx} />} />
        <Branch if={allDone && fullReview} then={<HumanGate ctx={ctx} />} />
        <Branch if={human?.status === "approved"} then={<Task id="done" output={tables.report}>{{ v: 1, status: "done", work: ["Complete"] }}</Task>} />
      </Sequence>
    </Workflow>
  );
});
