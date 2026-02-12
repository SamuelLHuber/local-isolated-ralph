# PRD: Fabrik LAOS Lint + Run Feedback

## One‑Sentence Promise
It lets agents and developers run performance-aware checks and get a single, scoped pass/fail report (with worst offenders) from LAOS for each run.

Version: v0.1.0 (draft)
Date: 2026-02-11
Author: Fabrik/Ralph
Stakeholders: Agent operators, app devs
Refs: LAOS (https://github.com/dtechvision/laos)

---

## 1) Overview (Plain Language)
We are adding a “performance linter” to Fabrik that queries LAOS (Loki/Tempo/Prometheus/Pyroscope/Sentry/PostHog) and returns a compact, actionable report. It must support both full test runs (k6/autocannon/wrk + telemetry) and ad‑hoc checks (e.g. “did the expected error show up?”). All results must be scoped to a unique run identifier so multiple agents can operate concurrently without noise.

This spec is designed to stand alone for readers unfamiliar with Ralph/Smithers:
- **Ralph** is the iterative agent loop (spec → tasks → reports).
- **Smithers** is the workflow engine that runs tasks, reviewers, and writes reports.
- **LAOS** is the shared observability stack (logs/traces/metrics/profiles/errors).

## 2) Success Outcomes (Measurable)
- Agents can run `fabrik laos run` and receive a single JSON report with pass/fail and top offenders within 60s after test completion.
- Multiple agents running in parallel do not contaminate each other’s results.
- A developer can query “did error X occur” without running a test and get a result in <5s.
- Reviewers can block or request changes based on lint failures without re-running tests.
- v0.1 works end‑to‑end with **k6 + Tempo + Loki + Sentry** (profiling presence check only).

## 3) Non‑Goals
- We are not building a full UI; outputs are CLI + JSON.
- We are not replacing app-side instrumentation; we only consume LAOS signals.
- We are not guaranteeing Bun profiling support (Node only for Pyroscope).
## 3.1 v0.1 Scope (Strict)
- **Load testing:** k6 only.
- **Latency source:** traces only (Tempo).
- **Required signals:** Tempo + Loki + Sentry.
- **Profiling:** presence check only (Pyroscope).
- **Backpressure default:** lint failure blocks (CHANGES_REQUESTED).

## 3.2 v0.2+ Scope (Extensions)
- wrk2 and autocannon support.
- Prometheus histogram percentiles.
- PostHog query integration.
- Profiling thresholds and regression budgets.

## 3.3 Assumptions (Explicit)
- Apps emit logs/traces/errors/profiles with the required labels/tags (see §4.3.1).
- LAOS is reachable from the execution environment (VMs/host) and services are healthy.
- Load tests are run against a known base URL and can attach `X-Run-Id`.
- Traces are available for latency percentiles (Tempo is the source of truth in v0.1).
- Pyroscope is available for Node runs only (Bun profiling unsupported).

## 4) Functional Requirements

### 4.1 Commands
Add Fabrik CLI commands:

1) `fabrik laos run`
Runs a performance test (k6/autocannon/wrk) with run scoping and then lint.

2) `fabrik laos lint`
Evaluates thresholds for a run or time window and emits a JSON report.

3) `fabrik laos query`
Ad‑hoc lookups for errors/logs/traces/profiles without a test run.

### 4.1.1 Tooling Strategy (v0.1)
We start with **k6** only because it is scriptable, reproducible, and integrates cleanly into CI and developer workflows. The lint system remains tool‑agnostic, but v0.1 supports only k6 for deterministic results.

### 4.2 Config File (Lint Policy)
Configuration is repo-local and eslint/dprint‑style.
Default file: `.laosrc.yaml` (also allow `.laosrc.json`).

Example:
```yaml
service: effect-tanstack-start
window: 10m

scope:
  run_id: "${RalphRunId}"
  env: "local"
  agent: "${RalphAgent}"

thresholds:
  latency_ms:
    p50: 120
    p95: 350
    p99: 800
    p100: 2000
  error_rate: 0.01
  cpu_pct: 75
  db_time_ms:
    p95: 120
    p99: 250
  log_error_rate: 0.001

signals:
  traces: true
  metrics: true
  logs: true
  errors: true
  profiles: optional

failure_details:
  top_spans: 3
  top_errors: 3
  top_routes: 3
```

### 4.3 Run Scoping (Required)
All checks must be scoped by `run_id` when provided.
The lint must refuse to run without `run_id` unless `--allow-unscoped` is passed.

Required telemetry attributes/labels/tags:
- `service.name`
- `run_id`
- `agent` (optional)
- `env`

### 4.3.1 Telemetry Labeling Contract (Explicit)
This system only works if **all signals are labeled consistently**. Instrumentation MUST attach the same identifiers across logs, traces, metrics, errors, and profiles so results are deterministic and attributable.

**Contract:**
- `service.name` identifies the application/service.
- `run_id` uniquely identifies a test run or agent execution.
- `agent` identifies the VM/agent (optional).
- `env` identifies local/staging/prod.

**Signal mapping:**
- **Traces (Tempo/OTel):** resource attrs + span attrs.
- **Logs (Loki):** labels + JSON fields.
- **Errors (Sentry):** tags.
- **Profiles (Pyroscope):** labels.
- **Metrics (Prometheus):** labels.

**Deterministic lookup requirement:**
Given `service.name` + `run_id`, it must be possible to deterministically query:
- all logs for the run
- all traces/spans for the run
- all errors for the run
- all profiles for the run
within the configured time window.

### 4.3.2 Query Hints (Human‑usable)
The lint output must include **query hints** (strings or URLs) for manual deep‑dives:
- Grafana Explore query for Loki logs (scoped to `run_id`)
- Tempo query or search hint for traces (scoped to `run_id`)
- Sentry issue search hint for errors (scoped to `run_id`)
This keeps output token‑light while still enabling “open the chart” debugging.

### 4.4 Data Sources (v0.1)
- **Tempo** for trace latencies and span durations (source of truth).
- **Loki** for log error rates.
- **Sentry** for error counts.
- **Pyroscope** for profiling samples (presence check only).

### 4.5 Output (Single JSON Report)
Lint output must be a single JSON object with:
- `status: pass|fail`
- `violations[]`
- `worst` details (top spans/errors/routes)
- `window`, `service`, `run_id`

Example:
```json
{
  "status": "fail",
  "violations": [
    {"metric": "latency_ms.p95", "value": 420, "limit": 350}
  ],
  "worst": {
    "spans": [{"name":"db.query.users","p99":320}],
    "errors": [{"title":"DB timeout","count":4}],
    "routes": [{"name":"/api/checkout","p95":410}]
  },
  "window":"10m",
  "service":"effect-tanstack-start",
  "run_id":"ralph-1-20260211T101500Z"
}
```

### 4.6 Profiling Vision (v0.1)
Profiling is treated as a **signal presence** check:
- Confirm Pyroscope has samples for `run_id`.
- Optional: capture top 3 functions by CPU for visibility (no threshold).

### 4.7 Ad‑Hoc Query
`fabrik laos query` supports:
- Error lookup by message/tag in Sentry
- Log lookup by substring/label in Loki
- Trace lookup by service/run_id in Tempo

Outputs:
```json
{"found":true,"count":3,"last_seen":"2026-02-10T17:28:12Z","top_span":"/api/checkout"}
```

## 5) User Stories (Explicit)

1) **“It failed for me — show me the error.”**  
As a developer/agent, I want to run a query scoped to my `run_id` and immediately see whether the expected error was logged, including count and latest timestamp, so I can debug without scanning raw logs.

2) **“I’m working on performance improvements — show me impact.”**  
As a developer/agent, I want a single report that shows error rate, latency percentiles, DB time, and top offenders, so I can confirm the improvement and see regressions immediately.

3) **“Multiple agents are running — don’t mix results.”**  
As an operator, I want each agent’s results to be isolated by `run_id`, so one agent’s telemetry never pollutes another’s report.

4) **“Give me the evidence, not a log dump.”**  
As a developer/agent, I want compact, deterministic output (top spans, top errors, top routes) so I can act without wading through verbose logs.

5) **“Reviewers need evidence, not claims.”**  
As a reviewer agent, I want the LAOS lint report attached to a run so I can judge performance and error impact without rerunning tests.

6) **“Block on regressions automatically.”**  
As a reviewer agent, I want lint failures to translate into `CHANGES_REQUESTED` so regressions are not approved silently.

7) **“Trace it to a span/route.”**  
As a reviewer agent, I want the top offending spans/routes so I can point implementers to the exact hot path.

8) **“Is this correctness or performance?”**  
As a reviewer agent, I want error counts + last_seen timestamps alongside latency so I can distinguish correctness failures from perf regressions.

9) **“Show me the delta.”**  
As an implementer, I want to compare a run against a baseline run_id to verify improvements or regressions.

10) **“Fleet health at a glance.”**  
As an operator, I want per‑run pass/fail summaries so I can triage which agents need attention.

11) **“Backpressure is automatic.”**  
As an operator, I want lint failures to block promotion in the loop so regressions do not ship.

12) **“Reproducible runs.”**  
As an operator, I want reports to include run_id, agent, service, and tool versions for auditability.

## 6) Integration Requirements
- `fabrik laos run` must inject `RUN_ID` (and `AGENT/ENV`) into test processes.
- For HTTP tests, add header `X-Run-Id` to requests.
- App instrumentation must propagate header to telemetry tags.
- Lint output must be written to `reports/lint.json` so reviewers and humans can read it.
- If lint fails, the reviewer flow should:
  - mark `CHANGES_REQUESTED`, or
  - generate `review-todo.json` tasks from violations, or
  - block with `human-gate.json` (configurable).

### 6.1 Integration Examples (Minimal, v0.1)
- **k6**: set `X-Run-Id` header; set `RUN_ID` env for test metadata.

### 6.2 Tool Choice Rationale (Short)
- **k6** is the only v0.1 tool because it covers realistic flows and is CI‑friendly.
- wrk2/autocannon are deferred to v0.2+.

## 7) Acceptance Criteria
- `fabrik laos run` produces a report in <60s after test completion.
- `fabrik laos lint` fails if a threshold is exceeded and lists the top offender(s).
- `fabrik laos query` returns a result without running a test.
- Run scoping prevents cross‑agent contamination.
- Profiling check confirms samples exist when profiling is enabled.
- Lint failures are surfaced in reviewer outputs without requiring log dumps.

## 8) Open Questions
- Should p100 be computed or omitted by default?
