/**
 * Learning System Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { 
  recordLearning, 
  loadLearnings, 
  extractPatterns,
  generatePatternsMarkdown,
  savePatternsToRepo,
  loadRepoPatterns,
  recommendForTask,
  type Learning,
  type RepoPattern
} from "../learning"

describe("Learning System", () => {
  const testDir = join(tmpdir(), "fabrik-learning-test-" + Date.now())
  
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })
  
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })
  
  describe("recordLearning", () => {
    it("creates .fabrik directory if missing", () => {
      const learning: Learning = {
        timestamp: new Date().toISOString(),
        specId: "test-spec",
        ticketId: "1",
        tier: "T2",
        prediction: {
          estimatedHours: 2,
          reviewsRequired: ["security", "code-quality"],
          modelUsed: "standard",
          gatesRequired: ["lint", "typecheck", "build", "test"]
        },
        actual: {
          hoursSpent: 2.5,
          reviewIterations: 1,
          issuesFound: [],
          gatesPassed: true
        },
        effectiveness: "appropriate",
        costUsd: 2.50
      }
      
      recordLearning(learning, testDir)
      
      expect(existsSync(join(testDir, ".fabrik"))).toBe(true)
      expect(existsSync(join(testDir, ".fabrik/learnings.jsonl"))).toBe(true)
    })
    
    it("appends learning to jsonl file", () => {
      const learning1: Learning = {
        timestamp: "2024-01-01T00:00:00Z",
        specId: "test-spec",
        ticketId: "1",
        tier: "T2",
        prediction: {
          estimatedHours: 2,
          reviewsRequired: ["security"],
          modelUsed: "standard",
          gatesRequired: ["lint", "build"]
        },
        actual: {
          hoursSpent: 2,
          reviewIterations: 1,
          issuesFound: [],
          gatesPassed: true
        },
        effectiveness: "appropriate",
        costUsd: 2.50
      }
      
      const learning2: Learning = {
        timestamp: "2024-01-02T00:00:00Z",
        specId: "test-spec",
        ticketId: "2",
        tier: "T3",
        prediction: {
          estimatedHours: 1,
          reviewsRequired: [],
          modelUsed: "cheap",
          gatesRequired: ["lint", "build"]
        },
        actual: {
          hoursSpent: 1.5,
          reviewIterations: 0,
          issuesFound: [],
          gatesPassed: true
        },
        effectiveness: "appropriate",
        costUsd: 0.50
      }
      
      recordLearning(learning1, testDir)
      recordLearning(learning2, testDir)
      
      const learnings = loadLearnings(testDir)
      expect(learnings).toHaveLength(2)
      expect(learnings[0].ticketId).toBe("1")
      expect(learnings[1].ticketId).toBe("2")
    })
  })
  
  describe("loadLearnings", () => {
    it("returns empty array when no learnings exist", () => {
      const learnings = loadLearnings(testDir)
      expect(learnings).toHaveLength(0)
    })
    
    it("filters by date when 'since' option provided", () => {
      const oldLearning: Learning = {
        timestamp: "2024-01-01T00:00:00Z",
        specId: "test-spec",
        ticketId: "1",
        tier: "T2",
        prediction: {
          estimatedHours: 2,
          reviewsRequired: ["security"],
          modelUsed: "standard",
          gatesRequired: ["lint"]
        },
        actual: {
          hoursSpent: 2,
          reviewIterations: 1,
          issuesFound: [],
          gatesPassed: true
        },
        effectiveness: "appropriate",
        costUsd: 2.50
      }
      
      const newLearning: Learning = {
        timestamp: "2024-03-01T00:00:00Z",
        specId: "test-spec",
        ticketId: "2",
        tier: "T2",
        prediction: {
          estimatedHours: 2,
          reviewsRequired: ["security"],
          modelUsed: "standard",
          gatesRequired: ["lint"]
        },
        actual: {
          hoursSpent: 2,
          reviewIterations: 1,
          issuesFound: [],
          gatesPassed: true
        },
        effectiveness: "appropriate",
        costUsd: 2.50
      }
      
      recordLearning(oldLearning, testDir)
      recordLearning(newLearning, testDir)
      
      const recentLearnings = loadLearnings(testDir, { since: "2024-02-01T00:00:00Z" })
      expect(recentLearnings).toHaveLength(1)
      expect(recentLearnings[0].ticketId).toBe("2")
    })
  })
  
  describe("extractPatterns", () => {
    it("groups learnings by task type", () => {
      const learnings: Learning[] = [
        {
          timestamp: "2024-01-01T00:00:00Z",
          specId: "spec-1",
          ticketId: "api-task-1",
          tier: "T2",
          prediction: {
            estimatedHours: 2,
            reviewsRequired: ["security", "code-quality"],
            modelUsed: "standard",
            gatesRequired: ["lint", "test"]
          },
          actual: {
            hoursSpent: 2,
            reviewIterations: 1,
            issuesFound: [],
            gatesPassed: true
          },
          effectiveness: "appropriate",
          costUsd: 2.50,
          pattern: {
            taskType: "api-endpoint",
            recommendedTier: "T2",
            recommendedReviews: ["security", "code-quality"],
            recommendedModel: "standard",
            reasoning: "Test"
          }
        },
        {
          timestamp: "2024-01-02T00:00:00Z",
          specId: "spec-1",
          ticketId: "api-task-2",
          tier: "T2",
          prediction: {
            estimatedHours: 2,
            reviewsRequired: ["security", "code-quality"],
            modelUsed: "standard",
            gatesRequired: ["lint", "test"]
          },
          actual: {
            hoursSpent: 2,
            reviewIterations: 1,
            issuesFound: [],
            gatesPassed: true
          },
          effectiveness: "appropriate",
          costUsd: 2.50,
          pattern: {
            taskType: "api-endpoint",
            recommendedTier: "T2",
            recommendedReviews: ["security", "code-quality"],
            recommendedModel: "standard",
            reasoning: "Test"
          }
        }
      ]
      
      const patterns = extractPatterns(learnings)
      expect(patterns).toHaveLength(1)
      expect(patterns[0].taskType).toBe("api-endpoint")
      expect(patterns[0].sampleSize).toBe(2)
    })
    
    it("calculates confidence based on sample size", () => {
      const learnings: Learning[] = Array(5).fill(null).map((_, i) => ({
        timestamp: `2024-01-0${i + 1}T00:00:00Z`,
        specId: "spec-1",
        ticketId: `task-${i}`,
        tier: "T3",
        prediction: {
          estimatedHours: 1,
          reviewsRequired: [],
          modelUsed: "cheap",
          gatesRequired: ["lint"]
        },
        actual: {
          hoursSpent: 1,
          reviewIterations: 0,
          issuesFound: [],
          gatesPassed: true
        },
        effectiveness: "appropriate",
        costUsd: 0.30,
        pattern: {
          taskType: "ui-styling",
          recommendedTier: "T3",
          recommendedReviews: [],
          recommendedModel: "cheap",
          reasoning: "Test"
        }
      }))
      
      const patterns = extractPatterns(learnings)
      expect(patterns[0].confidence).toBe(0.5) // 5/10
      expect(patterns[0].sampleSize).toBe(5)
    })
  })
  
  describe("generatePatternsMarkdown", () => {
    it("generates valid markdown", () => {
      const patterns: RepoPattern[] = [
        {
          taskType: "api-endpoint",
          tier: "T2",
          reviews: ["security", "code-quality"],
          model: "standard",
          gates: ["lint", "typecheck", "build", "test"],
          confidence: 0.8,
          sampleSize: 12,
          avgCostUsd: 2.30,
          avgHours: 1.2
        }
      ]
      
      const markdown = generatePatternsMarkdown(patterns)
      expect(markdown).toInclude("# Fabrik Patterns")
      expect(markdown).toInclude("api-endpoint")
      expect(markdown).toInclude("T2")
      expect(markdown).toInclude("security, code-quality")
    })
    
    it("includes timestamp", () => {
      const patterns: RepoPattern[] = []
      const markdown = generatePatternsMarkdown(patterns)
      expect(markdown).toMatch(/Last updated: \d{4}-/)
    })
  })
  
  describe("loadRepoPatterns", () => {
    it("returns empty array when no patterns exist", () => {
      const patterns = loadRepoPatterns(testDir)
      expect(patterns).toHaveLength(0)
    })
    
    it("loads patterns from markdown file", () => {
      const mdContent = `# Fabrik Patterns

## api-endpoint (Confidence: 80%, n=12)

| Attribute | Value |
|-----------|-------|
| Tier | T2 |
| Reviews | security, code-quality |
| Model | standard |
| Gates | lint, typecheck, build, test |
| Avg Cost | $2.30 |
| Avg Time | 1.2h |
`
      
      mkdirSync(join(testDir, ".fabrik"), { recursive: true })
      writeFileSync(join(testDir, ".fabrik/patterns.md"), mdContent)
      
      const patterns = loadRepoPatterns(testDir)
      expect(patterns).toHaveLength(1)
      expect(patterns[0].taskType).toBe("api-endpoint")
      expect(patterns[0].tier).toBe("T2")
    })
  })
  
  describe("recommendForTask", () => {
    it("recommends based on patterns", () => {
      const patterns: RepoPattern[] = [
        {
          taskType: "api-endpoint",
          tier: "T2",
          reviews: ["security", "code-quality"],
          model: "standard",
          gates: ["lint", "test"],
          confidence: 0.8,
          sampleSize: 10,
          avgCostUsd: 2.50,
          avgHours: 1.5
        }
      ]
      
      // Test that it matches "api-endpoint" in the description
      const rec = recommendForTask("Create api-endpoint for users", patterns)
      expect(rec.taskType).toBe("api-endpoint")
      expect(rec.tier).toBe("T2")
      expect(rec.confidence).toBe(0.8)
    })
    
    it("falls back to keyword matching", () => {
      const patterns: RepoPattern[] = []
      
      const moneyRec = recommendForTask("Implement payment processing", patterns)
      expect(moneyRec.tier).toBe("T1")
      
      const authRec = recommendForTask("Add auth middleware", patterns)
      expect(authRec.tier).toBe("T2")
    })
  })
})
