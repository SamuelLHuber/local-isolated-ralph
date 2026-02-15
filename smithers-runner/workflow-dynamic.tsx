#!/usr/bin/env bun
/**
 * Fabrik Dynamic Workflow
 * 
 * Runtime ticket discovery for large evolving projects.
 * Discovers 3-5 tickets at a time, implements them, then discovers next batch.
 * 
 * Flow:
 * 1. Discover tickets from spec (3-5 at a time)
 * 2. TaskPipeline per ticket (Implement → Validate → LightReview)
 * 3. When all done, loop back to Discover for next batch
 * 4. When batchComplete, FullReview → HumanGate
 */

import { Sequence, Parallel, Branch, Ralph } from "smithers-orchestrator";
import { Workflow, Task, smithers, tables, createSmithers, type TaskContext } from "./smithers";
import { PiAgent, CodexAgent, ClaudeCodeAgent } from "smithers-orchestrator";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";

// Load spec
const specPath = resolve(process.env.SMITHERS_SPEC_PATH || "specs/spec.md");
const isMarkdown = specPath.endsWith(".md") || specPath.endsWith(".mdx");
const reviewersDir = process.env.SMITHERS_REVIEWERS_DIR;

function parseSpec(path: string) {
  const raw = readFileSync(path, "utf8");
  return {
    id: basename(path).replace(/\.mdx?$/, "").replace(/^spec[-_]/, ""),
    title: raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Untitled",
    raw,
  };
}

const spec = isMarkdown ? parseSpec(specPath) : JSON.parse(readFileSync(specPath, "utf8"));

// Agent factory
function makeAgent(tier: "cheap" | "standard" | "powerful") {
  const kind = (process.env.RALPH_AGENT || "pi").toLowerCase();
  const cwd = process.env.SMITHERS_CWD || process.cwd();
  const baseOpts = { cwd };
  
  switch (kind) {
    case "claude": return new ClaudeCodeAgent({ ...baseOpts, model: "claude-opus-4", dangerouslySkipPermissions: true });
    case "codex": return new CodexAgent({ ...baseOpts, model: "gpt-5.2-codex", sandbox: "danger-full-access" });
    default: 
      const key = process.env.FIREWORKS_API_KEY || process.env.API_KEY_MOONSHOT;
      const provider = process.env.FIREWORKS_API_KEY ? "fireworks" : "moonshot";
      const model = provider === "fireworks" ? "fireworks/kimi-k2p5" : "kimi-k2.5";
      return new PiAgent({ ...baseOpts, model, provider, mode: "json", noSession: true });
  }
}

const getReviewers = (names?: string[]): string[] => {
  if (!reviewersDir || !existsSync(reviewersDir)) return [];
  const all = readdirSync(reviewersDir).filter(f => f.endsWith(".md"));
  if (!names) return all.map(f => join(reviewersDir, f));
  return names.map(n => join(reviewersDir, n)).filter(p => existsSync(p));
};

const readPrompt = (path: string) => {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
};

// Types
interface Ticket {
  id: string;
  title: string;
  description: string;
  tier: "T1" | "T2" | "T3" | "T4";
}

// Discover: Generate next batch of tickets
function Discover({ ctx }: { ctx: TaskContext }) {
  const prev = ctx.latest(tables.discover, "discover");
  const completed = prev?.tickets?.filter((t: Ticket) => 
    ctx.latest(tables.report, `${t.id}:report`)
  )?.map((t: Ticket) => t.id) || [];

  return (
    <Task id="discover" output={tables.discover} agent={makeAgent("powerful")}>
      {`DISCOVER NEXT TICKETS

Spec: ${spec.id}
${completed.length > 0 ? `Completed: ${completed.join(", ")}` : "Starting fresh"}

Analyze the spec and generate the next 3-5 implementation tickets.
Each ticket should be:
- Small enough to implement in one coherent session
- Testable with clear acceptance criteria  
- Independent (minimal dependencies on other tickets)

OUTPUT JSON:
{
  "v": 1,
  "tickets": [
    {
      "id": "kebab-case-slug",
      "title": "Imperative action description",
      "description": "Detailed what and why",
      "tier": "T1|T2|T3|T4",
      "acceptanceCriteria": ["criteria"],
      "dependencies": null,
      "layersRequired": ["L1","L2"],
      "reviewsRequired": ["CODE-QUALITY","MAINTAINABILITY"],
      "gates": ["lint","typecheck","test"],
      "model": "cheap|standard|powerful"
    }
  ],
  "reasoning": "Why these tickets, in this order",
  "batchComplete": boolean
}

Set batchComplete=true when ALL work for this spec is done.`}
    </Task>
  );
}

// TaskPipeline: Single ticket through implement → validate → review
function TaskPipeline({ ticket, ctx }: { ticket: Ticket; ctx: TaskContext }) {
  const lightReviewers = ["CODE-QUALITY.md", "MAINTAINABILITY.md"];
  const reviewerPaths = getReviewers(lightReviewers);
  
  const impl = ctx.latest(tables.report, `${ticket.id}:implement`);
  const val = ctx.latest(tables.gate, `${ticket.id}:validate`);
  const reviews = reviewerPaths.map((p, i) => ctx.latest(tables.report, `${ticket.id}:review-${i}`));
  
  const allApproved = reviews.every(r => r?.status === "approved");
  const issues = reviews.flatMap((r, i) => 
    r?.status === "changes_requested" ? [{ reviewer: lightReviewers[i], issues: r.issues }] : []
  );

  return (
    <Ralph id={`${ticket.id}:loop`} until={allApproved} maxIterations={5} onMaxReached="return-last">
      <Sequence>
        {/* Implement */}
        <Task id={`${ticket.id}:implement`} output={tables.report} agent={makeAgent(ticket.model)}>
          {`IMPLEMENT: ${ticket.title}

${ticket.description}

${issues.length > 0 ? `PREVIOUS FEEDBACK:\n${JSON.stringify(issues, null, 2)}\n\nAddress ALL issues.` : ""}

1. Read spec, study codebase patterns
2. Implement completely
3. Run lint, typecheck, tests
4. Commit with reasoning traces

OUTPUT JSON:
{ "v": 1, "taskId": "${ticket.id}", "tier": "${ticket.tier}", "status": "done", "work": [], "files": [], "tests": [], "gates": [], "issues": [], "next": [] }`}
        </Task>

        {/* Validate */}
        <Task id={`${ticket.id}:validate`} output={tables.gate} agent={makeAgent("cheap")}>
          {`VALIDATE: ${ticket.title}
Run: bun run lint && bun run typecheck && bun run test
OUTPUT JSON: { "v": 1, "passed": boolean, "command": "...", "output": "...", "durationMs": number }`}
        </Task>

        {/* Light Review */}
        <Branch if={val?.passed !== false} then={
          <Parallel maxConcurrency={2}>
            {reviewerPaths.map((path, i) => (
              <Task key={i} id={`${ticket.id}:review-${i}`} output={tables.report} agent={makeAgent("standard")} continueOnFail>
                {`${readPrompt(path)}\n\nReview: ${ticket.title}\nOUTPUT JSON: { "v": 1, "taskId": "${ticket.id}", "status": "approved|changes_requested", "issues": [], "next": [] }`}
              </Task>
            ))}
          </Parallel>
        } />

        {/* ReviewFix if needed */}
        <Branch if={issues.length > 0} then={
          <Task id={`${ticket.id}:fix`} output={tables.report} agent={makeAgent("powerful")}>
            {`FIX: ${ticket.title}\n\nIssues: ${JSON.stringify(issues)}\n\nAddress all, re-validate, commit.`}
          </Task>
        } />
      </Sequence>
    </Ralph>
  );
}

// FullReview: All reviewers after all tickets done
function FullReview({ ctx }: { ctx: TaskContext }) {
  const allReviewers = getReviewers();
  const reviewerNames = allReviewers.map(p => basename(p));
  const reviews = reviewerNames.map((n, i) => ctx.latest(tables.report, `full-review-${i}`));
  const allApproved = reviews.every(r => r?.status === "approved");
  const issues = reviews.flatMap((r, i) => r?.status === "changes_requested" ? [{ reviewer: reviewerNames[i], issues: r.issues }] : []);

  return (
    <Ralph id="full-review" until={allApproved} maxIterations={5} onMaxReached="return-last">
      <Sequence>
        <Parallel maxConcurrency={8}>
          {allReviewers.map((path, i) => (
            <Task key={i} id={`full-review-${i}`} output={tables.report} agent={makeAgent("standard")} continueOnFail>
              {`${readPrompt(path)}\n\nReview entire spec implementation.\nOUTPUT JSON: { "v": 1, "status": "approved|changes_requested", "issues": [] }`}
            </Task>
          ))}
        </Parallel>
        
        <Branch if={issues.length > 0} then={
          <Sequence>
            <Task id="full-fix" output={tables.report} agent={makeAgent("powerful")}>
              {`FIX ALL REVIEWER ISSUES:\n${JSON.stringify(issues)}\n\nAddress each, re-validate all, commit.`}
            </Task>
            <Task id="full-revalidate" output={tables.gate} agent={makeAgent("cheap")}>
              {`Re-validate after fixes. OUTPUT JSON: { "v": 1, "passed": boolean }`}
            </Task>
          </Sequence>
        } />
      </Sequence>
    </Ralph>
  );
}

// HumanGate: Final approval
function HumanGate({ ctx }: { ctx: TaskContext }) {
  return (
    <Task id="human-gate" output={tables.report} needsApproval label={`Approve: ${spec.id}`}>
      {`HUMAN REVIEW: ${spec.id}\n\nAll automated reviews passed.\nReview implementation and commit history.\nApprove or provide feedback for fixes.`}
    </Task>
  );
}

// Main workflow
export default smithers((ctx) => {
  const discover = ctx.latest(tables.discover, "discover");
  const tickets: Ticket[] = discover?.tickets || [];
  const batchComplete = discover?.batchComplete || false;
  
  const unfinished = tickets.filter((t: Ticket) => !ctx.latest(tables.report, `${t.id}:report`));
  const allTicketsDone = tickets.length > 0 && unfinished.length === 0;
  
  const fullReviewDone = ctx.latest(tables.report, "full-review-0") !== undefined;
  const humanGate = ctx.latest(tables.report, "human-gate");

  return (
    <Workflow name={`dynamic-${spec.id}`}>
      <Sequence>
        {/* Discover next batch */}
        <Branch if={unfinished.length === 0 && !batchComplete} then={<Discover ctx={ctx} />} />
        
        {/* Process all tickets in batch */}
        {unfinished.map((t: Ticket) => <TaskPipeline key={t.id} ticket={t} ctx={ctx} />)}
        
        {/* Full review when batch complete */}
        <Branch if={batchComplete && allTicketsDone && !fullReviewDone} then={<FullReview ctx={ctx} />} />
        
        {/* Human gate */}
        <Branch if={batchComplete && fullReviewDone} then={<HumanGate ctx={ctx} />} />
        
        {/* Complete */}
        <Branch if={humanGate?.status === "approved"} then={
          <Task id="complete" output={tables.report}>{{ v: 1, taskId: "done", status: "done", work: ["Complete"] }}</Task>
        } />
      </Sequence>
    </Workflow>
  );
});
