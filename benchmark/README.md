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

## Future Work

* Integration with Grafana dashboards for real‑time OTEL metrics.
* Support for custom k6 scripts and Docker‑based load testing.
* CI integration to automatically run benchmarks on PRs.

---

© 2026 The Local Ralph Team
