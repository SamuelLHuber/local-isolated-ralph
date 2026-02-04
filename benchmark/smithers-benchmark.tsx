// @benchmark/smithers-benchmark.tsx
//
// Core Smithers workflow for benchmarks.  It performs the following steps:
//   1. Parse the benchmark spec (PRD/SPEC/TODO) and retrieve benchmark
//      metadata (version, description, etc.).
//   2. For each scenario model, dispatch a Smithers run of the spec.
//      The run produces the generated code in a temporary workdir.
//   3. Run hard‑test suites (lint, hidden unit tests, k6 load test) on
//      the generated code.
//   4. For each judge, run the review prompt (Tribune).  All judges are
//      executed in parallel; their JSON responses are collected.
//   5. Aggregate timing, token‑usage, test results, and review scores.
//   6. Persist a full audit trail:
//        • Benchmark spec front‑matter (name, version)
//        • Generated code artifacts
//        • Raw review JSONs
//        • Raw test JSONs
//        • Final scorecard JSON
//
// This file is intentionally lightweight – the heavy lifting is performed
// by the underlying Smithers infrastructure.  The implementation below
// provides a skeleton that can be expanded as needed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSmithers } from "./smithers-spec-runner.js"; // existing runner
import { runReviewer } from "./smithers-reviewer.js"; // existing reviewer
import type { Spec } from "../src/fabrik/specs.js";

export interface BenchmarkContext {
  specPath: string;
  vm: string;
  outputDir: string;
  iterations?: number;
}

export async function runBenchmark(ctx: BenchmarkContext): Promise<void> {
  const specRaw = readFileSync(ctx.specPath, "utf-8");
  const spec: Spec = JSON.parse(specRaw);

  const iterations = ctx.iterations ?? 3;
  const results: any[] = [];

  for (const bench of spec.benchmarks ?? []) {
    for (const scenario of bench.scenarios ?? []) {
      for (let i = 0; i < iterations; i++) {
        // 1️⃣ Run the spec with the chosen model
        const runId = `${bench.name}-${scenario.model}-${i}`;
        const workdir = `${ctx.outputDir}/runs/${runId}`;
        const smithersResult = await runSmithers({
          specPath: ctx.specPath,
          vm: ctx.vm,
          outputDir: workdir,
          model: scenario.model,
        });

        // 2️⃣ Run hard‑tests (placeholder – see `smithers-benchmark.tsx` for details)
        const testResults = await runHardTests(workdir);

        // 3️⃣ Run all judges in parallel
        const judgePromises = (bench.reviewPrompts ?? []).map((rp) =>
          runReviewer({
            vm: ctx.vm,
            promptPath: resolve("@benchmark/prompts", rp.id + ".md"),
            model: scenario.model,
            codeDir: workdir,
          })
        );
        const judgeResults = await Promise.all(judgePromises);

        results.push({
          runId,
          scenario,
          smithersResult,
          testResults,
          judgeResults,
        });
      }
    }
  }

  // 4️⃣ Aggregate (simple averaging for now)
  const aggregate = aggregateResults(results);
  const report = { spec, aggregate, results };
  const fs = await import("node:fs/promises");
  await fs.mkdir(`${ctx.outputDir}/report`, { recursive: true });
  await fs.writeFile(`${ctx.outputDir}/report/benchmark-report.json`, JSON.stringify(report, null, 2), "utf-8");
}

// Stub for hard‑test runner – replace with real implementation.
async function runHardTests(workdir: string) {
  return { lint: { status: "pass", errors: 0 }, unit: { status: "pass", passed: 10 }, k6: { status: "pass", rps: 200 } };
}

// Very naive aggregation – extend as required.
function aggregateResults(results: any[]) {
  const scores: Record<string, number> = {};
  for (const r of results) {
    for (const jr of r.judgeResults) {
      scores[jr.judge] = (scores[jr.judge] ?? 0) + jr.score;
    }
  }
  const avg: Record<string, number> = {};
  for (const k in scores) {
    avg[k] = scores[k] / results.length;
  }
  return { avg };
}

