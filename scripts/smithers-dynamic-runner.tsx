#!/usr/bin/env smithers
/** @jsxImportSource smithers-orchestrator */
import * as React from "react"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname, join, resolve, basename } from "node:path"
import { z } from "zod"
import {
  createSmithers,
  Sequence,
  Parallel,
  Ralph,
  Branch,
  PiAgent,
  CodexAgent,
  ClaudeCodeAgent,
  useCtx,
  type TaskContext
} from "smithers-orchestrator"

// =============================================================================
// SCHEMAS
// =============================================================================

const Ticket = z.object({
  id: z.string().describe("kebab-case identifier (e.g., 'implement-chinese-zodiac-api')"),
  title: z.string(),
  tier: z.enum(["T1", "T2", "T3", "T4"]).describe("Criticality tier per compound engineering"),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  dependencies: z.array(z.string()).nullable(),
  layersRequired: z.array(z.enum(["L1", "L2", "L3", "L4", "L5", "L6"])),
  reviewsRequired: z.array(z.string()).describe("Adaptive: which reviewers based on tier/patterns"),
  gates: z.array(z.enum(["lint", "typecheck", "build", "test", "coverage"])),
  model: z.enum(["cheap", "standard", "powerful"]),
  estimatedHours: z.number().optional()
})

const DiscoverOutput = z.object({
  v: z.literal(1),
  tickets: z.array(Ticket).max(5).describe("Next 0-5 tickets to implement"),
  reasoning: z.string().describe("Why these tickets, chosen tier, and expected guarantees"),
  batchComplete: z.boolean().describe("True if no more tickets remain (spec fully implemented)")
})

const GateResult = z.object({
  v: z.literal(1),
  passed: z.boolean(),
  command: z.string(),
  output: z.string(),
  durationMs: z.number()
})

const Report = z.object({
  v: z.literal(1),
  taskId: z.string(),
  tier: z.string(),
  status: z.enum(["done", "blocked", "failed"]),
  work: z.array(z.string()),
  files: z.array(z.string()),
  tests: z.array(z.string()),
  gates: z.array(GateResult),
  issues: z.array(z.string()),
  next: z.array(z.string()),
  learning: z.object({
    actualHours: z.number(),
    reviewIterations: z.number(),
    costEstimateUsd: z.number()
  }).optional()
})

// =============================================================================
// FINAL REVIEW SCHEMAS (must be defined before createSmithers)
// =============================================================================

const finalReviewerSchema = z.object({
  v: z.literal(1),
  reviewer: z.string(),
  status: z.enum(["approved", "changes_requested"]),
  issues: z.array(z.string()),
  next: z.array(z.string())
})

const finalReviewSummarySchema = z.object({
  v: z.literal(1),
  status: z.enum(["approved", "changes_requested"]),
  reviewers: z.array(z.string()),
  approvedBy: z.array(z.string()),
  rejectedBy: z.array(z.string()),
  allIssues: z.array(z.string()),
  summary: z.string()
})

// Flexible schema for final review entries
const finalReviewSchema = z.object({
  v: z.number(),
  reviewer: z.string().optional(),
  status: z.enum(["approved", "changes_requested"]),
  issues: z.array(z.string()).optional(),
  next: z.array(z.string()).optional(),
  reviewers: z.array(z.string()).optional(),
  approvedBy: z.array(z.string()).optional(),
  rejectedBy: z.array(z.string()).optional(),
  allIssues: z.array(z.string()).optional(),
  summary: z.string().optional()
})

// =============================================================================
// ENVIRONMENT & SETUP
// =============================================================================

const env = process.env
const specPath = resolve(env.SMITHERS_SPEC_PATH ?? env.SPEC_PATH ?? "specs/spec.md")
const isMarkdown = specPath.endsWith(".md") || specPath.endsWith(".mdx")

// Read spec (JSON or Markdown)
let spec: { 
  id: string
  title: string
  goals: string[]
  nonGoals: string[]
  requirements?: { api: string[]; behavior: string[]; observability?: string[] }
  acceptance?: string[]
  assumptions?: string[]
  raw?: string  // For markdown
}

if (isMarkdown) {
  const raw = readFileSync(specPath, "utf8")
  const titleMatch = raw.match(/^#\s+(.+)$/m) || raw.match(/Specification:\s*(.+)$/m)
  
  // Parse markdown sections
  const extractSection = (pattern: RegExp): string[] => {
    const match = raw.match(pattern)
    if (!match) return []
    const start = match.index! + match[0].length
    const remaining = raw.slice(start)
    const nextSection = remaining.match(/^##?\s/m)
    const section = nextSection ? remaining.slice(0, nextSection.index) : remaining
    return section
      .split("\n")
      .filter(l => l.match(/^\s*[-*+]/))
      .map(l => l.replace(/^\s*[-*+]\s*/, "").trim())
      .filter(Boolean)
  }
  
  spec = {
    id: env.SMITHERS_SPEC_ID || basename(specPath).replace(/\.mdx?$/, "").replace(/^spec[-_]/, ""),
    title: titleMatch?.[1] ?? "Untitled Spec",
    goals: extractSection(/^##?\s*Goals?/im),
    nonGoals: extractSection(/^##?\s*Non[- ]?Goals?/im),
    requirements: {
      api: extractSection(/^##?\s*(API|Requirements?)/im).filter(r => 
        r.toLowerCase().includes("api") || r.toLowerCase().includes("endpoint")
      ),
      behavior: extractSection(/^##?\s*(Behavior|Requirements?)/im)
    },
    acceptance: extractSection(/^##?\s*Acceptance?/im),
    assumptions: extractSection(/^##?\s*Assumptions?/im),
    raw
  }
} else {
  spec = JSON.parse(readFileSync(specPath, "utf8"))
}

const dbPath = resolve(env.SMITHERS_DB_PATH ?? join(".smithers", `${spec.id}.dynamic.db`))
const reportDir = resolve(env.SMITHERS_REPORT_DIR ?? "reports")
const patternsPath = resolve(env.SMITHERS_PATTERNS_PATH ?? ".fabrik/patterns.json")
const execCwd = env.SMITHERS_CWD ? resolve(env.SMITHERS_CWD) : process.cwd()
const agentKind = (env.SMITHERS_AGENT ?? env.RALPH_AGENT ?? "pi").toLowerCase()
const modelOverride = env.SMITHERS_MODEL ?? env.MODEL
const providerOverride = env.SMITHERS_PROVIDER ?? env.PI_PROVIDER
const reviewMax = Number(env.SMITHERS_REVIEW_MAX ?? 2)

if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true })
if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true })

// =============================================================================
// DATABASE & TABLES
// =============================================================================

const { Workflow, Task, smithers, tables } = createSmithers(
  {
    discover: DiscoverOutput,
    gate: GateResult,
    report: Report,
    finalReview: finalReviewSchema
  },
  { dbPath }
)

// =============================================================================
// LOAD LEARNED PATTERNS
// =============================================================================

type Pattern = {
  taskType: string
  tier: "T1" | "T2" | "T3" | "T4"
  reviews: string[]
  model: "cheap" | "standard" | "powerful"
  gates: string[]
  confidence: number
}

function loadPatterns(): Pattern[] {
  if (!existsSync(patternsPath)) return []
  try {
    return JSON.parse(readFileSync(patternsPath, "utf8"))
  } catch {
    return []
  }
}

const patterns = loadPatterns()

function findPattern(taskType: string): Pattern | undefined {
  return patterns.find(p => taskType.toLowerCase().includes(p.taskType.toLowerCase()))
}

// =============================================================================
// AGENT FACTORY
// =============================================================================

function makeAgent(tier: "cheap" | "standard" | "powerful", model?: string) {
  const resolvedModel = model ?? modelOverride
  
  if (agentKind === "claude") {
    return new ClaudeCodeAgent({
      model: resolvedModel ?? "opus",
      dangerouslySkipPermissions: true,
      cwd: execCwd
    })
  }
  
  if (agentKind === "codex") {
    // Map tier to model
    const tierModel = tier === "cheap" ? "gpt-4.1-mini" : 
                      tier === "standard" ? "gpt-5" : "gpt-5.2-codex"
    return new CodexAgent({
      model: resolvedModel ?? tierModel,
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cd: execCwd,
      cwd: execCwd
    })
  }
  
  // Pi agent with tier-based model selection
  const piModel = tier === "cheap" ? "kimi-k2-5" :
                  tier === "standard" ? "kimi-k2-5" : "kimi-k2-5"
  
  return new PiAgent({
    model: resolvedModel ?? piModel,
    provider: providerOverride ?? undefined,
    mode: "json",
    cwd: execCwd
  })
}

// =============================================================================
// DISCOVER COMPONENT
// =============================================================================

function Discover() {
  const ctx = useCtx()
  
  // Get previously discovered tickets
  const prevDiscover = ctx.latest(tables.discover, "discover-output")
  const completedTickets = prevDiscover?.tickets?.filter((t: z.infer<typeof Ticket>) => 
    ctx.latest(tables.report, `${t.id}:report`)?.status === "done"
  ) ?? []
  
  const completedIds = completedTickets.map((t: z.infer<typeof Ticket>) => t.id)
  
  // Build patterns context
  const patternsContext = patterns.length > 0 
    ? patterns.map(p => `- ${p.taskType}: tier=${p.tier}, reviews=[${p.reviews.join(",")}], model=${p.model}`).join("\n")
    : "No patterns learned yet. Use compound engineering principles."
  
  return (
    <Task
      id="discover-output"
      output={tables.discover}
      outputSchema={DiscoverOutput}
      agent={makeAgent("powerful")}  // Discovery requires strong reasoning
    >
      {`
## Spec

**ID**: ${spec.id}
**Title**: ${spec.title}

**Goals**:
${spec.goals.map(g => `- ${g}`).join("\n") || "(none specified)"}

**Non-Goals**:
${spec.nonGoals.map(g => `- ${g}`).join("\n") || "(none specified)"}

**Requirements**:
${spec.requirements?.api?.map((r: string) => `- API: ${r}`).join("\n") || ""}
${spec.requirements?.behavior?.map((r: string) => `- Behavior: ${r}`).join("\n") || ""}

${spec.raw ? "\\n**Full Spec**:\\n" + spec.raw.slice(0, 2000) + "..." : ""}

## Completed Tickets

${completedIds.length > 0 
  ? completedIds.map(id => `- ${id}`).join("\n") 
  : "None yet - this is the first batch."}

## Learned Patterns

${patternsContext}

## Discovery Instructions

Generate the next 0-5 tickets to implement this spec. Follow compound engineering:

**Tier Classification**:
- **T1 (Critical)**: Money, auth, signing, irreversible state → ALL 6 layers
- **T2 (Important)**: User data, business logic, state machines → L1-L5
- **T3 (Standard)**: Features, UI state, caching → L1-L4
- **T4 (Low)**: Analytics, logging, metrics → L1, L4

**6-Layer Guarantee System**:
- **L1 (Types)**: Branded types, phantom types, strict schemas
- **L2 (Runtime)**: Effect.assert for pre/postconditions
- **L3 (Persistence)**: DB constraints, uniqueness, CHECK
- **L4 (Tests)**: @property tests with named invariants, coverage thresholds
- **L5 (Monitoring)**: Production TODOs, alert conditions
- **L6 (Simulation)**: 24/7 seed-based testing (T1 only)

**Adaptive Review Selection**:
- T1: security, correctness, nasa-10, test-coverage (4 reviewers)
- T2: security, code-quality, test-coverage (3 reviewers)
- T3: code-quality (1 reviewer, conditional)
- T4: none (deterministic gates only)

**Model Selection**:
- T1 tasks → "powerful" (expensive, thorough)
- T2/T3 tasks → "standard" (balanced)
- T4 tasks → "cheap" (fast, cost-effective)

**Deterministic Gates** (fast feedback before LLM):
All tiers: ["lint", "typecheck", "build"]
T1/T2 add: ["test", "coverage"]

## Output

Return JSON matching DiscoverOutput schema:
- 0-5 tickets with tier, layers, reviews, gates, model
- reasoning: why these tickets and tier choices
- batchComplete: true if spec is fully implemented (no more tickets)

Be conservative on tier (safety), aggressive on review minimization (efficiency).
      `}
    </Task>
  )
}

// =============================================================================
// DETERMINISTIC GATES
// =============================================================================

function DeterministicGate({ gate, ticket }: { gate: string; ticket: z.infer<typeof Ticket> }) {
  const commands: Record<string, string> = {
    lint: "bun run lint",
    typecheck: "bun run typecheck",
    build: "bun run build",
    test: "bun run test:unit",
    coverage: `bun run test:coverage --threshold=${ticket.tier === "T1" ? 90 : ticket.tier === "T2" ? 85 : 80}`
  }
  
  return (
    <Task
      id={`gate-${ticket.id}-${gate}`}
      output={tables.gate}
      outputSchema={GateResult}
      agent={makeAgent("cheap")}  // Gate execution uses cheap agent
    >
      {`
Execute: ${commands[gate]}

Return JSON: { v: 1, passed: boolean, command: "...", output: "...", durationMs: number }

If failed, include error output in the response.
      `}
    </Task>
  )
}

// =============================================================================
// LLM REVIEW (CONDITIONAL)
// =============================================================================

const defaultReviewers = [
  { id: "security", title: "Security", prompt: "Focus on vulnerabilities, secrets, injection risks" },
  { id: "correctness", title: "Correctness", prompt: "Focus on logic errors, edge cases, invariants" },
  { id: "code-quality", title: "Code Quality", prompt: "Focus on readability, maintainability, patterns" },
  { id: "nasa-10", title: "NASA-10 Rules", prompt: "Check against NASA Power of Ten rules" },
  { id: "test-coverage", title: "Test Coverage", prompt: "Verify @property tests, coverage thresholds" },
  { id: "simplicity", title: "Simplicity", prompt: "Check for over-engineering, unnecessary complexity" }
]

function LLMReview({ ticket, reviewerId }: { ticket: z.infer<typeof Ticket>; reviewerId: string }) {
  const reviewer = defaultReviewers.find(r => r.id === reviewerId)
  if (!reviewer) return null
  
  return (
    <Task
      id={`review-${ticket.id}-${reviewerId}`}
      output={tables.report}  // Reviews feed into report
      agent={makeAgent(ticket.model === "T4" ? "cheap" : ticket.model)}
    >
      {`
**Review**: ${reviewer.title}
**Ticket**: ${ticket.id} (${ticket.tier})
**Focus**: ${reviewer.prompt}

**Ticket Details**:
${ticket.description}

**Acceptance Criteria**:
${ticket.acceptanceCriteria.map(a => `- ${a}`).join("\n")}

Review the implementation. Return issues found and approval status.
      `}
    </Task>
  )
}

// =============================================================================
// FINAL REVIEW GATE - ALL 8 REVIEWERS (Mandatory)
// =============================================================================

// Schemas defined at top of file: finalReviewerSchema, finalReviewSummarySchema, finalReviewSchema

// All 8 reviewers run in parallel for final spec review
const finalReviewers = [
  { 
    id: "security", 
    title: "Security", 
    prompt: `Security Review Checklist:
- [ ] No hardcoded secrets or credentials in code
- [ ] Input validation at all entry points (prevent injection)
- [ ] Proper error handling (no information leakage)
- [ ] Authentication/authorization checks where applicable
- [ ] Secure defaults (deny by default, least privilege)
- [ ] No SQL injection vectors (parameterized queries)
- [ ] No XSS vulnerabilities (output encoding)
- [ ] Dependencies up to date (no known CVEs)
- [ ] Sensitive data encrypted at rest and in transit
- [ ] Audit logging for sensitive operations

Effect-TS Specific:
- [ ] Effect error channels don't leak sensitive internals
- [ ] Service requirements properly scoped (least privilege)
- [ ] No direct Promise rejection exposure

Flag any security issue as changes_requested with severity: CRITICAL/HIGH/MEDIUM` 
  },
  { 
    id: "code-quality", 
    title: "Code Quality", 
    prompt: `Code Quality Review Checklist:
- [ ] Functions are focused and single-purpose (SRP)
- [ ] Variable names are descriptive and intent-revealing
- [ ] No magic numbers or strings (use named constants)
- [ ] Consistent formatting and style
- [ ] Comments explain WHY, not WHAT
- [ ] No dead code or unused imports
- [ ] Error handling is comprehensive
- [ ] No deeply nested conditionals (prefer early returns)
- [ ] Async code properly handled (no floating Promises)

TypeScript Specific:
- [ ] Strict typing enabled (no 'any', minimal 'unknown')
- [ ] Type inference used appropriately
- [ ] Null/undefined handling explicit (Option/Maybe types)

Effect-TS Specific:
- [ ] Effects are composed, not nested
- [ ] Error channels are explicit and handled
- [ ] Resource management uses Scope/acquireRelease
- [ ] No Effect.runPromise in library code

Flag quality issues as changes_requested or approved with suggestions.` 
  },
  { 
    id: "simplicity", 
    title: "Minimal Simplicity", 
    prompt: `Simplicity Review (Tigerstyle):
- [ ] DENSITY: One idea per line, no unnecessary abstraction
- [ ] LOCALITY: Related concepts close together
- [ ] EXPLICITNESS: All side effects visible, no hidden control flow

Anti-Patterns to Flag:
- [ ] Over-engineering for simple cases
- [ ] Premature optimization without clear benefit
- [ ] Deep inheritance hierarchies (prefer composition)
- [ ] Unnecessary indirection (interface with single impl)
- [ ] "Enterprise" patterns where functions suffice

Approval Criteria:
- Could a junior dev understand this in 5 minutes?
- Is there a shorter way to express this intent?
- Are we solving the problem we have, not might have?

Flag complexity without justification as changes_requested.` 
  },
  { 
    id: "test-coverage", 
    title: "Test Coverage", 
    prompt: `Test Coverage Review (Layer 4 Requirements):

Unit Tests:
- [ ] Happy path covered for all public functions
- [ ] Edge cases identified and tested (empty, boundaries)
- [ ] Error paths tested (Effect failure branches)
- [ ] No tests that just "pass through" without verification

Property-Based Tests (Critical):
- [ ] Invariants have @property TSDoc comments with names
- [ ] Property tests for: Conservation, Idempotency, Commutativity, Associativity

Integration Tests:
- [ ] End-to-end flows work with real/test services
- [ ] Database constraints actually enforced
- [ ] External API boundaries handled correctly

Effect-TS Testing:
- [ ] Effect.TestClock used for time-dependent logic
- [ ] TestContext provided for all service dependencies
- [ ] Both success and failure branches tested

Coverage Thresholds:
- T1/T2: 90%+ line, 85%+ branch
- T3/T4: 80%+ line, 70%+ branch
- Every @property has a corresponding test

Flag missing coverage as changes_requested for critical paths.` 
  },
  { 
    id: "maintainability", 
    title: "Maintainability", 
    prompt: `Maintainability Review:

Documentation:
- [ ] README or module docs explain "why" and "how"
- [ ] Complex business logic has context comments
- [ ] API changes documented (breaking vs non-breaking)

Code Organization:
- [ ] Clear module boundaries (high cohesion, low coupling)
- [ ] Public API surface is minimal and intentional
- [ ] No circular dependencies

Observability:
- [ ] Structured logging for important operations
- [ ] Error contexts include actionable information
- [ ] Metrics/TODOs documented for production (L5)

Onboarding:
- [ ] New developer could fix a bug in 1 hour
- [ ] No tribal knowledge required
- [ ] Examples provided for complex operations

Effect-TS Specific:
- [ ] Service interfaces are stable and well-documented
- [ ] Error types are actionable
- [ ] Resource lifecycles are clear

Flag maintainability issues as approved with suggestions (not blocking unless severe).` 
  },
  { 
    id: "tigerstyle", 
    title: "Tigerstyle Audit", 
    prompt: `Tigerstyle Principles Audit:

DENSITY (Concise but not cryptic):
- [ ] One idea per line
- [ ] No unnecessary abstraction layers
- [ ] Remove boilerplate and ceremony

LOCALITY (Related concepts together):
- [ ] No jumps across files for understanding
- [ ] Cohesive functions and modules
- [ ] Minimize cognitive distance

EXPLICITNESS (All side effects visible):
- [ ] No hidden control flow
- [ ] No magic conventions
- [ ] Dependencies explicitly declared

STABILITY (Software that lasts decades):
- [ ] Does this code look like it will last 20 years?
- [ ] Is it free of fads and trends?
- [ ] Will it be understandable in 2030?

Checklist:
- [ ] No primitive obsession (branded types)
- [ ] Immutable data structures (const > let)
- [ ] Explicit dependencies (Effect requirements)
- [ ] Fail fast with guard clauses

Flag violations as changes_requested with specific fixes.` 
  },
  { 
    id: "nasa-10-rules", 
    title: "NASA Engineering Principles", 
    prompt: `NASA Power of Ten Rules Review:

1. [ ] Simple control flow - No goto, no deep recursion
2. [ ] Fixed upper bound on all loops
3. [ ] No dynamic memory allocation after init
4. [ ] Functions are short (<60 lines, single purpose)
5. [ ] Minimum 2 assertions per function
6. [ ] Data declared at smallest scope
7. [ ] Check return values
8. [ ] Limited preprocessor use
9. [ ] Pointers used sparingly and checked
10. [ ] Compile with all warnings, no warnings

For TypeScript/Effect-TS:
- [ ] No unbounded recursion (use loops or trampoline)
- [ ] Strict null checks enabled
- [ ] Match.exhaustive for all pattern matches
- [ ] Effect error channels not ignored
- [ ] All Promise rejections handled

These are non-negotiable for reliability-critical code.
Flag violations as changes_requested.` 
  },
  { 
    id: "correctness-guarantees", 
    title: "Correctness & Invariant Validation", 
    prompt: `Correctness & Invariant Review:

6-Layer Guarantee System Verification:

L1 (Types) - Branded/Phantom Types:
- [ ] Domain values use branded types (UserId, not string)
- [ ] State machines use phantom types
- [ ] Invalid states are unrepresentable

L2 (Runtime) - Assertions:
- [ ] Effect.assert for preconditions
- [ ] Effect.assert for postconditions
- [ ] Fail fast on invariant violations

L3 (Persistence) - DB Constraints:
- [ ] UNIQUE constraints for idempotency
- [ ] CHECK constraints for valid values
- [ ] Foreign keys with proper cascade

L4 (Tests) - Property-Based:
- [ ] @property TSDoc on every invariant
- [ ] Conservation properties tested
- [ ] Idempotency verified

L5 (Monitoring) - Production:
- [ ] TODOs for alerts with severity
- [ ] Metrics emission points documented

L6 (Simulation) - T1 Only:
- [ ] Seed-based simulation plan exists
- [ ] Failure injection scenarios defined

Verify each layer has corresponding implementation.
Flag missing layers as changes_requested for T1/T2 code.` 
  }
]

function FinalReview({ tickets }: { tickets: z.infer<typeof Ticket>[] }) {
  const ctx = useCtx()
  
  // Collect all ticket reports for context
  const ticketReports = tickets.map(t => ({
    id: t.id,
    tier: t.tier,
    report: ctx.latest(tables.report, `${t.id}:report`)
  }))
  
  const completedTickets = ticketReports.filter(t => t.report?.status === "done")
  const failedTickets = ticketReports.filter(t => t.report?.status === "failed")
  const blockedTickets = ticketReports.filter(t => t.report?.status === "blocked")
  
  // Check if all 8 reviewers have completed
  const allReviewersComplete = finalReviewers.every(r => 
    ctx.latest(tables.finalReview, `final-review-${r.id}`)
  )
  
  const summary = ctx.latest(tables.finalReview, "final-review-summary")
  
  if (summary?.status === "approved") {
    // All 8 approved, skip
    return null
  }
  
  // Calculate combined status
  const reviewerResults = finalReviewers.map(r => ({
    id: r.id,
    result: ctx.latest(tables.finalReview, `final-review-${r.id}`)
  }))
  
  const approvedBy = reviewerResults.filter(r => r.result?.status === "approved").map(r => r.id)
  const rejectedBy = reviewerResults.filter(r => r.result?.status === "changes_requested").map(r => r.id)
  const allIssues = reviewerResults.flatMap(r => r.result?.issues || [])
  
  // All 8 must approve
  const allApproved = approvedBy.length === finalReviewers.length
  
  return (
    <Sequence>
      {/* Phase 1: All 8 Reviewers in Parallel */}
      <Parallel>
        {finalReviewers.map(reviewer => (
          <Task
            key={reviewer.id}
            id={`final-review-${reviewer.id}`}
            output={tables.finalReview}
            outputSchema={finalReviewerSchema}
            agent={makeAgent("powerful")}  // Always powerful for final review
          >
            {`
## FINAL SPEC REVIEW: ${reviewer.title}

**Spec**: ${spec.id} - ${spec.title}

**Implementation Summary**:
- Total Tickets: ${tickets.length}
- Completed: ${completedTickets.length}
- Failed: ${failedTickets.length}
- Blocked: ${blockedTickets.length}

**Tickets Implemented**:
${completedTickets.map(t => `- ${t.id} (${t.tier}): ${t.report?.work?.slice(0, 2).join("; ") || "No description"}`).join("\n")}

**Spec Goals**:
${spec.goals.map(g => `- ${g}`).join("\n")}

**Acceptance Criteria**:
${spec.acceptance?.map((a: string) => `- ${a}`).join("\n") || ""}

---

## ${reviewer.title} Review Instructions

${reviewer.prompt}

**Your Task**: Review the ENTIRE implementation against the spec and checklist above.

**Output Schema**:
{
  v: 1,
  reviewer: "${reviewer.id}",
  status: "approved" | "changes_requested",
  issues: ["Specific issues with severity (CRITICAL/HIGH/MEDIUM/LOW)"],
  next: ["Actionable fixes required"]
}

Be thorough. This is a mandatory gate - the spec cannot complete without all 8 reviewers approving.
            `}
          </Task>
        ))}
      </Parallel>
      
      {/* Phase 2: Summary Task */}
      <Task
        id="final-review-summary"
        output={tables.finalReview}
        outputSchema={finalReviewSummarySchema}
      >
        {{
          v: 1,
          status: allApproved ? "approved" : "changes_requested",
          reviewers: finalReviewers.map(r => r.id),
          approvedBy,
          rejectedBy,
          allIssues,
          summary: allApproved 
            ? `All 8 reviewers approved. Implementation meets spec requirements.`
            : `${rejectedBy.length} reviewer(s) requested changes: ${rejectedBy.join(", ")}. Issues must be addressed and all 8 reviewers must approve.`
        }}
      </Task>
      
      {/* Phase 3: Remediation if needed */}
      <Branch
        if={!allApproved}
        then={
          <Task
            id="final-review-remediation"
            output={tables.report}
          >
            {`
**MANDATORY FINAL REVIEW REMEDIATION REQUIRED**

The following reviewers requested changes:
${rejectedBy.map(id => `- ${id}: ${reviewerResults.find(r => r.id === id)?.result?.issues?.join("; ") || "See review output"}`).join("\n")}

**All Issues Found**:
${allIssues.map((i: string) => `- ${i}`).join("\n")}

**Action Required**:
1. Address ALL issues from ALL rejecting reviewers
2. Each fix must be verified
3. Re-run will trigger all 8 reviewers again
4. Spec CANNOT complete until ALL 8 approve

This is a non-negotiable quality gate. No exceptions.
            `}
          </Task>
        }
      />
    </Sequence>
  )
}

// =============================================================================
// TICKET PIPELINE
// =============================================================================

function TicketPipeline({ ticket }: { ticket: z.infer<typeof Ticket> }) {
  const ctx = useCtx()
  const report = ctx.latest(tables.report, `${ticket.id}:report`)
  const isComplete = report?.status === "done"
  
  // Check if all deterministic gates passed
  const gateResults = ticket.gates.map(g => 
    ctx.latest(tables.gate, `gate-${ticket.id}-${g}`)
  )
  const allGatesPassed = gateResults.every(g => g?.passed)
  
  // Adaptive: skip LLM review if T3/T4 and all gates passed
  const needsLLMReview = ticket.reviewsRequired.length > 0 && 
                         !(allGatesPassed && (ticket.tier === "T3" || ticket.tier === "T4"))
  
  return (
    <Sequence key={ticket.id} skipIf={isComplete}>
      {/* Phase 1: Implementation */}
      <Task
        id={`implement-${ticket.id}`}
        output={tables.report}
        agent={makeAgent(ticket.model)}
      >
        {`
**Implement**: ${ticket.title}
**Tier**: ${ticket.tier} (${ticket.layersRequired.join(", ")})

**Description**:
${ticket.description}

**Acceptance Criteria**:
${ticket.acceptanceCriteria.map(a => `- ${a}`).join("\n")}

**Compound Engineering Requirements**:
${ticket.layersRequired.includes("L1") ? "- L1: Use branded types, no primitive obsession" : ""}
${ticket.layersRequired.includes("L2") ? "- L2: Add Effect.assert for pre/postconditions" : ""}
${ticket.layersRequired.includes("L3") ? "- L3: DB constraints for critical data" : ""}
${ticket.layersRequired.includes("L4") ? "- L4: @property tests with named invariants" : ""}
${ticket.layersRequired.includes("L5") ? "- L5: Production TODOs for monitoring" : ""}
${ticket.layersRequired.includes("L6") ? "- L6: Document simulation plan" : ""}

Implement the ticket. Commit with conventional commits.
        `}
      </Task>
      
      {/* Phase 2: Deterministic Gates (fast feedback) */}
      <Sequence>
        {ticket.gates.map(g => (
          <DeterministicGate key={g} gate={g} ticket={ticket} />
        ))}
      </Sequence>
      
      {/* Phase 3: Conditional LLM Review */}
      <Branch
        if={needsLLMReview}
        then={
          <Parallel>
            {ticket.reviewsRequired.map(r => (
              <LLMReview key={r} ticket={ticket} reviewerId={r} />
            ))}
          </Parallel>
        }
      />
      
      {/* Phase 4: Report & Learn */}
      <Task
        id={`report-${ticket.id}`}
        output={tables.report}
        outputSchema={Report}
      >
        {`
Generate final report for ticket: ${ticket.id}

Include:
- status: done/blocked/failed
- work: what was implemented
- files: changed files
- tests: test files added/modified
- gates: results from deterministic gates
- issues: any problems encountered
- learning: actualHours, reviewIterations, costEstimateUsd

Cost estimate: ${ticket.tier === "T1" ? "~$5" : ticket.tier === "T2" ? "~$3" : ticket.tier === "T3" ? "~$1" : "~$0.50"}
        `}
      </Task>
    </Sequence>
  )
}

// =============================================================================
// MAIN WORKFLOW
// =============================================================================

export default smithers((ctx) => {
  // Get discovery output
  const discoverOutput = ctx.latest(tables.discover, "discover-output")
  const tickets = discoverOutput?.tickets ?? []
  const batchComplete = discoverOutput?.batchComplete ?? false
  
  // Filter to uncompleted tickets
  const unfinishedTickets = tickets.filter((t: z.infer<typeof Ticket>) => {
    const report = ctx.latest(tables.report, `${t.id}:report`)
    return !report || report.status !== "done"
  })
  
  // Check if all tickets in this batch are done
  const allTicketsDone = tickets.length > 0 && unfinishedTickets.length === 0
  
  // Should we discover more work?
  const needsDiscovery = !discoverOutput || (allTicketsDone && !batchComplete)
  
  return (
    <Workflow name={`dynamic-${spec.id}`}>
      <Sequence>
        {/* Discovery Phase - runs when needed */}
        <Branch if={needsDiscovery} then={<Discover />} />
        
        {/* Implementation Phase - all unfinished tickets */}
        {unfinishedTickets.map((ticket: z.infer<typeof Ticket>) => (
          <TicketPipeline key={ticket.id} ticket={ticket} />
        ))}
        
        {/* Re-render trigger - if batch done but spec not complete */}
        <Branch
          if={allTicketsDone && !batchComplete}
          then={<Task id="trigger-rediscover">{{ trigger: true }}</Task>}
        />
        
        {/* Final Review Gate - ALWAYS runs before spec completion */}
        <Branch
          if={batchComplete && allTicketsDone}
          then={<FinalReview tickets={tickets} />}
        />
        
        {/* Completion marker - only after ALL 8 reviewers approve */}
        <Branch
          if={batchComplete && allTicketsDone && ctx.latest(tables.finalReview, "final-review-summary")?.status === "approved"}
          then={
            <Sequence>
              {/* Commit learnings to VCS */}
              <Task
                id="commit-learnings"
                output={tables.report}
                agent={makeAgent("cheap")}
              >
                {`
Capture and commit learnings for spec "${spec.id}".

Execute in shell:

# Ensure .fabrik directory exists
mkdir -p .fabrik

# Create .gitignore if not exists
if [ ! -f .fabrik/.gitignore ]; then
  echo "# Fabrik learnings - COMMIT THESE
!*.jsonl
!*.md
!*.json" > .fabrik/.gitignore
fi

# Create initial patterns.md if not exists
if [ ! -f .fabrik/patterns.md ]; then
cat > .fabrik/patterns.md << 'PATTERNS'
# Fabrik Patterns

> Auto-generated from execution learnings for ${spec.id}
> Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Summary

- Spec: ${spec.id}
- Tickets executed: ${tickets.length}
- Status: Initial learnings captured

## Notes

This file will be updated with extracted patterns as more specs are executed with --learn.

---

*Commit this file to share learnings with the team.*
PATTERNS
fi

# Stage and commit
if command -v jj &> /dev/null; then
  jj add .fabrik/
  jj describe -m "fabrik: learnings from ${spec.id}

- ${tickets.length} tickets executed
- Patterns captured in .fabrik/
- Auto-generated

[skip ci]"
  echo "Learnings staged. Push with: jj git push --change @"
elif command -v git &> /dev/null; then
  git add .fabrik/
  git commit -m "fabrik: learnings from ${spec.id}

- ${tickets.length} tickets executed
- Patterns captured in .fabrik/
- Auto-generated

[skip ci]" || echo "Nothing to commit"
  echo "Learnings committed. Push with: git push"
else
  echo "Learnings saved to .fabrik/ (no VCS detected)"
fi

ls -la .fabrik/
                `}
              </Task>
              
              <Task id="complete" output={tables.report}>
                {{
                  v: 1,
                  taskId: "spec-complete",
                  tier: "T1",
                  status: "done",
                  work: [
                    "Spec fully implemented via dynamic discovery",
                    "ALL 8 reviewers approved (mandatory gate)",
                    "Learnings committed to VCS"
                  ],
                  files: [],
                  tests: [],
                  gates: [],
                  issues: [],
                  next: []
                }}
              </Task>
            </Sequence>
          }
        />
      </Sequence>
    </Workflow>
  )
})

function basename(p: string): string {
  return p.split("/").pop() || p
}

// =============================================================================
// LEARNING CAPTURE FUNCTIONS
// =============================================================================

const FABRIK_DIR = ".fabrik"
const LEARNINGS_FILE = `${FABRIK_DIR}/learnings.jsonl`
const PATTERNS_FILE = `${FABRIK_DIR}/patterns.md`

type Learning = {
  timestamp: string
  specId: string
  ticketId: string
  tier: "T1" | "T2" | "T3" | "T4"
  prediction: {
    estimatedHours: number
    reviewsRequired: string[]
    modelUsed: string
    gatesRequired: string[]
  }
  actual: {
    hoursSpent: number
    reviewIterations: number
    issuesFound: string[]
    gatesPassed: boolean
  }
  effectiveness: "over-engineered" | "appropriate" | "under-engineered"
  costUsd: number
}

function ensureFabrikDir() {
  if (!existsSync(FABRIK_DIR)) {
    mkdirSync(FABRIK_DIR, { recursive: true })
    // Create .gitignore to ensure we commit these
    writeFileSync(
      join(FABRIK_DIR, ".gitignore"),
      "# Fabrik learnings - COMMIT THESE\n!*.jsonl\n!*.md\n!*.json\n"
    )
  }
}

function recordLearning(learning: Learning) {
  ensureFabrikDir()
  const line = JSON.stringify(learning) + "\n"
  appendFileSync(LEARNINGS_FILE, line)
}

function generatePatternsMd(specId: string, ticketCount: number): string {
  const timestamp = new Date().toISOString()
  return `# Fabrik Patterns

> Auto-generated from execution learnings for ${specId}
> Last updated: ${timestamp}

## Summary

- Spec: ${specId}
- Tickets executed: ${ticketCount}
- Status: Patterns will be extracted after more learnings accumulate

## Initial Pattern

Based on first execution, the following pattern is proposed:

| Attribute | Value |
|-----------|-------|
| Tier | Varies by task (T1-T4) |
| Reviews | Adaptive based on tier |
| Model | Tier-based selection |
| Gates | lint, typecheck, build, test |

Run more specs with --learn to accumulate patterns.

---

*This file will be updated with extracted patterns after 3+ learnings.*
`
}

function commitLearningsToVCS(specId: string, ticketCount: number): string {
  try {
    ensureFabrikDir()
    
    // Generate patterns.md
    const patternsContent = generatePatternsMd(specId, ticketCount)
    writeFileSync(PATTERNS_FILE, patternsContent)
    
    // Check if we're in a jj or git repo
    const isJj = existsSync(".jj")
    const isGit = existsSync(".git")
    
    if (!isJj && !isGit) {
      return "No VCS found - learnings saved locally only"
    }
    
    // Stage files
    if (isJj) {
      // Use echo to show what would happen (can't actually run jj in agent context)
      return `Learnings captured:\n- ${LEARNINGS_FILE}\n- ${PATTERNS_FILE}\n\nTo commit manually:\n  jj add ${FABRIK_DIR}/\n  jj describe -m "fabrik: learnings from ${specId}"\n  jj git push --change @`
    } else {
      return `Learnings captured:\n- ${LEARNINGS_FILE}\n- ${PATTERNS_FILE}\n\nTo commit manually:\n  git add ${FABRIK_DIR}/\n  git commit -m "fabrik: learnings from ${specId}"\n  git push`
    }
  } catch (error) {
    return `Error capturing learnings: ${error}`
  }
}
