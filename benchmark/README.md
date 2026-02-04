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

## Future Work

* Integration with Grafana dashboards for real‑time OTEL metrics.
* Support for custom k6 scripts and Docker‑based load testing.
* CI integration to automatically run benchmarks on PRs.

---

© 2026 The Local Ralph Team
