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

// Config from environment
const specPath = resolve(process.env.SMITHERS_SPEC_PATH || "specs/spec.md");
const isMarkdown = specPath.endsWith(".md") || specPath.endsWith(".mdx");
const reviewersDir = process.env.SMITHERS_REVIEWERS_DIR;

// Parse spec
function parseSpec(path: string) {
  const raw = readFileSync(path, "utf8");
  return {
    id: basename(path).replace(/\.mdx?$/, "").replace(/^spec[-_]/, ""),
    title: raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Untitled",
    goals: [],
    raw: raw.slice(0, 3000),
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
  const issues = reviews.flatMap((r, i) => r?.status === "changes_requested" ? [{ rev: basename(light[i]), issues: r.issues }] : []);
  const approved = reviews.every(r => r?.status === "approved");

  return (
    <Ralph id={`${ticket.id}:loop`} until={approved} maxIterations={5} onMaxReached="return-last">
      <Sequence>
        <Task id={`${ticket.id}:impl`} output={tables.report} agent={makeAgent(ticket.model)}>
          {`IMPLEMENT: ${ticket.title}\n${ticket.description}\n${issues.length ? `FEEDBACK:\n${JSON.stringify(issues)}` : ""}\n1. Read spec, study codebase\n2. Implement with tests\n3. Run gates\n4. Commit with reasoning\nOUTPUT: { "v": 1, "taskId": "${ticket.id}", "status": "done", "work": [], "files": [], "tests": [], "issues": [], "next": [] }`}
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
  const issues = reviews.flatMap((r, i) => r?.status === "changes_requested" ? [{ rev: names[i], issues: r.issues }] : []);
  const approved = reviews.every(r => r?.status === "approved");

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
            <Task id="full-fix" output={tables.report} agent={makeAgent("powerful")}>
              {`FIX ALL:\n${JSON.stringify(issues)}\nAddress each, re-validate, commit.`}
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
  const tickets: Ticket[] = discover?.tickets || [];
  const allDone = tickets.length > 0 && tickets.every(t => ctx.latest(tables.report, `${t.id}:impl`)?.status === "done");
  const fullReview = ctx.latest(tables.report, "fr-0") !== undefined;
  const human = ctx.latest(tables.report, "human-gate");

  return (
    <Workflow name={spec.id}>
      <Sequence>
        <Branch if={!tickets.length} then={<Discover ctx={ctx} />} />
        {tickets.map(t => <TaskRalph key={t.id} ticket={t} ctx={ctx} />)}
        <Branch if={allDone && !fullReview} then={<FullReviewRalph ctx={ctx} />} />
        <Branch if={allDone && fullReview} then={<HumanGate ctx={ctx} />} />
        <Branch if={human?.status === "approved"} then={<Task id="done" output={tables.report}>{{ v: 1, status: "done", work: ["Complete"] }}</Task>} />
      </Sequence>
    </Workflow>
  );
});
