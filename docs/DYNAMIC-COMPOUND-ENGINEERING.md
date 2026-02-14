# Dynamic Compound Engineering

> Plan thoroughly. Review rigorously. Codify knowledge. **Adapt intelligently.** Compound quality.

An adaptive workflow that combines dynamic ticket discovery with compound engineering principles, learning from each execution to optimize cost/quality balance.

## Core Philosophy

```
Traditional:  Spec → Hardcoded Todo → All Tasks → All Reviews → Done
Dynamic CE:   Spec → Discover → Adaptive Pipeline → Learn → Compound
```

**Key Insight**: Not every task needs the full 8-reviewer pipeline. T4 analytics tasks don't need NASA-10-RULES review. T1 money-critical code needs everything.

## The Adaptive Cycle

### 1. Discovery Phase

An agent analyzes the markdown spec + existing codebase to generate the next batch of 3-5 tickets:

```typescript
// Dynamic discovery with tier classification
export type DiscoveredTicket = {
  id: string                    // kebab-case: "implement-chinese-zodiac-api"
  title: string
  tier: "T1" | "T2" | "T3" | "T4"
  description: string
  acceptanceCriteria: string[]
  dependencies: string[]
  
  // Compound Engineering: Layer requirements
  layersRequired: ("L1" | "L2" | "L3" | "L4" | "L5" | "L6")[]
  
  // Adaptive: Reviews needed (not hardcoded)
  reviewsRequired: ReviewerId[]
  
  // Deterministic backpressure gates
  gates: ("lint" | "typecheck" | "build" | "test" | "coverage")[]
  
  // LLM as judge only when deterministic gates pass
  llmReviewThreshold: "auto" | "always" | "never"
  
  // Model selection based on criticality
  model: "cheap" | "standard" | "powerful"  // kimi-k2-5 vs gpt-5 vs opus
}
```

### 2. Adaptive Pipeline Per Tier

**T1 (Critical: Money, Auth, Irreversible State)**
```
Discover → Research → Plan → Implement → 
  [lint, typecheck, build, test:unit, test:property, coverage:90%] →  // Deterministic
  LLM Review [security, correctness, nasa-10, test-coverage] →        // Expensive
  Human Gate
```

**T2 (Important: User Data, Business Logic)**
```
Discover → Research → Plan → Implement →
  [lint, typecheck, build, test:unit, coverage:85%] →
  LLM Review [security, code-quality, test-coverage] →
  Human Gate (optional)
```

**T3 (Standard: Features, UI)**
```
Discover → Implement →
  [lint, typecheck, build, test:unit, coverage:80%] →
  LLM Review [code-quality] (if gates fail) →
  Auto-merge (if all green)
```

**T4 (Low: Analytics, Logging)**
```
Discover → Implement →
  [lint, typecheck, build] →
  Auto-merge
```

### 3. Learning Layer

After each ticket completes, capture:

```typescript
export type Learning = {
  ticketId: string
  tier: Tier
  
  // What was predicted
  predicted: {
    estimatedHours: number
    reviewsRequired: ReviewerId[]
    modelUsed: string
  }
  
  // What actually happened
  actual: {
    hoursSpent: number
    reviewIterations: number
    issuesFound: string[]
    bugsInProduction: boolean
  }
  
  // Adaptation signal
  effectiveness: "over-engineered" | "appropriate" | "under-engineered"
  
  // Pattern extraction
  patternLearned?: string  // "T4 logging tasks never need security review"
}
```

### 4. Compound Knowledge

Learnings feed back into:

1. **Repo-specific patterns** (`.fabrik/patterns.md`)
   ```markdown
   ## Learned Patterns
   
   ### T4 Analytics Tasks
   - Never need security review
   - Can skip L2 assertions (just L1 types)
   - Model: kimi-k2-5 sufficient
   
   ### T1 Money Operations
   - Always need property tests for conservation
   - L6 simulation required even for "simple" changes
   - 3+ review iterations typical
   ```

2. **Fabrik global optimization** (cross-repo learning)
   ```typescript
   // Global tier/review model
   export const globalPatterns = {
     "auth-middleware": { reviews: ["security", "correctness"], model: "powerful" },
     "ui-styling": { reviews: [], model: "cheap" },
     "api-endpoint": { reviews: ["code-quality"], model: "standard" }
   }
   ```

3. **Discover prompt refinement**
   - If T1 task had bugs in production → strengthen discover prompt for similar tasks
   - If T4 task got 8 reviews → update prompt to recommend fewer

## Implementation: Adaptive Discover Component

```tsx
// scripts/smithers-discover.tsx
import { z } from "zod"
import { Task, useCtx, tables } from "smithers-orchestrator"

const Ticket = z.object({
  id: z.string().describe("kebab-case identifier"),
  title: z.string(),
  tier: z.enum(["T1", "T2", "T3", "T4"]),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  dependencies: z.array(z.string()).nullable(),
  layersRequired: z.array(z.enum(["L1", "L2", "L3", "L4", "L5", "L6"])),
  reviewsRequired: z.array(z.string()).describe("Based on tier and patterns"),
  gates: z.array(z.enum(["lint", "typecheck", "build", "test", "coverage"])),
  model: z.enum(["cheap", "standard", "powerful"])
})

export function Discover({ 
  specMarkdown, 
  previousLearnings 
}: { 
  specMarkdown: string
  previousLearnings: Learning[] 
}) {
  const ctx = useCtx()
  
  // Load learned patterns from repo
  const patterns = loadRepoPatterns()
  
  // Get completed tickets from this run
  const completedTickets = ctx
    .latestArray(tables.discover, "discover-output")
    ?.filter(t => ctx.latest(tables.report, `${t.id}:report`))
    ?.map(t => t.id) ?? []

  return (
    <Task 
      id="discover" 
      output={tables.discover}
      agent={codex}  // Powerful model for planning
      schema={z.object({ tickets: z.array(Ticket).max(5) })}
    >
      {`
        ## Context
        
        Spec: ${specMarkdown}
        
        Previously Completed: ${completedTickets.join(", ") || "none"}
        
        Learned Patterns:
        ${patterns.map(p => `- ${p.taskType}: tier=${p.tier}, reviews=[${p.reviews.join(",")}], model=${p.model}`).join("\n")}
        
        ## Discovery Instructions
        
        Generate the next 0-5 tickets. Consider:
        
        1. **What's already done**: Don't rediscover completed work
        2. **Codebase state**: Read relevant files to see what's implemented
        3. **Tier classification**: Use compound engineering tiers
        4. **Review optimization**: Based on patterns, don't over-review T3/T4
        5. **Model selection**: Cheap for T4, Powerful for T1
        
        6-Layer Guarantee System:
        - L1 (Types): Branded types, phantom types, strict schemas
        - L2 (Runtime): Effect.assert for pre/postconditions
        - L3 (Persistence): DB constraints, uniqueness, CHECK
        - L4 (Tests): @property tests, coverage thresholds
        - L5 (Monitoring): Production TODOs, alert conditions
        - L6 (Simulation): 24/7 seed-based testing (T1 only)
        
        ## Output
        
        Return tickets as JSON with tier, layers, reviews, gates, and model.
        Be conservative on tier (better safe) but aggressive on review minimization.
      `}
    </Task>
  )
}
```

## Adaptive TicketPipeline

```tsx
// scripts/smithers-ticket-pipeline.tsx
export function TicketPipeline({ ticket }: { ticket: DiscoveredTicket }) {
  const ctx = useCtx()
  const report = ctx.latest(tables.report, `${ticket.id}:report`)
  const isComplete = report != null
  
  // Dynamic gate selection based on ticket.gates
  const GateSequence = () => (
    <Sequence>
      {ticket.gates.includes("lint") && <DeterministicGate id="lint" cmd="bun run lint" />}
      {ticket.gates.includes("typecheck") && <DeterministicGate id="typecheck" cmd="bun run typecheck" />}
      {ticket.gates.includes("build") && <DeterministicGate id="build" cmd="bun run build" />}
      {ticket.gates.includes("test") && <DeterministicGate id="test" cmd="bun run test" />}
      {ticket.gates.includes("coverage") && <DeterministicGate id="coverage" cmd="bun run test:coverage" min={ticket.tier === "T1" ? 90 : ticket.tier === "T2" ? 85 : 80} />}
    </Sequence>
  )
  
  // Conditional LLM review only if needed
  const MaybeLLMReview = () => {
    if (ticket.reviewsRequired.length === 0) return null
    
    // Skip LLM review if all deterministic gates passed AND tier is T3/T4
    const allGatesPassed = ticket.gates.every(g => ctx.latest(tables.gate, `${ticket.id}:${g}`)?.passed)
    if (allGatesPassed && (ticket.tier === "T3" || ticket.tier === "T4")) {
      return <AutoApprove ticketId={ticket.id} />
    }
    
    return (
      <Parallel>
        {ticket.reviewsRequired.map(reviewer => (
          <LLMReview 
            key={reviewer} 
            ticketId={ticket.id} 
            reviewer={reviewer}
            model={ticket.model === "cheap" ? "kimi-k2-5" : ticket.model === "standard" ? "gpt-5" : "opus"}
          />
        ))}
      </Parallel>
    )
  }
  
  return (
    <Sequence key={ticket.id} skipIf={isComplete}>
      <Research ticket={ticket} />
      <Plan ticket={ticket} />
      <Implement ticket={ticket} tier={ticket.tier} layers={ticket.layersRequired} />
      <GateSequence />
      <MaybeLLMReview />
      <Report ticket={ticket} />
    </Sequence>
  )
}
```

## Deterministic Backpressure vs LLM Judge

Maximize fast/cheap deterministic checks before expensive LLM review:

```
Fast Feedback Loop (< 30 seconds):
  ├── eslint --max-warnings=0
  ├── tsc --noEmit
  ├── build
  └── quick unit tests (happy path)
  
If all pass → T3/T4 auto-approve, T1/T2 continue to LLM

Slow Feedback Loop (LLM, $$$):
  ├── Deep security analysis
  ├── Correctness proofs
  └── Property test generation

If deterministic fails → Fix immediately, no LLM cost wasted
```

## Model Selection Strategy

```typescript
const modelSelection = {
  // Discovery/Planning (high-quality reasoning)
  discover: "powerful",    // opus / gpt-5
  
  // Implementation by tier
  "T1-implement": "powerful",
  "T2-implement": "standard",  // gpt-5
  "T3-implement": "standard",
  "T4-implement": "cheap",     // kimi-k2-5
  
  // Review by type
  "security-review": "powerful",
  "correctness-review": "powerful",
  "code-quality-review": "standard",
  "simplicity-review": "cheap",
}
```

## Command Line Interface

```bash
# Traditional (hardcoded todo)
./dist/fabrik run --spec spec.md --todo spec.todo.json --vm ralph-1

# Dynamic discovery with compound engineering
./dist/fabrik run --spec spec.md --dynamic --vm ralph-1

# With learning capture
./dist/fabrik run --spec spec.md --dynamic --learn --vm ralph-1

# Show learned patterns for this repo
./dist/fabrik patterns show

# Global fabrik optimization stats
./dist/fabrik stats --global
```

## File Structure

```
repo/
├── specs/
│   └── feature.md              # Markdown spec (no JSON needed!)
├── .fabrik/
│   ├── patterns.md            # Repo-specific learned patterns
│   ├── learnings.jsonl        # Raw learning data
│   └── optimization.log       # Cost/quality tradeoff decisions
└── .smithers/
    └── feature.db               # Smithers orchestration state
```

## Success Metrics

Track over time:

| Metric | Target | Measurement |
|--------|--------|-------------|
| Review Efficiency | < 50% of T3/T4 get LLM review | Learnings prevent over-review |
| Bug Escape Rate | 0 T1 bugs in production | L6 simulation catches edge cases |
| Cost per Ticket | T4: $0.50, T1: $5.00 | Model selection + gate optimization |
| Cycle Time | T4: 30min, T1: 4hrs | Deterministic gates are fast |
| Pattern Accuracy | > 80% correct tier prediction | Discover learns from feedback |

## Open Questions (Becoming Answers)

From `open-questions.md`:

1. **How do we learn?** → Learnings JSONL + pattern extraction + prompt refinement
2. **How does system improve?** → Global fabrik stats + cross-repo pattern sharing
3. **How many reviews?** → Tier-based adaptive selection, not fixed 8
4. **Deterministic vs LLM?** → Gates first, LLM only when needed
5. **Which model when?** → Tier + task-type → model mapping

This is adaptive compound engineering: **rigorous where needed, efficient where possible, learning always.**
