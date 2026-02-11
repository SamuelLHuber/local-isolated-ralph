# PRD: Fabrik LLM Benchmark & Tribunal System

## Overview

Add comprehensive metrics collection and benchmarking capabilities to Fabrik/Smithers. Track every LLM inference across three dimensions (harness × provider × model) with granular token usage, timing, and context metrics. Enable comparison of providers, harnesses, and models through automated benchmark scenarios with tribunal review scoring.

## User Stories

### As a Platform Engineer (Infrastructure)
**I want to** know how many concurrent Ralph agents my infrastructure can support  
**So that** I can provision appropriate resources and avoid overloading providers  
**Acceptance:** Can run load tests with increasing concurrency (1, 2, 4, 8, ... 100) and measure throughput degradation

### As a DevOps Engineer (Cost Optimization)
**I want to** compare token costs across providers for the same quality level  
**So that** I can route traffic to the most cost-effective provider  
**Acceptance:** Can query "For specs requiring 0.8+ security score, which provider has lowest billed tokens?"

### As a Product Manager (Quality Tracking)
**I want to** see if model quality degrades over time or across versions  
**So that** I can decide when to upgrade/downgrade models  
**Acceptance:** Can chart tribunal scores for "claude-3-opus" over 90 days

### As an AI Engineer (Performance Tuning)
**I want to** know my cache hit rates and which prompts benefit from caching  
**So that** I can optimize prompts and reduce costs  
**Acceptance:** Can see cache hit rate by task type and identify low-hit patterns

### As a Security Engineer (Reliability)
**I want to** track error rates and rate limiting per provider  
**So that** I can identify unreliable providers and set up failover  
**Acceptance:** Can query error rate by provider and error type (timeout, rate_limit, auth_error)

### As a Developer (Debugging)
**I want to** see exactly which provider endpoint and model version was used  
**So that** I can reproduce bugs and benchmark results  
**Acceptance:** Every run stores provider config (endpoint URL, region, model) in SQLite

### As a CI/CD Engineer (Regression Testing)
**I want to** run benchmarks automatically on PRs and block if quality drops  
**So that** bad model/provider changes don't reach production  
**Acceptance:** Can run `fabrik benchmark` in CI and exit non-zero if thresholds not met

## Goals

### Primary Goals
- Collect standardized metrics on every run to enable analysis across harness/provider/model combinations
- Support both benchmark-specific runs and automatic metric collection from regular fabrik runs
- Provide granular token accounting including cache hits/misses and reasoning tokens
- Aggregate scores from multiple review dimensions (security, maintainability, elegance, etc.)

### Implicit Goals (Now Explicit)

**Infrastructure Capacity Planning**
Measure concurrent execution capacity at different loads (1, 2, 4, 8, ... 1000 parallel calls) to determine infrastructure limits. Answer: "How many parallel Ralph agents can this provider/infrastructure support?"

**Cache Effectiveness Optimization**
Track cache hit/miss rates over time to optimize prompt caching strategies. Identify which prompts benefit from caching and optimal cache sizes.

**Provider Reliability Analysis**
Track error patterns, rate limiting frequency, and retry behavior per provider. Identify which providers are most reliable for production workloads.

**Historical Trend Analysis**
Store metrics in queryable format (SQLite + JSONL) to answer: "Has GPT-4 gotten slower over the past month?" or "Did our cache hit rate improve after prompt changes?"

**Cost-Performance Optimization**
Find the cheapest provider for acceptable quality levels. Determine when local inference (vLLM) becomes cost-effective vs cloud APIs. Optimize for token efficiency.

**Non-Disruptive Integration**
Metrics collection must not slow down or break existing Fabrik runs. Must avoid "nested state update loops" that caused previous attempts to be disabled.

**Reproducibility**
Store exact provider configuration (endpoint URLs, regions, model versions) so benchmark runs can be reproduced identically for regression testing.

**Task Efficiency Metrics**
Track "iterations needed" (how many loops through task list) as a quality metric. Fewer iterations = better model performance. Compare efficiency across models/providers.

## Three Dimensions of Analysis

Every inference is tagged with three independent dimensions:

| Dimension | Description | Source |
|-----------|-------------|--------|
| **Harness** | Client tool calling the LLM | Smithers component (`<Codex>`, `<Claude>`, `<OpenCode>`) |
| **Provider** | API endpoint serving the model | Environment config (`OPENAI_BASE_URL`, provider detection) |
| **Model** | Specific LLM being used | `SMITHERS_MODEL` env var |

This enables analysis like:
- Same model via different providers (OpenAI vs Azure)
- Different harnesses on same provider (Codex vs Claude Code on Anthropic API)
- Cost/performance of local vs cloud inference

## What Smithers Provides

**Existing infrastructure we leverage:**

1. **Agent Components** - `<Codex>`, `<Claude>`, `<OpenCode>` with `onFinished` callbacks
2. **Result Objects** - `result.output` (response text), `result.tokensUsed` (when available)
3. **SQLite State DB** - `reactiveDb` for persistence across workflow steps
4. **Phase Tracking** - `phase` state (tasks → review → review-tasks → done)
5. **Iteration Tracking** - `index` state tracks position in task list
6. **Report Output** - Writes JSON reports to `reports/<run-id>/`

**What we add:**
- Capture timestamps in `onFinished` handlers (no new components)
- Extract token usage from result objects (provider-specific parsing)
- Write metrics to existing SQLite DB (new tables)
- Export metrics JSON alongside existing reports
- Benchmark spec schema for multi-scenario runs

## Metrics to Collect

### Per-Inference

Captured in every `onFinished` callback:

```typescript
{
  // Identity
  inferenceId: string;        // UUID
  runId: string;              // From SMITHERS_RUN_ID
  timestamp: string;          // ISO 8601 completion time
  
  // Three dimensions
  harness: "codex" | "claude" | "opencode";
  provider: "openai" | "anthropic" | "azure-openai" | "local-vllm" | ...;
  model: string;              // "gpt-4", "claude-3-opus", etc.
  
  // Context
  phase: "task" | "review" | "review-task";
  taskId: string;             // Current task ID
  iteration: number;          // How many times through task list
  
  // Timing (captured via performance.now() in onFinished)
  durationMs: number;         // Total time (start → finish)
  timeToFirstTokenMs: number; // If streaming available
  
  // Tokens (extracted from result.tokensUsed or response headers)
  tokens: {
    input: number;
    cacheRead: number;        // Cache hits (OpenAI, Anthropic)
    cacheWrite: number;       // Cache misses (Anthropic)
    output: number;
    reasoning: number;        // o1, Claude extended thinking
    total: number;
    billed: number;
  };
  
  // Context window
  contextUsed: number;        // input + output
  contextAvailable: number;   // Model limit (from model name)
  
  // Result
  status: "success" | "error" | "rate_limited" | "timeout";
  error?: string;
}
```

### Per-Run

Aggregated at run completion:

```typescript
{
  runId: string;
  specId: string;
  harness: string;
  provider: string;
  model: string;
  
  startedAt: string;
  completedAt: string;
  durationMs: number;
  
  totalTasks: number;
  tasksCompleted: number;
  totalIterations: number;    // Total task executions across all loops
  
  // Token aggregates
  tokens: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    total: number;
    billed: number;
  };
  
  // Statistics
  contextStats: { min: number; max: number; avg: number; p95: number; };
  performanceStats: {
    avgTokensPerSecond: number;
    avgTimeToFirstTokenMs: number;
  };
  
  // Raw inference log (optional for large runs)
  inferences?: InferenceMetrics[];
  
  // Tribunal scores (after review phase)
  tribunalScores?: Record<string, number>;
}
```

### How Metrics Enable Goals

| Goal | Key Metrics | Query Example |
|------|-------------|---------------|
| **Infrastructure Capacity** | `durationMs`, `tokensPerSecond`, concurrent run tracking | "What's throughput at 16 parallel calls?" |
| **Cache Effectiveness** | `cacheRead`, `cacheWrite`, `cacheRead / (cacheRead + cacheWrite)` | "Cache hit rate by prompt type over 30 days" |
| **Provider Reliability** | `status`, `error`, rate limiting detection | "Error rate by provider, last 7 days" |
| **Historical Trends** | `timestamp`, all metrics | "Has GPT-4 latency increased?" |
| **Cost Optimization** | `billed` tokens × provider pricing | "Cheapest provider for 0.8+ quality score" |
| **Reproducibility** | `providerConfig` (endpoint, region, model version) | "Re-run benchmark with same config" |
| **Task Efficiency** | `totalIterations`, `tasksCompleted` | "Which model needs fewest iterations?" |

## Token Provider Formats

We extract tokens from provider-specific response formats:

**OpenAI / Azure OpenAI:**
```json
{
  "usage": {
    "prompt_tokens": 2048,
    "completion_tokens": 512,
    "prompt_tokens_details": {
      "cached_tokens": 1024
    },
    "completion_tokens_details": {
      "reasoning_tokens": 128
    }
  }
}
```

**Anthropic:**
```json
{
  "usage": {
    "input_tokens": 2048,
    "output_tokens": 512,
    "cache_read_input_tokens": 1024,
    "cache_creation_input_tokens": 1024
  }
}
```

**Local (vLLM, Ollama):**
```json
{
  "usage": {
    "prompt_tokens": 2048,
    "completion_tokens": 512
    // No cache/reasoning breakdown
  }
}
```

## SQLite Schema Additions

Add to existing Smithers SQLite DB:

```sql
-- Per-inference metrics
CREATE TABLE inference_metrics (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  harness TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  phase TEXT NOT NULL,
  task_id TEXT,
  iteration INTEGER DEFAULT 0,
  duration_ms INTEGER,
  ttft_ms INTEGER,
  input_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  billed_tokens INTEGER DEFAULT 0,
  context_used INTEGER DEFAULT 0,
  context_available INTEGER DEFAULT 8192,
  status TEXT,
  error TEXT
);

-- Run-level aggregates
CREATE TABLE run_metrics (
  run_id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  total_tasks INTEGER DEFAULT 0,
  tasks_completed INTEGER DEFAULT 0,
  total_iterations INTEGER DEFAULT 0,
  total_input_tokens INTEGER DEFAULT 0,
  total_cache_read_tokens INTEGER DEFAULT 0,
  total_cache_write_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_reasoning_tokens INTEGER DEFAULT 0,
  total_billed_tokens INTEGER DEFAULT 0,
  avg_tokens_per_second REAL DEFAULT 0,
  avg_ttft_ms REAL DEFAULT 0,
  tribunal_scores TEXT  -- JSON blob
);

-- Indexes
CREATE INDEX idx_inference_run ON inference_metrics(run_id);
CREATE INDEX idx_inference_provider ON inference_metrics(provider, model);
CREATE INDEX idx_inference_harness ON inference_metrics(harness);
```

## Spec Schema Extensions

Add optional `benchmarks` array to any spec:

```json
{
  "benchmarks": [{
    "name": "provider-comparison",
    "description": "Compare OpenAI vs Azure vs local",
    "iterations": 3,
    "timeoutSeconds": 300,
    
    "scenarios": [
      {
        "name": "openai-gpt4",
        "harness": "codex",
        "provider": "openai",
        "model": "gpt-4",
        "env": {
          "OPENAI_API_KEY": "${OPENAI_API_KEY}"
        }
      },
      {
        "name": "azure-gpt4",
        "harness": "codex",
        "provider": "azure-openai",
        "model": "gpt-4",
        "env": {
          "AZURE_OPENAI_API_KEY": "${AZURE_KEY}",
          "AZURE_OPENAI_ENDPOINT": "https://myaccount.openai.azure.com"
        }
      },
      {
        "name": "local-llama",
        "harness": "codex",
        "provider": "local-vllm",
        "model": "llama-3.1-70b",
        "env": {
          "OPENAI_BASE_URL": "http://localhost:8000/v1"
        }
      }
    ],
    
    "reviewPrompts": [
      { "id": "security", "promptPath": "@benchmark/prompts/security.md" },
      { "id": "maintainability", "promptPath": "@benchmark/prompts/maintainability.md" }
    ],
    
    "thresholds": {
      "minSecurityScore": 0.8,
      "maxAvgDurationMs": 60000
    }
  }]
}
```

## Environment Variables

```bash
# Core configuration
DISABLE_METRICS=1              # Opt-out of metrics collection
BENCHMARK_RETENTION_DAYS=90    # How long to keep JSONL files
METRICS_DB_PATH=./reports/metrics.db  # SQLite path (default: same as Smithers)

# Provider detection (existing)
SMITHERS_MODEL=gpt-4
SMITHERS_AGENT=codex
OPENAI_BASE_URL=https://api.openai.com/v1  # Used to detect provider
ANTHROPIC_BASE_URL=https://api.anthropic.com

# Benchmark-specific
BENCHMARK_SCENARIO=openai-gpt4  # Set by benchmark runner
BENCHMARK_PROVIDER=openai       # Explicit provider override
BENCHMARK_ITERATION=0           # Current iteration number
```

## File Locations

```
local-isolated-ralph/
├── scripts/
│   └── smithers-spec-runner.tsx     # MODIFY: Add metrics collection
├── benchmark/
│   ├── smithers-benchmark.tsx       # NEW: Benchmark workflow
│   └── prompts/                     # EXISTING: Tribunal prompts
├── specs/
│   └── 030-benchmark-system.md      # This spec
└── reports/
    ├── <run-id>/
    │   ├── task-001.report.json
    │   └── metrics.json              # NEW: Run metrics export
    └── benchmark-<name>-<ts>/
        ├── report/
        │   └── benchmark-report.json
        └── runs/
            └── <scenario>-run-0/
                └── metrics.json
```

## Implementation Approach

### Phase 1: Metrics in Smithers Core

**File: `scripts/smithers-spec-runner.tsx`**

Add at top of file:

**Import statements to add:**
```typescript
import { performance } from "node:perf_hooks";

// Metrics disabled check
const METRICS_ENABLED = !process.env.DISABLE_METRICS;
```

**1. Add timing capture in `handleFinished` callbacks:**

Find all `handleFinished` definitions (task and review-task phases). Modify each:

```typescript
// Before existing handleFinished
const startTime = performance.now();
const inferenceId = crypto.randomUUID();

const handleFinished = (result: { output?: string }) => {
  // ... existing error handling (rate limits, etc.) ...
  
  // NEW: Record metrics (after error handling, before state updates)
  if (METRICS_ENABLED) {
    try {
      const durationMs = performance.now() - startTime;
      const tokens = extractTokens(result, detectProvider());
      const iteration = calculateIteration(index, todo.tasks.length);
      
      recordInference({
        id: inferenceId,
        runId: env.SMITHERS_RUN_ID || "",
        harness: agentKind as Harness,
        provider: detectProvider(),
        model: model,
        phase: phase as Phase,
        taskId: task?.id,
        iteration,
        durationMs,
        tokens,
        status: result.output ? "success" : "error",
      });
    } catch (metricsError) {
      // Log but don't fail the run
      console.error("[Metrics] Failed to record:", metricsError);
    }
  }
  
  // ... rest of existing handleFinished logic ...
};
```

**2. Add token extraction function:**

Add near top of file, after imports:

```typescript
function extractTokens(result: unknown, provider: string) {
  const empty = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, billed: 0 };
  
  if (!result || typeof result !== "object") return empty;
  const r = result as Record<string, unknown>;
  const usage = (r.tokensUsed || r.usage) as Record<string, unknown> | undefined;
  
  if (!usage) return empty;
  
  if (provider === "anthropic") {
    return {
      input: Number(usage.input_tokens) || 0,
      output: Number(usage.output_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
      cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
      reasoning: 0, // Phase 2: detect from response content
      total: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
      billed: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
    };
  }
  
  // OpenAI / local format
  const promptTokens = Number(usage.prompt_tokens) || Number(usage.input_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || Number(usage.output_tokens) || 0;
  const details = usage.prompt_tokens_details as Record<string, number> | undefined;
  const completionDetails = usage.completion_tokens_details as Record<string, number> | undefined;
  
  return {
    input: promptTokens,
    cacheRead: details?.cached_tokens || 0,
    cacheWrite: 0,
    output: completionTokens,
    reasoning: completionDetails?.reasoning_tokens || 0,
    total: promptTokens + completionTokens,
    billed: promptTokens + completionTokens,
  };
}
```

**3. Add provider detection:**

```typescript
function detectProvider(): string {
  if (process.env.BENCHMARK_PROVIDER) return process.env.BENCHMARK_PROVIDER;
  
  const baseUrl = process.env.OPENAI_BASE_URL || "";
  if (baseUrl.includes("azure")) return "azure-openai";
  if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) return "local-vllm";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
}
```

**4. Add iteration calculation:**

```typescript
function calculateIteration(taskIndex: number, totalTasks: number): number {
  return Math.floor(taskIndex / Math.max(1, totalTasks));
}
```

**5. Add metrics recording function:**

```typescript
function recordInference(metrics: InferenceMetrics) {
  // Write to SQLite (using existing Smithers reactiveDb)
  try {
    db.prepare(`
      INSERT INTO inference_metrics 
      (id, run_id, timestamp, harness, provider, model, phase, task_id, iteration, 
       duration_ms, input_tokens, cache_read_tokens, cache_write_tokens, 
       output_tokens, reasoning_tokens, total_tokens, billed_tokens, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      metrics.id,
      metrics.runId,
      new Date().toISOString(),
      metrics.harness,
      metrics.provider,
      metrics.model,
      metrics.phase,
      metrics.taskId || null,
      metrics.iteration,
      Math.round(metrics.durationMs),
      metrics.tokens.input,
      metrics.tokens.cacheRead,
      metrics.tokens.cacheWrite,
      metrics.tokens.output,
      metrics.tokens.reasoning,
      metrics.tokens.total,
      metrics.tokens.billed,
      metrics.status
    );
  } catch (error) {
    console.error("[Metrics] SQLite insert failed:", error);
  }
}
```

**6. Export metrics.json at run completion:**

Find where reports are written (near end of workflow). Add:

```typescript
// After run completes, export metrics
if (METRICS_ENABLED) {
  try {
    const runMetrics = aggregateRunMetrics(runId);
    writeFileSync(
      join(reportDir, "metrics.json"),
      JSON.stringify(runMetrics, null, 2)
    );
  } catch (exportError) {
    console.error("[Metrics] Export failed:", exportError);
  }
}
```

### Phase 2: Benchmark Workflow

Create `@benchmark/smithers-benchmark.tsx`:

1. Parse spec, extract `benchmarks` array
2. For each scenario:
   - Set `SMITHERS_MODEL`, harness-specific env vars
   - Run spec via standard Smithers workflow
   - Collect run metrics from SQLite
3. Run tribunal reviews in parallel
4. Aggregate across iterations
5. Generate `benchmark-report.json`

### Phase 3: Tribunal

Reuse existing `smithers-reviewer.tsx`:

1. For each judge in `reviewPrompts`:
   - Call reviewer with prompt file
   - Collect JSON score (0-1)
2. Aggregate: avg, min, max, std dev across runs
3. Check thresholds, determine pass/fail

## File Outputs

```
reports/
  <run-id>/
    task-001.report.json       # Existing
    review.json                # Existing
    metrics.json               # NEW: RunMetrics
  
  benchmark-<name>-<timestamp>/
    report/
      benchmark-report.json    # NEW: BenchmarkReport
    runs/
      <scenario>-run-0/
        metrics.json
        ...
```

## CLI Usage

### Regular Runs
```bash
# Metrics auto-collected, no performance impact
fabrik run --spec specs/feature.json
# Output: reports/<run-id>/metrics.json
```

### Benchmark Runs
```bash
# Run defined scenarios
fabrik run \
  --spec specs/benchmark.min.json \
  --config @benchmark/smithers-benchmark.tsx \
  --output reports/benchmark-001

# Override iterations
fabrik run \
  --spec specs/benchmark.min.json \
  --config @benchmark/smithers-benchmark.tsx \
  --output reports/benchmark-002 \
  --iterations 5
```

### Historical Queries (Phase 2)
```bash
# Compare provider performance
fabrik metrics query \
  --provider openai \
  --model gpt-4 \
  --metric avg-duration \
  --since "30 days ago"

# Cache effectiveness
fabrik metrics query \
  --provider anthropic \
  --metric cache-hit-rate \
  --group-by day

# Cost analysis
fabrik metrics query \
  --metric billed-tokens \
  --group-by provider \
  --since "7 days ago"

# Error patterns
fabrik metrics query \
  --metric error-rate \
  --group-by provider \
  --status error

# Iteration efficiency
fabrik metrics query \
  --model claude-3-opus \
  --metric avg-iterations \
  --spec-id "spec-001"

# Export for analysis
fabrik metrics export \
  --format csv \
  --output benchmark-data.csv \
  --since "2026-01-01"
```

## Success Criteria

### Metrics Collection
- [ ] Every inference writes to SQLite with timing + tokens
- [ ] `metrics.json` exported alongside existing reports
- [ ] Token extraction works for OpenAI, Anthropic, local providers
- [ ] Metrics collection does not slow down existing runs (< 1ms overhead per inference)
- [ ] No "nested state update loops" errors when collecting metrics

### Benchmark System
- [ ] Benchmark runs execute multiple scenarios with env injection
- [ ] Tribunal aggregates scores from 8 judges
- [ ] Can query: "Avg TTFT for Claude via Claude harness vs Codex harness on Anthropic API"
- [ ] Spec validation includes benchmark schema

### Implicit Goals (Explicit Validation)
- [ ] Can load test: "What throughput at 16 concurrent calls?"
- [ ] Cache hit rate tracked and queryable over time
- [ ] Error patterns tracked per provider (rate limits, failures)
- [ ] Historical queries work: "Has GPT-4 gotten slower?"
- [ ] Cost comparison works: "Cheapest provider for 0.8+ quality"
- [ ] Provider config stored for reproducibility
- [ ] Iteration efficiency tracked: "Model X completes in 2.3 iterations avg"

## Implementation Details

### Error Handling

**Metrics collection failures must not fail the run.**

- If writing to SQLite fails: Log error, continue run, skip metrics for this inference
- If token extraction fails: Record inference with zero tokens, log warning
- If metrics export fails: Run succeeds, error logged to console
- Benchmark scenario failures: Mark run as failed in report, continue with other scenarios

### Database Migration

New tables are additive only - no breaking changes:

```sql
-- Migration: Add benchmark tables to existing Smithers DB
-- These tables are optional - runs work without them

CREATE TABLE IF NOT EXISTS inference_metrics (...);
CREATE TABLE IF NOT EXISTS run_metrics (...);
CREATE INDEX IF NOT EXISTS idx_inference_run ON inference_metrics(run_id);
-- etc.
```

Existing `runs` table remains unchanged. New tables link via `run_id`.

### Privacy & Data Retention

**What we store:**
- Token counts, timing, provider names, model names
- Task IDs, iteration counts, error types (not error content)
- Provider config (endpoints, regions) but NOT API keys

**What we DON'T store:**
- Prompt content (input text)
- Response content (output text)
- API keys or secrets
- User-identifiable information

**Retention:**
- JSONL files: 90 days (configurable via `BENCHMARK_RETENTION_DAYS`)
- SQLite data: Same retention as existing Smithers state
- Provider config: Retained indefinitely for reproducibility

### Phase 1 MVP (Minimum Viable)

**Must have:**
1. Timing capture in `handleFinished` callbacks
2. Token extraction for OpenAI format
3. SQLite storage (inference_metrics + run_metrics tables)
4. `metrics.json` export at run end
5. Basic benchmark workflow skeleton

**Can defer to Phase 2:**
- Anthropic-specific token parsing
- Tribunal scoring
- Historical queries CLI
- Cache write tracking
- Provider config storage

### Tribunal Scoring Format

Judges return JSON scores:

```json
{
  "score": 0.85,
  "rationale": "Brief explanation",
  "issues": ["issue1", "issue2"],
  "confidence": 0.9
}
```

- `score`: 0.0 to 1.0 (required)
- `rationale`: String explanation (optional)
- `issues`: Array of findings (optional)
- `confidence`: Judge certainty 0.0-1.0 (optional)

Aggregation:
- `avg`: Mean of all runs
- `min`/`max`: Range across runs
- `stdDev`: Standard deviation

### Streaming & TTFT

**Phase 1:** Capture `durationMs` only. TTFT is optional - set to `durationMs` if streaming not available.

**Phase 2:** If Smithers agent components expose streaming callbacks, capture actual TTFT:

```typescript
// If available from agent
const handleFirstToken = () => {
  firstTokenTime = performance.now();
};

const handleFinished = (result) => {
  const ttft = firstTokenTime - startTime;
  // ...
};
```

### Concurrent Load Testing

Phase 1: Single-threaded benchmark runs (one scenario at a time)
Phase 2: Parallel scenario execution controlled via:

```bash
fabrik benchmark \
  --spec specs/test.json \
  --parallel 4 \
  --concurrent-calls 16
```

### Backwards Compatibility

- Existing specs without `benchmarks` array work unchanged
- Metrics collection is opt-out via `DISABLE_METRICS=1`
- Old runs without metrics show "N/A" in queries
- New SQLite tables don't affect existing queries

## Database Migration

**Migration script: `scripts/migrate-metrics-db.ts`**

```typescript
#!/usr/bin/env bun
import Database from "better-sqlite3";

const db = new Database(process.argv[2] || "./reports/state.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS inference_metrics (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    harness TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    phase TEXT NOT NULL,
    task_id TEXT,
    iteration INTEGER DEFAULT 0,
    duration_ms INTEGER,
    input_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    billed_tokens INTEGER DEFAULT 0,
    status TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS run_metrics (
    run_id TEXT PRIMARY KEY,
    spec_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    total_tasks INTEGER DEFAULT 0,
    tasks_completed INTEGER DEFAULT 0,
    total_iterations INTEGER DEFAULT 0,
    total_input_tokens INTEGER DEFAULT 0,
    total_cache_read_tokens INTEGER DEFAULT 0,
    total_cache_write_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_reasoning_tokens INTEGER DEFAULT 0,
    total_billed_tokens INTEGER DEFAULT 0,
    avg_tokens_per_second REAL DEFAULT 0,
    avg_ttft_ms REAL DEFAULT 0,
    tribunal_scores TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inference_run ON inference_metrics(run_id);
  CREATE INDEX IF NOT EXISTS idx_inference_provider ON inference_metrics(provider, model);
  CREATE INDEX IF NOT EXISTS idx_inference_harness ON inference_metrics(harness);
  CREATE INDEX IF NOT EXISTS idx_inference_timestamp ON inference_metrics(timestamp);
  CREATE INDEX IF NOT EXISTS idx_run_spec ON run_metrics(spec_id);
  CREATE INDEX IF NOT EXISTS idx_run_provider ON run_metrics(provider, model);
`);

console.log("Metrics tables created successfully");
db.close();
```

**Run migration:**
```bash
bun run scripts/migrate-metrics-db.ts ./reports/state.db
```

## Testing Strategy

### Unit Tests

**Test: Token extraction**
```typescript
// scripts/benchmark/token-extractor.test.ts
describe("extractTokens", () => {
  it("handles OpenAI format", () => {
    const result = { usage: { prompt_tokens: 100, completion_tokens: 50 } };
    expect(extractTokens(result, "openai")).toEqual({
      input: 100, output: 50, total: 150, billed: 150,
      cacheRead: 0, cacheWrite: 0, reasoning: 0
    });
  });

  it("handles Anthropic cache", () => {
    const result = { 
      usage: { 
        input_tokens: 100, 
        output_tokens: 50,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 70
      } 
    };
    expect(extractTokens(result, "anthropic").cacheRead).toBe(30);
  });

  it("handles missing usage gracefully", () => {
    expect(extractTokens({}, "openai").total).toBe(0);
  });
});
```

### Integration Tests

**Test: Metrics collection doesn't break runs**
```typescript
// tests/metrics-integration.test.ts
describe("Metrics Integration", () => {
  it("run completes successfully with metrics enabled", async () => {
    const result = await runSmithers({
      spec: "specs/000-base.min.json",
      enableMetrics: true
    });
    expect(result.status).toBe("complete");
    expect(result.metricsFile).toExist();
  });

  it("run completes successfully with metrics disabled", async () => {
    process.env.DISABLE_METRICS = "1";
    const result = await runSmithers({
      spec: "specs/000-base.min.json"
    });
    expect(result.status).toBe("complete");
    expect(result.metricsFile).not.toExist();
  });

  it("handles provider errors gracefully", async () => {
    // Mock provider returning malformed response
    const result = await runSmithers({
      spec: "specs/000-base.min.json",
      mockProvider: "malformed"
    });
    expect(result.status).toBe("complete");
    // Should log error but not fail
  });
});
```

### Performance Tests

**Test: Metrics overhead < 1ms**
```typescript
describe("Performance", () => {
  it("metrics collection adds < 1ms per inference", async () => {
    const start = performance.now();
    
    for (let i = 0; i < 100; i++) {
      recordInference({ ...mockMetrics });
    }
    
    const duration = performance.now() - start;
    expect(duration / 100).toBeLessThan(1); // < 1ms per call
  });
});
```

## Known Limitations

### Phase 1 MVP
- **No streaming TTFT**: Captures total duration only
- **Limited token fields**: Only input/output for most providers (no cache breakdown for OpenAI)
- **No tribunal scoring**: Metrics only, no quality assessment
- **Single-threaded**: One scenario at a time

### Workarounds
- TTFT: Use total duration as proxy, actual TTFT in Phase 2
- Cache: Track cache hits manually via provider-specific logs
- Quality: Run `smithers-reviewer.tsx` separately
- Concurrency: Run multiple benchmark commands in parallel

## Troubleshooting

### "nested state update loops" error
**Cause**: Writing to state during render phase  
**Fix**: Ensure metrics writes happen in `onFinished` callbacks, not during component render

### SQLite "table does not exist"
**Cause**: Migration not run  
**Fix**: Run `bun run scripts/migrate-metrics-db.ts`

### Missing token data
**Cause**: Provider doesn't expose usage in response  
**Fix**: Normal - tokens will be 0. Check provider supports usage tracking

### High memory usage
**Cause**: Storing all inferences in memory  
**Fix**: In Phase 2, stream to SQLite instead of buffering

## Future Work

- Grafana dashboard for real-time metrics
- Automatic provider selection based on historical performance
- k6 load testing integration for concurrent capacity testing
- CI integration for benchmark gates
- Cost estimation and budget alerts
- Cache warming recommendations based on hit patterns
