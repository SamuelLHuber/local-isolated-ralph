#!/usr/bin/env bun
/**
 * Fabrik Dynamic Workflow
 * 
 * Self-contained smithers workflow that runs in project context.
 * No JSX pragma needed - smithers handles transformation.
 */

import { Sequence, Parallel, Branch } from "smithers-orchestrator";
import { Workflow, smithers, tables, type TaskContext } from "./smithers";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";

// Load spec from environment
const specPath = resolve(process.env.SMITHERS_SPEC_PATH || "specs/spec.md");
const isMarkdown = specPath.endsWith(".md") || specPath.endsWith(".mdx");

// Parse markdown spec
function parseMarkdownSpec(path: string) {
  const raw = readFileSync(path, "utf8");
  const titleMatch = raw.match(/^#\s+(.+)$/m) || raw.match(/Specification:\s*(.+)$/m);
  
  const extractSection = (pattern: RegExp): string[] => {
    const match = raw.match(pattern);
    if (!match) return [];
    const start = match.index! + match[0].length;
    const remaining = raw.slice(start);
    const nextSection = remaining.match(/^##?\s/m);
    const section = nextSection ? remaining.slice(0, nextSection.index) : remaining;
    return section.split("\n").filter(l => l.match(/^\s*[-*+]/)).map(l => l.replace(/^\s*[-*+]\s*/, "").trim()).filter(Boolean);
  };
  
  return {
    id: basename(path).replace(/\.mdx?$/, "").replace(/^spec[-_]/, ""),
    title: titleMatch?.[1]?.trim() || "Untitled Spec",
    goals: extractSection(/^##?\s*Goals?/im),
    nonGoals: extractSection(/^##?\s*Non[- ]?Goals?/im),
    requirements: {
      api: extractSection(/^##?\s*(API|Requirements?)/im).filter(r => r.toLowerCase().includes("api")),
      behavior: extractSection(/^##?\s*(Behavior|Requirements?)/im),
    },
    acceptance: extractSection(/^##?\s*Acceptance?/im),
    assumptions: extractSection(/^##?\s*Assumptions?/im),
    raw,
  };
}

const spec = isMarkdown ? parseMarkdownSpec(specPath) : JSON.parse(readFileSync(specPath, "utf8"));

// Agent factory (simplified - uses env vars)
function makeAgent(tier: "cheap" | "standard" | "powerful") {
  const agentKind = (process.env.RALPH_AGENT || "pi").toLowerCase();
  const model = process.env.SMITHERS_MODEL;
  
  // Return agent config - actual agent created by Task
  return {
    kind: agentKind,
    model: model || (tier === "cheap" ? "kimi-k2-5" : tier === "standard" ? "gpt-5" : "opus"),
    tier,
  };
}

// Ticket types
const TicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  tier: z.enum(["T1", "T2", "T3", "T4"]),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  dependencies: z.array(z.string()).nullable(),
  layersRequired: z.array(z.enum(["L1", "L2", "L3", "L4", "L5", "L6"])),
  reviewsRequired: z.array(z.string()),
  gates: z.array(z.enum(["lint", "typecheck", "build", "test", "coverage"])),
  model: z.enum(["cheap", "standard", "powerful"]),
});

type Ticket = z.infer<typeof TicketSchema>;

// Components
function Discover({ ctx, spec }: { ctx: TaskContext; spec: any }) {
  const prevDiscover = ctx.latest(tables.discover, "discover-output");
  const completedIds = prevDiscover?.tickets?.filter((t: Ticket) => 
    ctx.latest(tables.report, `${t.id}:report`)?.status === "done"
  )?.map((t: Ticket) => t.id) || [];

  return (
    <Task
      id="discover-output"
      output={tables.discover}
      agent={makeAgent("powerful")}
    >
      {`
Generate next tickets for spec: ${spec.id}
Completed: ${completedIds.join(", ") || "none"}

Spec:
${spec.raw?.slice(0, 2000) || JSON.stringify(spec)}

Output 0-5 tickets as JSON matching the discover schema.
`}
    </Task>
  );
}

function TicketPipeline({ ticket, ctx }: { ticket: Ticket; ctx: TaskContext }) {
  const report = ctx.latest(tables.report, `${ticket.id}:report`);
  const isComplete = report?.status === "done";
  
  const gateResults = ticket.gates.map(g => 
    ctx.latest(tables.gate, `gate-${ticket.id}-${g}`)
  );
  const allGatesPassed = gateResults.every(g => g?.passed);
  const needsLLMReview = ticket.reviewsRequired.length > 0 && 
    !(allGatesPassed && (ticket.tier === "T3" || ticket.tier === "T4"));

  return (
    <Sequence key={ticket.id} skipIf={isComplete}>
      <Task id={`implement-${ticket.id}`} output={tables.report} agent={makeAgent(ticket.model)}>
        {`Implement: ${ticket.title}\n\n${ticket.description}`}
      </Task>
      
      {ticket.gates.map(g => (
        <Task
          key={g}
          id={`gate-${ticket.id}-${g}`}
          output={tables.gate}
          agent={makeAgent("cheap")}
        >
          {`Run: bun run ${g}\nReturn: { v: 1, passed: boolean, command: "...", output: "...", durationMs: number }`}
        </Task>
      ))}
      
      {needsLLMReview && ticket.reviewsRequired.map(r => (
        <Task
          key={r}
          id={`review-${ticket.id}-${r}`}
          output={tables.report}
          agent={makeAgent(ticket.model)}
        >
          {`Review ${r}: ${ticket.title}`}
        </Task>
      ))}
      
      <Task id={`report-${ticket.id}`} output={tables.report}>
        {{ v: 1, taskId: ticket.id, tier: ticket.tier, status: "done", work: [], files: [], tests: [], gates: [], issues: [], next: [] }}
      </Task>
    </Sequence>
  );
}

function FinalReview({ tickets, ctx }: { tickets: Ticket[]; ctx: TaskContext }) {
  const reviewerIds = ["security", "code-quality", "test-coverage"];
  
  return (
    <Sequence>
      <Parallel>
        {reviewerIds.map(id => (
          <Task
            key={id}
            id={`final-review-${id}`}
            output={tables.finalReview}
            agent={makeAgent("powerful")}
          >
            {`Final review ${id} for ${tickets.length} tickets`}
          </Task>
        ))}
      </Parallel>
      
      <Task id="final-review-summary" output={tables.finalReview}>
        {() => {
          const reviews = reviewerIds.map(id => 
            ctx.latest(tables.finalReview, `final-review-${id}`)
          ).filter(Boolean);
          
          return {
            v: 1,
            status: reviews.every((r: any) => r.status === "approved") ? "approved" : "changes_requested",
            reviewers: reviewerIds,
            approvedBy: reviews.filter((r: any) => r.status === "approved").map((r: any, i: number) => reviewerIds[i]),
            rejectedBy: reviews.filter((r: any) => r.status === "changes_requested").map((r: any, i: number) => reviewerIds[i]),
            allIssues: reviews.flatMap((r: any) => r.issues || []),
            summary: "Final review complete",
          };
        }}
      </Task>
    </Sequence>
  );
}

// Main workflow
export default smithers((ctx) => {
  const discoverOutput = ctx.latest(tables.discover, "discover-output");
  const tickets: Ticket[] = discoverOutput?.tickets || [];
  const batchComplete = discoverOutput?.batchComplete || false;
  
  const unfinishedTickets = tickets.filter((t: Ticket) => {
    const report = ctx.latest(tables.report, `${t.id}:report`);
    return !report || report.status !== "done";
  });
  
  const allTicketsDone = tickets.length > 0 && unfinishedTickets.length === 0;
  const needsDiscovery = !discoverOutput || (allTicketsDone && !batchComplete);
  
  const finalReview = ctx.latest(tables.finalReview, "final-review-summary");
  
  return (
    <Workflow name={`dynamic-${spec.id}`}>
      <Sequence>
        <Branch if={needsDiscovery} then={<Discover ctx={ctx} spec={spec} />} />
        
        {unfinishedTickets.map((ticket: Ticket) => (
          <TicketPipeline key={ticket.id} ticket={ticket} ctx={ctx} />
        ))}
        
        <Branch
          if={batchComplete && allTicketsDone && finalReview?.status !== "approved"}
          then={<FinalReview tickets={tickets} ctx={ctx} />}
        />
        
        <Branch
          if={batchComplete && allTicketsDone && finalReview?.status === "approved"}
          then={
            <Task id="complete" output={tables.report}>
              {{ v: 1, taskId: "spec-complete", tier: "T1", status: "done", work: ["Complete"], files: [], tests: [], gates: [], issues: [], next: [] }}
            </Task>
          }
        />
      </Sequence>
    </Workflow>
  );
});
