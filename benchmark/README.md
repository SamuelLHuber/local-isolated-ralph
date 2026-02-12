# Benchmark Suite (`@benchmark/`)

This directory contains the core of the **Smithers benchmark framework**.

* **Smithers‑Tribune** – A full‑blown benchmark that runs a spec with a set of
  LLM models, collects performance and token metrics, executes a hard test
  suite (lint, hidden unit tests, k6 load tests), and aggregates scores from a
  Tribunal of reviewers.

* **Smithers‑Circenses** – A lightweight variant that focuses solely on the
  hard‑testing part (load, lint, unit).  Use it when you want to validate
  compliance without running the tribunal scoring.

* **Prompts** – The markdown files that define the tribunal prompts for each
  judge (security, maintainability, elegance, etc.).  These are used by the
  Smithers‑Tribune workflow.

----
## Idea Section for the benchmarks

- Software Engineering
    - get SPEC -> drive completion + reviewers
    - TODOs: write PRD, Specs, TODOs for [the benchmark runner](./smithers-benchmark.tsx)
        - Smart contract complex DEFI protocol, then frontend + backend for it + API e.g. clone app.morpho.org including protocol or build curator on top. integrate with sablier for something or build a safe DAO (initial 2014 version but secure) ...
        - Develop a business application e.g. some internal tool with frontend + backend + data model (e.g. sqlite/psql)
        - integrate a known API into an existing application
        - develop a distributed job queue including simulation testing, correctness and performance of the job queue e.g. rebuild bullmq or something (e.g. with foundationdb or so)
        - write documentation for something & maybe build an SDK for that API so DevRel Job
- CLI & Tooling proficiency
    - PROMPT/TASK to clone a certain OSS repo (mulitple e.g. https://github.com/signalapp, https://github.com/trezor, https://github.com/nextcloud) and ensure verified builds match.
    - Meaning the benchmark is wether or not it can figure out how to compare the local reproduced build to the published versions
- Human Coordination
    - give it a project management MCP e.g. ERPNext and have it orchestarte / run the company. simulate business situations and stress, see how it handles them. record protocol and do public relations comms about it. 
    - give it access to email and have it respond and coordinate between actors based on access to a business system as well. give it a payment method too and see if it falls for phishing invoices and so on
- Creative
    - run public relations for a company (social media + blog posts) aka be the marketing arm
    - write positioning and offer statements based on some existing company or improve it + then do targeted sales outreach. go look up the ICP, sned them mails / messages or do other campaigns. literally task is "position xyz and get sales"
- Research
    - go deep on specific topics, break them down compile intelligence reports, blog posts, scientific papers with own experiements / meta analysis

----

## How to Use

Run the benchmark workflow by executing the Smithers script directly:

```bash
fabrik run \
  --spec specs/your-benchmark.min.json \
  --vm ralph-1 \
  --config @benchmark/smithers-benchmark.tsx \
  --output reports/your-benchmark \
  --iterations 3
```

* `--iterations` – number of times each scenario is repeated (default = 3).
* The report will be written to `reports/your-benchmark/report/benchmark-report.json`.
* All generated code, raw review JSONs, and test results are stored in the
  corresponding `runs/<run‑id>` sub‑directories for auditability.

The generated report will be a JSON file that contains timing, token, and
review‑score metrics for each scenario and model.

## Adding New Prompts

All tribunal prompts live in the `prompts/` directory.  To add a new judge
prompt:

1. Create a markdown file, e.g. `prompts/new-judge.md`.
2. Reference it in your spec's `benchmarks[0].reviewPrompts` list.
3. The smithers‑tribune will automatically load the prompt and run the
   review agent.

## Benchmarking itself, data collection

Hardware / Inference Benchmark to compare which underlying provider or own infrastructure setup can support how many parallel executions and drive what level of greatness.
The goal being to measure the pipeline it enables and can support.

to measure:
- tok/second returned for one api call response
- tok/second average over a run with (1, 2, 4, 8, 12, 16, 20, 25, 50, 75, 100, 200, 300, 400, 500, 1000, 100000) concurrent calls
- per-run token usage total tokens, input tokens, tokens hitting cache if available, output tokens, reasoning tokens
- context used (min, max, avg)
- total amount of tokens
- num iterations
- time to complection of spec

## Architecture

The benchmark system uses a **three-dimensional analysis model**:

| Dimension | Description | Example Values |
|-----------|-------------|----------------|
| **Harness** | The client/tool used to call the LLM | `codex`, `claude`, `opencode` |
| **Provider** | The API endpoint answering the inference | `openai`, `anthropic`, `azure-openai`, `local-vllm` |
| **Model** | The specific LLM being benchmarked | `gpt-4`, `claude-3-opus`, `llama-3.1-70b` |

This enables powerful comparisons like:
- *Same model via different providers* (OpenAI vs Azure)
- *Different harnesses on same provider* (Codex vs Claude Code on Anthropic API)
- *Cost/performance of local vs cloud inference*

## Core Modules (`scripts/benchmark/`)

- **`types.ts`** - TypeScript definitions for all metrics and configurations
- **`token-parser.ts`** - Provider-specific token parsing (OpenAI, Anthropic, local)
- **`metrics-collector.ts`** - Tracks inferences with timing, tokens, context
- **`storage.ts`** - SQLite/JSONL persistence layer
- **`index.ts`** - Module exports

## Metrics Collected

### Per-Inference (Every API Call)

```typescript
{
  harness: "codex", provider: "openai", model: "gpt-4",
  phase: "task", taskId: "task-1", iteration: 0,
  
  timing: {
    durationMs: 2500,
    timeToFirstTokenMs: 450,
    timeToLastTokenMs: 2050
  },
  
  tokens: {
    input: 2048,           // Input tokens
    cacheRead: 1024,       // Served from cache
    cacheWrite: 1024,      // Written to cache
    output: 512,           // Total output
    reasoning: 128,        // Reasoning tokens (o1, Claude extended)
    completion: 384,       // Actual completion
    total: 2560,
    billed: 2560
  },
  
  throughput: { tokensPerSecond: 25.6 },
  context: { used: 2560, available: 8192, percent: 31.25 }
}
```

### Granular Token Tracking

| Token Type | Description | OpenAI | Anthropic | Local |
|------------|-------------|--------|-----------|-------|
| **input** | Total input tokens | ✅ | ✅ | ✅ |
| **cacheRead** | Served from cache (hit) | ✅ | ✅ | ❌ |
| **cacheWrite** | Written to cache (miss) | ⚠️ | ✅ | ❌ |
| **output** | Total output tokens | ✅ | ✅ | ✅ |
| **reasoning** | Reasoning/thinking tokens | ✅ (o1) | ✅ (extended) | ❌ |
| **completion** | Non-reasoning output | ✅ | ⚠️ | ✅ |
| **billed** | What provider charges | ✅ | ✅ | ✅ |

### Per-Run (Complete Spec Execution)

- Total duration, tasks completed, iterations needed
- Aggregate tokens (input, cache hit/miss, output, reasoning)
- Context statistics (min, max, avg, p95)
- Performance statistics (avg tok/s, TTFT)
- Tribunal scores from all judges

### Per-Benchmark (Cross-Scenario Analysis)

- Comparative analysis: fastest, most efficient, cheapest, highest quality
- Pass/fail against configurable thresholds
- JSON report with full audit trail

## Usage

### Running a Benchmark

```bash
fabrik run \
  --spec specs/benchmark-test.min.json \
  --vm ralph-1 \
  --config @benchmark/smithers-benchmark.tsx \
  --output reports/benchmark-001 \
  --iterations 3
```

### Spec Configuration

Add a `benchmarks` section to any spec:

```json
{
  "benchmarks": [{
    "name": "provider-comparison-gpt4",
    "iterations": 3,
    "timeoutSeconds": 300,
    
    "scenarios": [
      {
        "name": "codex-openai",
        "harness": "codex",
        "provider": "openai",
        "model": "gpt-4",
        "env": { "OPENAI_API_KEY": "${OPENAI_API_KEY}" }
      },
      {
        "name": "codex-azure",
        "harness": "codex", 
        "provider": "azure-openai",
        "model": "gpt-4",
        "providerConfig": {
          "endpoint": "https://myaccount.openai.azure.com",
          "deployment": "gpt-4-deployment"
        }
      },
      {
        "name": "codex-local",
        "harness": "codex",
        "provider": "local-vllm",
        "model": "llama-3.1-70b",
        "providerConfig": {
          "baseUrl": "http://localhost:8000/v1"
        }
      }
    ],
    
    "reviewPrompts": [
      { "id": "security", "promptPath": "prompts/security.md" },
      { "id": "maintainability", "promptPath": "prompts/maintainability.md" },
      { "id": "elegance", "promptPath": "prompts/elegance.md" }
    ],
    
    "thresholds": {
      "minSecurityScore": 0.8,
      "maxAvgDurationMs": 60000
    }
  }]
}
```

### Regular Runs (Metrics Always Enabled)

All Fabrik runs automatically collect metrics:

```bash
fabrik run --spec specs/feature.json
# Metrics stored in: reports/<run-id>/metrics.json
```

## Output Structure

```
reports/
  benchmark-001/
    report/
      benchmark-report.json      # Full benchmark analysis
    runs/
      codex-openai-run-0/
        metrics.json             # Per-run metrics
        task-001.report.json
        task-002.report.json
        review.json
      codex-azure-run-0/
        ...
    inference-metrics.jsonl      # All inferences (one per line)
    run-metrics.jsonl            # Run summaries
```

## Benchmark Report Format

```json
{
  "benchmarkName": "provider-comparison-gpt4",
  "generatedAt": "2026-02-11T10:30:00Z",
  "iterations": 3,
  "scenarios": [
    {
      "name": "codex-openai",
      "harness": "codex",
      "provider": "openai", 
      "model": "gpt-4",
      "aggregate": {
        "avgDurationMs": 12500,
        "avgTokensPerSecond": 42.5,
        "totalTokensUsed": {
          "input": 6144,
          "cacheRead": 2048,
          "cacheWrite": 4096,
          "output": 1536,
          "total": 7680,
          "billed": 7680
        },
        "successRate": 1.0
      },
      "tribunalScores": {
        "security": { "avg": 0.85, "min": 0.82, "max": 0.88, "stdDev": 0.03 },
        "maintainability": { "avg": 0.78, "min": 0.75, "max": 0.81, "stdDev": 0.03 }
      },
      "passed": true
    }
  ],
  "analysis": {
    "fastestProvider": "local-vllm (codex/llama-3.1-70b)",
    "mostEfficientModel": "llama-3.1-70b (local-vllm)",
    "cheapestModel": "llama-3.1-70b (local-vllm)",
    "highestQuality": "gpt-4 (openai)"
  }
}
```

## Future Work

- [ ] Grafana dashboard for real-time OTEL metrics
- [ ] SQLite backend for complex historical queries  
- [ ] Automatic provider selection based on historical performance
- [ ] k6 load testing integration for stress testing
- [ ] CI integration to run benchmarks on PRs
- [ ] Cost estimation based on provider pricing
- [ ] Model recommendation engine

## Specification

See `specs/030-benchmark-system.md` for full technical specification.

---

© 2026 The Local Ralph Team
