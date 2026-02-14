/**
 * Learning & Pattern Extraction System
 * 
 * Captures execution data to optimize future runs.
 * Commits learnings to VCS for team sharing and compounding.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { runCommand } from "./exec.js"

// Learning data structure
export type Learning = {
  timestamp: string
  specId: string
  ticketId: string
  tier: "T1" | "T2" | "T3" | "T4"
  
  // Prediction vs Actual
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
    bugsInProduction?: boolean
  }
  
  // Outcome
  effectiveness: "over-engineered" | "appropriate" | "under-engineered"
  costUsd: number
  
  // Extracted pattern
  pattern?: {
    taskType: string
    recommendedTier: string
    recommendedReviews: string[]
    recommendedModel: string
    reasoning: string
  }
}

// Global patterns database
export type RepoPattern = {
  taskType: string  // e.g., "auth-middleware", "ui-styling", "api-endpoint"
  tier: "T1" | "T2" | "T3" | "T4"
  reviews: string[]
  model: "cheap" | "standard" | "powerful"
  gates: string[]
  confidence: number  // 0-1, based on sample size
  sampleSize: number
  avgCostUsd: number
  avgHours: number
  notes?: string[]  // Human-added notes
}

// Configuration
const FABRIK_DIR = ".fabrik"
const LEARNINGS_FILE = `${FABRIK_DIR}/learnings.jsonl`
const PATTERNS_FILE = `${FABRIK_DIR}/patterns.md`
const PATTERNS_JSON = `${FABRIK_DIR}/patterns.json`

function ensureFabrikDir(repoRoot: string) {
  const fabrikPath = resolve(repoRoot, FABRIK_DIR)
  if (!existsSync(fabrikPath)) {
    mkdirSync(fabrikPath, { recursive: true })
    // Create .gitignore to ensure we commit these
    writeFileSync(
      join(fabrikPath, ".gitignore"),
      "# Fabrik learnings - COMMIT THESE\n!*.jsonl\n!*.md\n!*.json\n"
    )
  }
  return fabrikPath
}

// =============================================================================
// LEARNING CAPTURE
// =============================================================================

export function recordLearning(learning: Learning, repoRoot: string) {
  ensureFabrikDir(repoRoot)
  const learningsPath = resolve(repoRoot, LEARNINGS_FILE)
  
  const line = JSON.stringify(learning) + "\n"
  appendFileSync(learningsPath, line)
  
  return learningsPath
}

export function loadLearnings(repoRoot: string, options?: { since?: string; limit?: number }): Learning[] {
  const learningsPath = resolve(repoRoot, LEARNINGS_FILE)
  if (!existsSync(learningsPath)) return []
  
  const lines = readFileSync(learningsPath, "utf8").trim().split("\n").filter(Boolean)
  let learnings = lines.map(line => JSON.parse(line) as Learning)
  
  // Filter by date if specified
  if (options?.since) {
    const sinceDate = new Date(options.since)
    learnings = learnings.filter(l => new Date(l.timestamp) >= sinceDate)
  }
  
  // Limit if specified
  if (options?.limit) {
    learnings = learnings.slice(-options.limit)
  }
  
  return learnings
}

// =============================================================================
// PATTERN EXTRACTION
// =============================================================================

export function extractPatterns(learnings: Learning[]): RepoPattern[] {
  const patterns = new Map<string, Learning[]>()
  
  // Group by task type
  for (const learning of learnings) {
    const taskType = learning.pattern?.taskType || inferTaskType(learning.ticketId)
    if (!patterns.has(taskType)) {
      patterns.set(taskType, [])
    }
    patterns.get(taskType)!.push(learning)
  }
  
  // Aggregate into patterns
  const result: RepoPattern[] = []
  
  for (const [taskType, typeLearnings] of patterns) {
    const tierCounts = countBy(typeLearnings, l => l.tier)
    const dominantTier = maxKey(tierCounts) as "T1" | "T2" | "T3" | "T4"
    
    const reviewFreq: Record<string, number> = {}
    const modelFreq: Record<string, number> = {}
    const gateFreq: Record<string, number> = {}
    
    for (const l of typeLearnings) {
      for (const r of l.prediction.reviewsRequired) {
        reviewFreq[r] = (reviewFreq[r] || 0) + 1
      }
      modelFreq[l.prediction.modelUsed] = (modelFreq[l.prediction.modelUsed] || 0) + 1
      for (const g of l.prediction.gatesRequired) {
        gateFreq[g] = (gateFreq[g] || 0) + 1
      }
    }
    
    // Only include reviews that were actually useful (>50% found issues)
    const usefulReviews = Object.entries(reviewFreq)
      .filter(([reviewer]) => {
        const withReviewer = typeLearnings.filter(l => 
          l.prediction.reviewsRequired.includes(reviewer)
        )
        const foundIssues = withReviewer.filter(l => l.actual.issuesFound.length > 0)
        return foundIssues.length / withReviewer.length > 0.5
      })
      .map(([r]) => r)
    
    const avgCost = typeLearnings.reduce((sum, l) => sum + l.costUsd, 0) / typeLearnings.length
    const avgHours = typeLearnings.reduce((sum, l) => sum + l.actual.hoursSpent, 0) / typeLearnings.length
    
    result.push({
      taskType,
      tier: dominantTier,
      reviews: usefulReviews,
      model: maxKey(modelFreq) as "cheap" | "standard" | "powerful",
      gates: Object.keys(gateFreq),
      confidence: Math.min(typeLearnings.length / 10, 1),
      sampleSize: typeLearnings.length,
      avgCostUsd: avgCost,
      avgHours
    })
  }
  
  return result.sort((a, b) => b.confidence - a.confidence)
}

export function generatePatternsMarkdown(patterns: RepoPattern[]): string {
  const lines = [
    "# Fabrik Patterns",
    "",
    "> Auto-generated from execution learnings. Review and refine.",
    "> Last updated: " + new Date().toISOString(),
    "",
    "## How to Use",
    "",
    "This file contains patterns extracted from fabrik execution data.",
    "The system uses these to optimize future runs:",
    "- **Tier**: Criticality classification (T1-T4)",
    "- **Reviews**: Which reviewers to run",
    "- **Model**: Cost/quality level (cheap/standard/powerful)",
    "- **Gates**: Deterministic checks before LLM review",
    "",
    "## Summary",
    "",
    `| Total Patterns | ${patterns.length} |`,
    `| High Confidence (>80%) | ${patterns.filter(p => p.confidence > 0.8).length} |`,
    `| Total Learnings | ${patterns.reduce((sum, p) => sum + p.sampleSize, 0)} |`,
    ""
  ]
  
  for (const p of patterns) {
    lines.push(
      `## ${p.taskType} (Confidence: ${(p.confidence * 100).toFixed(0)}%, n=${p.sampleSize})`,
      "",
      "| Attribute | Value |",
      "|-----------|-------|",
      `| Tier | ${p.tier} |`,
      `| Reviews | ${p.reviews.join(", ") || "(none)"} |`,
      `| Model | ${p.model} |`,
      `| Gates | ${p.gates.join(", ")} |`,
      `| Avg Cost | $${p.avgCostUsd.toFixed(2)} |`,
      `| Avg Time | ${p.avgHours.toFixed(1)}h |`,
      "",
      "### When to Apply",
      "",
      describeWhenToApply(p.taskType),
      ""
    )
    
    if (p.notes && p.notes.length > 0) {
      lines.push(
        "### Team Notes",
        "",
        ...p.notes.map(n => `- ${n}`),
        ""
      )
    }
    
    lines.push("---", "")
  }
  
  lines.push(
    "## Manual Override Guide",
    "",
    "To override a pattern, edit this file directly:",
    "",
    "```markdown",
    "## task-type",
    "",
    "| Attribute | Value | Override |",
    "|-----------|-------|----------|",
    "| Tier | T2 | → T1 |",
    "| Model | standard | → powerful |",
    "",
    "### Team Notes",
    "- 2024-02-15: Changed tier after security review",
    "```",
    "",
    "The system will respect your overrides and learn from them."
  )
  
  return lines.join("\n")
}

function describeWhenToApply(taskType: string): string {
  const descriptions: Record<string, string> = {
    "auth": "- Authentication middleware\n- Session management\n- Permission checks",
    "api-endpoint": "- REST endpoints\n- GraphQL resolvers\n- Webhook handlers",
    "ui-styling": "- CSS/Tailwind changes\n- Component styling\n- Responsive adjustments",
    "db-migration": "- Schema changes\n- Index additions\n- Constraint updates",
    "test": "- Unit tests\n- Integration tests\n- Property-based tests",
    "observability": "- Logging\n- Metrics\n- Alerting"
  }
  return descriptions[taskType] || "- General feature work"
}

// =============================================================================
// VCS COMMIT
// =============================================================================

export type CommitResult = {
  success: boolean
  changeId?: string
  commitHash?: string
  error?: string
}

export function savePatternsToRepo(
  patterns: RepoPattern[],
  repoRoot: string,
  options?: { includeJson?: boolean }
): { mdPath: string; jsonPath?: string } {
  ensureFabrikDir(repoRoot)
  
  // Save markdown (human-readable)
  const mdContent = generatePatternsMarkdown(patterns)
  const mdPath = resolve(repoRoot, PATTERNS_FILE)
  writeFileSync(mdPath, mdContent)
  
  // Optionally save JSON (machine-readable)
  let jsonPath: string | undefined
  if (options?.includeJson) {
    jsonPath = resolve(repoRoot, PATTERNS_JSON)
    writeFileSync(jsonPath, JSON.stringify(patterns, null, 2))
  }
  
  return { mdPath, jsonPath }
}

export function commitLearnings(
  repoRoot: string,
  specId: string,
  stats: {
    ticketCount: number
    patternCount: number
    totalCost: number
    totalHours: number
    newPatterns: string[]
    updatedPatterns: string[]
  }
): CommitResult {
  try {
    // Check if we're in a jj or git repo
    const isJj = existsSync(join(repoRoot, ".jj"))
    const isGit = existsSync(join(repoRoot, ".git"))
    
    if (!isJj && !isGit) {
      return { success: false, error: "No VCS found (need .jj or .git)" }
    }
    
    // Stage files
    if (isJj) {
      // jj add
      runCommand("jj", ["add", ".fabrik/"], { cwd: repoRoot, context: "stage learnings" })
      
      // Create new change with message
      const message = buildCommitMessage(specId, stats)
      runCommand("jj", ["describe", "-m", message], { cwd: repoRoot, context: "describe learnings commit" })
      
      // Try to push
      try {
        runCommand("jj", ["git", "push", "--change", "@"], { cwd: repoRoot, context: "push learnings" })
      } catch {
        // Push failed, maybe no remote configured - that's ok
      }
      
      return { success: true }
    } else {
      // git add
      runCommand("git", ["add", ".fabrik/"], { cwd: repoRoot, context: "stage learnings" })
      
      // Commit
      const message = buildCommitMessage(specId, stats)
      runCommand("git", ["commit", "-m", message], { cwd: repoRoot, context: "commit learnings" })
      
      // Try to push
      try {
        runCommand("git", ["push"], { cwd: repoRoot, context: "push learnings" })
      } catch {
        // Push failed - ok
      }
      
      return { success: true }
    }
  } catch (error) {
    return { 
      success: false, 
      error: `Failed to commit learnings: ${error}` 
    }
  }
}

function buildCommitMessage(specId: string, stats: {
  ticketCount: number
  patternCount: number
  totalCost: number
  totalHours: number
  newPatterns: string[]
  updatedPatterns: string[]
}): string {
  const lines = [
    `fabrik: compound learnings from ${specId}`,
    "",
    `Stats:`,
    `- ${stats.ticketCount} tickets executed`,
    `- ${stats.patternCount} patterns (${stats.newPatterns.length} new, ${stats.updatedPatterns.length} updated)`,
    `- Cost: $${stats.totalCost.toFixed(2)}`,
    `- Time: ${stats.totalHours.toFixed(1)}h`,
    "",
    `Patterns:`,
    ...stats.newPatterns.map(p => `- ${p} (new)`),
    ...stats.updatedPatterns.map(p => `- ${p} (updated)`),
    "",
    "Auto-generated from fabrik execution data.",
    "[skip ci]"
  ]
  
  return lines.join("\n")
}

// =============================================================================
// LOAD PATTERNS
// =============================================================================

export function loadRepoPatterns(repoRoot: string): RepoPattern[] {
  // Try JSON first (machine-readable)
  const jsonPath = resolve(repoRoot, PATTERNS_JSON)
  if (existsSync(jsonPath)) {
    try {
      return JSON.parse(readFileSync(jsonPath, "utf8"))
    } catch {
      // Fall through to markdown
    }
  }
  
  // Extract from markdown (human-readable source of truth)
  const mdPath = resolve(repoRoot, PATTERNS_FILE)
  if (existsSync(mdPath)) {
    try {
      return parsePatternsFromMarkdown(readFileSync(mdPath, "utf8"))
    } catch {
      // Fall through to learnings
    }
  }
  
  // Auto-extract from learnings
  const learnings = loadLearnings(repoRoot)
  if (learnings.length > 0) {
    return extractPatterns(learnings)
  }
  
  return []
}

function parsePatternsFromMarkdown(content: string): RepoPattern[] {
  const patterns: RepoPattern[] = []
  const sections = content.split(/^## /m).slice(1) // Skip header
  
  for (const section of sections) {
    const lines = section.split("\n")
    const header = lines[0].trim()
    
    // Parse header: "task-type (Confidence: 80%, n=12)"
    const headerMatch = header.match(/^(.+?)\s*\(Confidence:\s*(\d+)%,\s*n=(\d+)\)/)
    if (!headerMatch) continue
    
    const taskType = headerMatch[1].trim()
    const confidence = parseInt(headerMatch[2]) / 100
    const sampleSize = parseInt(headerMatch[3])
    
    // Parse table
    const tableMatch = section.match(/\|[^|]+\|[^|]+\|[^\n]*\n\|[-|]+\n((?:\|[^|]+\|[^|]+\|[^\n]*\n?)+)/)
    if (!tableMatch) continue
    
    const tableRows = tableMatch[1].trim().split("\n")
    const attrs: Record<string, string> = {}
    
    for (const row of tableRows) {
      const match = row.match(/\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/)
      if (match) {
        attrs[match[1].trim().toLowerCase()] = match[2].trim()
      }
    }
    
    patterns.push({
      taskType,
      tier: (attrs["tier"] || "T3") as "T1" | "T2" | "T3" | "T4",
      reviews: attrs["reviews"] ? attrs["reviews"].split(", ").filter(r => r !== "(none)") : [],
      model: (attrs["model"] || "standard") as "cheap" | "standard" | "powerful",
      gates: attrs["gates"] ? attrs["gates"].split(", ") : ["lint", "typecheck", "build"],
      confidence,
      sampleSize,
      avgCostUsd: parseFloat(attrs["avg cost"]?.replace("$", "") || "1"),
      avgHours: parseFloat(attrs["avg time"]?.replace("h", "") || "1")
    })
  }
  
  return patterns
}

// =============================================================================
// RECOMMENDATIONS
// =============================================================================

export function recommendForTask(
  taskDescription: string,
  patterns: RepoPattern[]
): Partial<RepoPattern> & { confidence: number } {
  const normalized = taskDescription.toLowerCase()
  
  // Find matching pattern
  for (const pattern of patterns) {
    if (normalized.includes(pattern.taskType.toLowerCase())) {
      return { ...pattern, confidence: pattern.confidence }
    }
  }
  
  // Default recommendations based on keywords
  if (normalized.includes("money") || normalized.includes("payment") || normalized.includes("charge")) {
    return { tier: "T1", reviews: ["security", "correctness"], model: "powerful", gates: ["lint", "typecheck", "build", "test", "coverage"], confidence: 0, sampleSize: 0, avgCostUsd: 5, avgHours: 4, taskType: "money" }
  }
  
  if (normalized.includes("auth") || normalized.includes("security")) {
    return { tier: "T2", reviews: ["security", "code-quality"], model: "powerful", gates: ["lint", "typecheck", "build", "test"], confidence: 0, sampleSize: 0, avgCostUsd: 3, avgHours: 2, taskType: "auth" }
  }
  
  // Default to T3
  return { tier: "T3", reviews: ["code-quality"], model: "standard", gates: ["lint", "typecheck", "build", "test"], confidence: 0, sampleSize: 0, avgCostUsd: 1, avgHours: 1, taskType: "feature" }
}

// =============================================================================
// HELPERS
// =============================================================================

function inferTaskType(ticketId: string): string {
  const id = ticketId.toLowerCase()
  if (id.includes("auth") || id.includes("login") || id.includes("session")) return "auth"
  if (id.includes("api") || id.includes("endpoint")) return "api-endpoint"
  if (id.includes("ui") || id.includes("style") || id.includes("css")) return "ui-styling"
  if (id.includes("test") || id.includes("spec")) return "testing"
  if (id.includes("db") || id.includes("migration")) return "db-migration"
  if (id.includes("log") || id.includes("metric")) return "observability"
  return "feature"
}

function countBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of arr) {
    const key = keyFn(item)
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function maxKey(obj: Record<string, number>): string {
  return Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0] || ""
}
