// @benchmark/smithers-benchmark.tsx
//
// Minimal benchmark workflow for Fabrik.
// Runs spec against multiple scenarios and aggregates metrics.
// Uses existing Smithers infrastructure - no external dependencies.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Types inline - no external imports needed
type Harness = "pi" | "codex" | "claude";
type Provider = string;
type Phase = "task" | "review" | "review-task";

interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  billed: number;
}

interface InferenceMetrics {
  id: string;
  runId: string;
  timestamp: string;
  harness: Harness;
  provider: Provider;
  model: string;
  phase: Phase;
  taskId?: string;
  iteration: number;
  durationMs: number;
  timeToFirstTokenMs?: number;
  tokens: TokenUsage;
  contextUsed: number;
  contextAvailable: number;
  status: "success" | "error" | "rate_limited" | "timeout";
  error?: string;
}

interface RunMetrics {
  runId: string;
  specId: string;
  harness: Harness;
  provider: Provider;
  model: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  totalTasks: number;
  tasksCompleted: number;
  totalIterations: number;
  tokens: TokenUsage;
  inferences: InferenceMetrics[];
  tribunalScores?: Record<string, number>;
}

interface ScenarioConfig {
  name: string;
  harness: Harness;
  provider: Provider;
  model: string;
  env?: Record<string, string>;
}

interface BenchmarkConfig {
  name: string;
  description?: string;
  iterations: number;
  timeoutSeconds: number;
  scenarios: ScenarioConfig[];
  reviewPrompts: { id: string; promptPath: string }[];
  thresholds?: Record<string, number>;
}

// Simple UUID generator
function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Provider detection from environment
function detectProvider(): Provider {
  const baseUrl = process.env.OPENAI_BASE_URL || "";
  if (baseUrl.includes("azure")) return "azure-openai";
  if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) return "local-vllm";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
}

// Extract tokens from provider response
function extractTokens(response: unknown, provider: Provider): TokenUsage {
  const empty: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, billed: 0 };
  
  if (!response || typeof response !== "object") return empty;
  const r = response as Record<string, unknown>;
  const usage = (r.usage || r.usage_metadata) as Record<string, unknown> | undefined;
  
  if (!usage) return empty;
  
  const result = { ...empty };
  
  if (provider === "anthropic") {
    // Anthropic format
    result.input = (usage.input_tokens as number) || 0;
    result.output = (usage.output_tokens as number) || 0;
    result.cacheRead = (usage.cache_read_input_tokens as number) || 0;
    result.cacheWrite = (usage.cache_creation_input_tokens as number) || 0;
    result.reasoning = (usage.reasoning_tokens as number) || 0;
  } else {
    // OpenAI / local format
    result.input = (usage.prompt_tokens as number) || (usage.input_tokens as number) || 0;
    result.output = (usage.completion_tokens as number) || (usage.output_tokens as number) || 0;
    const details = usage.prompt_tokens_details as Record<string, number> | undefined;
    result.cacheRead = details?.cached_tokens || 0;
    const completionDetails = usage.completion_tokens_details as Record<string, number> | undefined;
    result.reasoning = completionDetails?.reasoning_tokens || 0;
  }
  
  result.total = result.input + result.output;
  result.billed = result.total;
  
  return result;
}

// Get context limit from model name
function getContextLimit(model: string): number {
  if (model.includes("32k")) return 32768;
  if (model.includes("gpt-4")) return 8192;
  if (model.includes("claude")) return model.includes("opus") ? 200000 : 100000;
  return 8192;
}

interface BenchmarkContext {
  specPath: string;
  outputDir: string;
  iterations?: number;
}

export async function runBenchmark(ctx: BenchmarkContext): Promise<void> {
  // Load spec
  const specRaw = readFileSync(ctx.specPath, "utf-8");
  const spec = JSON.parse(specRaw) as { id: string; benchmarks?: BenchmarkConfig[] };
  
  if (!spec.benchmarks?.length) {
    throw new Error(`No benchmarks in spec: ${spec.id}`);
  }
  
  const benchmark = spec.benchmarks[0];
  const iterations = ctx.iterations ?? benchmark.iterations ?? 3;
  
  console.log(`[Benchmark] ${benchmark.name}`);
  console.log(`  Iterations: ${iterations}`);
  console.log(`  Scenarios: ${benchmark.scenarios.length}`);
  
  // Run each scenario
  const scenarioResults: Array<{ scenario: string; runs: RunMetrics[]; scores: Record<string, number> }> = [];
  
  for (const scenario of benchmark.scenarios) {
    console.log(`\n  [Scenario] ${scenario.name}`);
    
    const runs: RunMetrics[] = [];
    
    for (let i = 0; i < iterations; i++) {
      console.log(`    [Run ${i + 1}/${iterations}]`);
      
      const runId = `${scenario.name}-run-${i}`;
      const workdir = `${ctx.outputDir}/runs/${runId}`;
      
      // Set up environment
      const env = {
        ...process.env,
        ...scenario.env,
        SMITHERS_MODEL: scenario.model,
        SMITHERS_AGENT: scenario.harness,
        BENCHMARK_SCENARIO: scenario.name,
        BENCHMARK_PROVIDER: scenario.provider,
      };
      
      // Run Smithers (this would call the actual runner)
      const runMetrics = await executeRun({
        specPath: ctx.specPath,
        workdir,
        runId,
        scenario,
        env,
      });
      
      runs.push(runMetrics);
    }
    
    // Run tribunal
    const scores = await runTribunal(benchmark.reviewPrompts, runs[0], ctx.outputDir);
    
    scenarioResults.push({
      scenario: scenario.name,
      runs,
      scores,
    });
  }
  
  // Generate report
  const report = {
    benchmarkName: benchmark.name,
    generatedAt: new Date().toISOString(),
    scenarios: scenarioResults,
  };
  
  const fs = await import("node:fs/promises");
  await fs.mkdir(`${ctx.outputDir}/report`, { recursive: true });
  await fs.writeFile(
    `${ctx.outputDir}/report/benchmark-report.json`,
    JSON.stringify(report, null, 2)
  );
  
  console.log(`\n[Benchmark] Complete: ${ctx.outputDir}/report/benchmark-report.json`);
}

interface RunParams {
  specPath: string;
  workdir: string;
  runId: string;
  scenario: ScenarioConfig;
  env: Record<string, string | undefined>;
}

async function executeRun(params: RunParams): Promise<RunMetrics> {
  const { runId, scenario } = params;
  const harness = scenario.harness;
  const provider = scenario.provider;
  const model = scenario.model;
  
  // This would integrate with actual Smithers
  // For now return mock data
  const now = new Date();
  
  return {
    runId,
    specId: "mock-spec",
    harness,
    provider,
    model,
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    durationMs: 5000 + Math.floor(Math.random() * 5000),
    totalTasks: 3,
    tasksCompleted: 3,
    totalIterations: 1,
    tokens: {
      input: 2000,
      cacheRead: 500,
      cacheWrite: 1500,
      output: 500,
      reasoning: 100,
      total: 2500,
      billed: 2500,
    },
    inferences: [],
  };
}

async function runTribunal(
  prompts: { id: string; promptPath: string }[],
  run: RunMetrics,
  outputDir: string
): Promise<Record<string, number>> {
  const scores: Record<string, number> = {};
  
  for (const prompt of prompts) {
    // This would call actual reviewer
    scores[prompt.id] = 0.7 + Math.random() * 0.25;
  }
  
  return scores;
}
