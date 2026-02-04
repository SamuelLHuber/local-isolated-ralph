---
Samuel's idea
---

We want to add a model benchmark.

Like the `scripts/smithers-spec-runner.tsx` and `scripts/smithers-reviewer.tsx` architecture, we already let coding agents run and then review their output. Now we want to expand this concept.

We will have different benchmark scenarios. We will define PRD, SPEC, TODO and then reuse the same loop setup to run different models to finish them.

We will time the models in terms of speed and number of iterations. We will also measure tokens/second for speed if we want to compare infra providers.

From there we will have a review council similar to current `smithers-reviewer.tsx`. These are our judges; we call it the tribune. The tribune runs different review prompts that we prepare as part of the benchmark suite.

Review prompts include:
- Security
- Maintainability
- Elegance
- Precision
- Minimalism
- Specification compliance
- Design
- SALIGIA (nogos, e.g. using `goto` in C or `any` in TypeScript)

We may run the same reviewer prompt multiple times to get aggregate scores and have it be a tribune of many judges piled together. These may also use different harnesses and models (Codex with different models, OpenCode, Claude Code, etc.).

Reviewers can run in parallel and then be combined together to output the final report of the tribune. These final reports are the scores, and we may average across multiple runs (default 3).

We also want to run hard tests like load testing, linters, and hidden unit tests so we see that the implementation really is compliant. Add OTEL + error rates into observability to see it's production ready, check performance numbers, see which model was the fastest. Get business tests and see if its available, say via k6 load testing, to simulate extreme loads on the intended architecture / infra of the model.

---

# PRD - Model Benchmark & Tribunal (Tribune) Feature

| Item | Value |
|------|-------|
| Feature | Automated model-benchmarking suite that runs a set of PRD / SPEC / TODOs against multiple LLMs, times them, counts tokens, and gathers a tribune of reviewers that score the outputs. |
| Scope | Add: <br> - Spec schema extensions for benchmark scenarios. <br> - CLI command `fabrik benchmark ...`. <br> - New Smithers workflow `smithers-tribune.tsx` that orchestrates: <br> &nbsp;&nbsp;- Run spec with each model <br> &nbsp;&nbsp;- Record timings & token usage <br> &nbsp;&nbsp;- Spawn parallel review council (tribune) from `smithers-reviewer.tsx` <br> &nbsp;&nbsp;- Aggregate scores -> final report <br> - Reporting format: JSON with per-model, per-judge, per-scenario stats. |
| Benefits | - Quantitative comparison of LLMs (speed, tokens/second). <br> - Qualitative judgment from multiple review prompts. <br> - Reusable benchmark suite for future specs. <br> - Automatic averaging over multiple runs. |
| Stakeholders | Product, QA, Data Science, Ops. |
| Timeline | 1-2 weeks (implementation + tests). |
| Milestones | 1. Schema & CLI stub. <br> 2. Benchmark runner (`smithers-tribune`). <br> 3. Tribunal aggregation. <br> 4. Documentation & examples. <br> 5. Integration tests. |

---

## 1. Spec Schema Extensions

Add a `benchmarks` section to a spec:

```json
{
  "benchmarks": [
    {
      "name": "fabrik-cli",
      "description": "Run the CLI flow against all models",
      "scenarios": [
        { "model": "codex-gpt4", "engine": "codex" },
        { "model": "claude-code", "engine": "claude" },
        { "model": "opencode-mistral", "engine": "openai" }
      ],
      "iterations": 3,
      "timeoutSeconds": 300,
      "reviewPrompts": [
        { "id": "security", "promptPath": "prompts/DEFAULT-SECURITY.md" },
        { "id": "maintainability", "promptPath": "prompts/DEFAULT-MAINTAINABILITY.md" },
        { "id": "elegance", "promptPath": "prompts/DEFAULT-ELEGANCE.md" }
      ]
    }
  ]
}
```

The existing spec key remains unchanged. `benchmarks` is optional.

The benchmark object contains:

| Key | Type | Description |
|-----|------|-------------|
| name | string | Human-readable ID. |
| description | string | Optional note. |
| scenarios | array | Each scenario specifies a model/engine pair (and optional extra harness config). |
| iterations | number | How many times to repeat the spec run per scenario (default = 3). |
| timeoutSeconds | number | Maximum wall-clock time per scenario. |
| reviewPrompts | array | List of review prompt IDs to run after each scenario. |

---

## 2. CLI - `fabrik benchmark`

```bash
fabrik benchmark \
  --spec specs/your.min.json \
  --vm ralph-1 \
  --output reports/benchmark.json \
  [--iterations 3] \
  [--timeout 300] \
  [--reviewers security,maintainability,elegance]
```

Implementation notes:
- The command loads the spec, extracts benchmarks.
- For each benchmark and scenario it spawns a Smithers run using the same dispatch logic but with a custom harness config that injects the model.
- Timing (`performance.now`) and token counters (exposed by the underlying SDK) are captured.
- After each run, `smithers-reviewer.tsx` is invoked in parallel for each `reviewPrompt`.
- Aggregation step collects per-judge scores and averages across iterations.

Final JSON structure:

```json
{
  "benchmarkName": "fabrik-cli",
  "scenarios": [
    {
      "model": "codex-gpt4",
      "runs": [
        {
          "tokens": 9876,
          "tokensPerSec": 7.9,
          "reviewScores": {
            "security": 0.83,
            "maintainability": 0.75,
            "elegance": 0.68
          }
        }
      ],
      "average": {
        "durationMs": 1200,
        "tokens": 10000,
        "tokensPerSec": 8.3,
        "reviewScores": {
          "maintainability": 0.77
        }
      }
    }
  ]
}
```

---

## 3. Smithers-Tribune Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       Smithers-Tribune                       │
├─────────────────────────────────────┬────────────────────────┤
│ 1. Iterate Benchmarks -> Scenarios  │ 3. Review Council       │
├─────────────────────┬───────────────┤ (parallel, tribunals)   │
│ 2a. Run spec via harness            │ 2b. Collect metrics     │
├─────────────────────┴────────────────────────────────────────┤
│ 4. Aggregate per-model + per-judge scores                     │
│ 5. Output final JSON report                                   │
└──────────────────────────────────────────────────────────────┘
```

Key modules:
- `benchmarks.ts` loads spec and expands scenarios.
- `runner.ts` wraps `dispatchRun` but injects harness config (model/engine).
- `metrics.ts` captures wall-clock time + token counters.
- `tribune.ts` spawns `smithers-reviewer.tsx` for each review prompt; aggregates scores (mean, median).
- `reporter.ts` serializes final JSON.

All modules live in `scripts/` so they can be unit-tested separately.

---

## 4. Review Prompts & Judges

| Judge | Prompt ID | Typical Prompt File | Notes |
|-------|-----------|---------------------|-------|
| Security | security | `prompts/DEFAULT-SECURITY.md` | Check for injection, data leakage. |
| Maintainability | maintainability | `prompts/DEFAULT-MAINTAINABILITY.md` | Code style, modularity. |
| Elegance | elegance | `prompts/DEFAULT-ELEGANCE.md` | Readability, clarity. |
| Precision | precision | `prompts/DEFAULT-PRECISION.md` | Correctness, edge cases. |
| Minimalism | minimalism | `prompts/DEFAULT-MINIMALISM.md` | Avoid unnecessary complexity. |
| Spec Compliance | spec | `prompts/DEFAULT-SPEC.md` | Adheres to spec. |
| Design | design | `prompts/DEFAULT-DESIGN.md` | Architecture, patterns. |
| SALIGIA | saligia | `prompts/DEFAULT-SALIGIA.md` | Detect "nogos" (`goto`, `any`, etc.). |

Prompts can be overridden per benchmark via the `reviewPrompts` array.

---

## 5. How to Use

1. Create a benchmark spec: copy `specs/000-base.json`, add a `benchmarks` section.
2. Add review prompts: place any new prompt under `prompts/`.
3. Run the benchmark:

   ```bash
   fabrik benchmark \
     --spec specs/your-benchmark.min.json \
     --vm ralph-1 \
     --output reports/your-benchmark.json
   ```

4. Inspect the JSON: the file contains timing, token, and review scores.
5. Iterate: tweak models, prompt wording, or add new reviewers.
