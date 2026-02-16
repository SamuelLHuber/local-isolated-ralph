/**
 * Resume Module Tests
 *
 * Ensures proper run state preservation and fixes the critical bug where
 * `smithers resume` creates new runs instead of continuing existing ones.
 *
 * Tests cover:
 * - State analysis (finding stuck tasks, progress calculation)
 * - Stuck task reset (preserving completed work)
 * - Database truncation (for --fix mode)
 * - Resume script generation (proper state preservation)
 * - Integration flow (full resume lifecycle)
 *
 * German Engineering: Ordnung · Gründlichkeit · Sachlichkeit
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import {
  ResumeConfig,
  ResumeState,
  buildResumeScript,
  analyzeRunState,
  resetStuckTasks,
  truncateLargeEntries,
  resumeRun
} from "../resume.js"

// Mock the exec module
const mockRunCommandOutput = mock(async (_vm: string, _script: string) => "")

mock.module("../exec.js", () => ({
  runCommand: mock(async () => {}),
  runCommandOutput: mockRunCommandOutput
}))

describe("Resume Module", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `fabrik-resume-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    // Reset mock between tests
    mockRunCommandOutput.mockClear()
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  describe("buildResumeScript", () => {
    const baseConfig: ResumeConfig = {
      vmName: "ralph-1",
      controlDir: "/home/ralph/work/.runs/test-123",
      smithersRunnerDir: "/home/ralph/work/test-123/smithers-runner",
      reportsDir: "/home/ralph/work/.runs/test-123/reports",
      envVars: ["export FOO=bar"],
      fix: false
    }

    const completedState: ResumeState = {
      runId: "test-run-123",
      status: "running",
      completedTasks: 15,
      totalTasks: 18,
      stuckTasks: ["16:impl"],
      nextTask: "16:impl"
    }

    it("creates script that uses 'smithers run' not 'smithers resume'", () => {
      const script = buildResumeScript(baseConfig, "test-run-123", completedState)

      // CRITICAL: Must use 'smithers run' not 'smithers resume'
      expect(script).toInclude("smithers run workflow.tsx")
      expect(script).not.toInclude("smithers resume")
    })

    it("includes stuck task reset logic", () => {
      const script = buildResumeScript(baseConfig, "test-run-123", completedState)

      // Should reset in-progress tasks
      expect(script).toInclude("UPDATE _smithers_nodes SET state = 'pending'")
      expect(script).toInclude("WHERE state = 'in-progress'")
    })

    it("preserves completed tasks (does not reset finished)", () => {
      const script = buildResumeScript(baseConfig, "test-run-123", completedState)

      // Should NOT reset finished tasks
      expect(script).not.toInclude("state = 'finished'")
      // Only resets in-progress
      expect(script).toInclude("in-progress")
    })

    it("includes progress logging", () => {
      const script = buildResumeScript(baseConfig, "test-run-123", completedState)

      expect(script).toInclude("Completed: 15/18 tasks")
      expect(script).toInclude("Found existing run: test-run-123")
    })

    it("includes --fix mode database truncation", () => {
      const fixConfig = { ...baseConfig, fix: true }
      const script = buildResumeScript(fixConfig, "test-run-123", completedState)

      expect(script).toInclude("Running database fix")
      expect(script).toInclude("TRUNCATED")
      expect(script).toInclude("500000") // 500KB limit
    })

    it("works without existing run (fresh start)", () => {
      const freshState: ResumeState = {
        runId: null,
        status: null,
        completedTasks: 0,
        totalTasks: 0,
        stuckTasks: [],
        nextTask: null
      }

      const script = buildResumeScript(baseConfig, null, freshState)

      // Should still work without errors
      expect(script).toInclude("smithers run workflow.tsx")
      // No reset logic needed for fresh start
      expect(script).not.toInclude("Found existing run")
    })

    it("chooses workflow-dynamic.tsx when it exists", () => {
      // Create the dynamic workflow file
      const dynamicPath = join(tempDir, "workflow-dynamic.tsx")
      writeFileSync(dynamicPath, "// dynamic workflow")

      const configWithTemp = {
        ...baseConfig,
        smithersRunnerDir: tempDir
      }

      const script = buildResumeScript(configWithTemp, "test-run-123", completedState)

      expect(script).toInclude("smithers run workflow-dynamic.tsx")
    })

    it("falls back to workflow.tsx when dynamic doesn't exist", () => {
      // Only create regular workflow
      const regularPath = join(tempDir, "workflow.tsx")
      writeFileSync(regularPath, "// regular workflow")

      const configWithTemp = {
        ...baseConfig,
        smithersRunnerDir: tempDir
      }

      const script = buildResumeScript(configWithTemp, "test-run-123", completedState)

      expect(script).toInclude("smithers run workflow.tsx")
      expect(script).not.toInclude("workflow-dynamic")
    })

    it("includes all required environment setup", () => {
      const script = buildResumeScript(baseConfig, "test-run-123", completedState)

      expect(script).toInclude("export PATH=")
      expect(script).toInclude("source ~/.config/ralph/ralph.env")
      expect(script).toInclude("export GH_TOKEN=")
      expect(script).toInclude("export FOO=bar") // custom env vars
    })

    it("handles multiple stuck tasks", () => {
      const multiStuckState: ResumeState = {
        runId: "test-run-123",
        status: "running",
        completedTasks: 14,
        totalTasks: 18,
        stuckTasks: ["15:val", "16:impl", "16:val"],
        nextTask: "15:val"
      }

      const script = buildResumeScript(baseConfig, "test-run-123", multiStuckState)

      expect(script).toInclude("Resetting stuck tasks: 15:val, 16:impl, 16:val")
    })
  })

  describe("State Analysis", () => {
    it("parses completed run state correctly", async () => {
      const mockOutput = JSON.stringify({
        runId: "run-123",
        status: "running",
        completedTasks: 15,
        totalTasks: 18,
        stuckTasks: ["16:impl"],
        nextTask: "16:impl"
      })

      mockRunCommandOutput.mockResolvedValueOnce(mockOutput)

      const state = await analyzeRunState("ralph-1", "/path/to/db", "run-123")

      expect(state.runId).toBe("run-123")
      expect(state.completedTasks).toBe(15)
      expect(state.totalTasks).toBe(18)
      expect(state.stuckTasks).toEqual(["16:impl"])
      expect(state.nextTask).toBe("16:impl")
    })

    it("handles empty database gracefully", async () => {
      mockRunCommandOutput.mockResolvedValueOnce(JSON.stringify({
        runId: null,
        status: null,
        completedTasks: 0,
        totalTasks: 0,
        stuckTasks: [],
        nextTask: null
      }))

      const state = await analyzeRunState("ralph-1", "/path/to/db", null)

      expect(state.completedTasks).toBe(0)
      expect(state.stuckTasks).toEqual([])
    })

    it("handles database errors gracefully", async () => {
      mockRunCommandOutput.mockResolvedValueOnce("invalid json")

      const state = await analyzeRunState("ralph-1", "/path/to/db", "run-123")

      expect(state.runId).toBe("run-123") // Preserves input
      expect(state.completedTasks).toBe(0) // Safe defaults
      expect(state.stuckTasks).toEqual([])
    })

    it("identifies all stuck tasks correctly", async () => {
      mockRunCommandOutput.mockResolvedValueOnce(JSON.stringify({
        runId: "run-123",
        status: "running",
        completedTasks: 10,
        totalTasks: 18,
        stuckTasks: ["11:impl", "11:val", "12:impl"],
        nextTask: "11:impl"
      }))

      const state = await analyzeRunState("ralph-1", "/path/to/db", "run-123")

      expect(state.stuckTasks).toHaveLength(3)
      expect(state.stuckTasks).toContain("11:impl")
      expect(state.stuckTasks).toContain("11:val")
    })
  })

  describe("Stuck Task Reset", () => {
    it("resets in-progress tasks to pending", async () => {
      mockRunCommandOutput.mockResolvedValueOnce(JSON.stringify({
        reset: ["16:impl", "16:val"]
      }))

      const reset = await resetStuckTasks("ralph-1", "/path/to/db", "run-123")

      expect(reset).toEqual(["16:impl", "16:val"])
    })

    it("handles no stuck tasks gracefully", async () => {
      mockRunCommandOutput.mockResolvedValueOnce(JSON.stringify({
        reset: []
      }))

      const reset = await resetStuckTasks("ralph-1", "/path/to/db", "run-123")

      expect(reset).toEqual([])
    })

    it("handles database errors gracefully", async () => {
      mockRunCommandOutput.mockResolvedValueOnce("error")

      const reset = await resetStuckTasks("ralph-1", "/path/to/db", "run-123")

      expect(reset).toEqual([])
    })

    it("only resets in-progress, not finished or pending", async () => {
      mockRunCommandOutput.mockResolvedValueOnce(JSON.stringify({ reset: ["16:impl"] }))

      await resetStuckTasks("ralph-1", "/path/to/db", "run-123")

      const mockScript = mockRunCommandOutput.mock.calls[0]?.[1] as string || ""

      // The script should identify stuck tasks by their 'in-progress' state
      expect(mockScript).toInclude("state = 'in-progress'")
      expect(mockScript).toInclude("WHERE run_id")
      
      // And reset them TO 'pending'
      expect(mockScript).toInclude("SET state = 'pending'")
      expect(mockScript).toInclude("last_attempt = NULL")
    })
  })

  describe("Database Truncation", () => {
    it("truncates entries larger than maxSize", async () => {
      mockRunCommandOutput.mockResolvedValueOnce(JSON.stringify({
        truncated: 5,
        total: 10
      }))

      const result = await truncateLargeEntries("ralph-1", "/path/to/db", 500000)

      expect(result.truncated).toBe(5)
      expect(result.total).toBe(10)
    })

    it("uses default 500KB max size", async () => {
      await truncateLargeEntries("ralph-1", "/path/to/db")

      const script = mockRunCommandOutput.mock.calls[0]?.[1] as string || ""
      expect(script).toInclude("500000")
    })

    it("allows custom max size", async () => {
      await truncateLargeEntries("ralph-1", "/path/to/db", 100000)

      const script = mockRunCommandOutput.mock.calls[0]?.[1] as string || ""
      expect(script).toInclude("100000")
    })

    it("handles errors gracefully", async () => {
      mockRunCommandOutput.mockResolvedValueOnce(JSON.stringify({
        error: "database locked",
        truncated: 0,
        total: 0
      }))

      const result = await truncateLargeEntries("ralph-1", "/path/to/db")

      expect(result.truncated).toBe(0)
    })

    it("targets correct tables for truncation", async () => {
      await truncateLargeEntries("ralph-1", "/path/to/db")

      const script = mockRunCommandOutput.mock.calls[0]?.[1] as string || ""

      // Should check common smithers tables
      expect(script).toInclude("sqlite_master")
      expect(script).toInclude("PRAGMA table_info")
    })
  })

  describe("Full Resume Integration", () => {
    it("orchestrates complete resume flow", async () => {
      // Mock getSmithersRunId
      mockRunCommandOutput
        .mockResolvedValueOnce("existing-run-123") // getSmithersRunId
        .mockResolvedValueOnce(JSON.stringify({
          runId: "existing-run-123",
          status: "running",
          completedTasks: 15,
          totalTasks: 18,
          stuckTasks: ["16:impl"],
          nextTask: "16:impl"
        })) // analyzeRunState

      const config: ResumeConfig = {
        vmName: "ralph-1",
        controlDir: "/home/ralph/.runs/test",
        smithersRunnerDir: "/home/ralph/test/smithers-runner",
        reportsDir: "/home/ralph/.runs/test/reports",
        envVars: [],
        fix: false
      }

      const result = await resumeRun(config)

      expect(result.success).toBe(true)
      expect(result.smithersRunId).toBe("existing-run-123")
      expect(result.state.completedTasks).toBe(15)
      expect(result.script).toInclude("smithers run")
    })

    it("handles fresh start when no run exists", async () => {
      mockRunCommandOutput
        .mockResolvedValueOnce("") // getSmithersRunId returns empty
        .mockResolvedValueOnce(JSON.stringify({
          runId: null,
          status: null,
          completedTasks: 0,
          totalTasks: 0,
          stuckTasks: [],
          nextTask: null
        })) // analyzeRunState

      const config: ResumeConfig = {
        vmName: "ralph-1",
        controlDir: "/home/ralph/.runs/test",
        smithersRunnerDir: "/home/ralph/test/smithers-runner",
        reportsDir: "/home/ralph/.runs/test/reports",
        envVars: [],
        fix: false
      }

      const result = await resumeRun(config)

      expect(result.smithersRunId).toBeNull()
      expect(result.script).toInclude("smithers run")
    })
  })

  describe("Critical Bug Prevention", () => {
    it("NEVER uses 'smithers resume' command (the bug)", async () => {
      const config: ResumeConfig = {
        vmName: "ralph-1",
        controlDir: "/home/ralph/.runs/test",
        smithersRunnerDir: "/home/ralph/test/smithers-runner",
        reportsDir: "/home/ralph/.runs/test/reports",
        envVars: [],
        fix: false
      }

      const state: ResumeState = {
        runId: "existing-run",
        status: "running",
        completedTasks: 10,
        totalTasks: 18,
        stuckTasks: ["11:impl"],
        nextTask: "11:impl"
      }

      const script = buildResumeScript(config, "existing-run", state)

      // CRITICAL: The buggy command that creates new runs instead of resuming
      expect(script).not.toInclude("smithers resume")

      // CORRECT: Using smithers run which reads from existing DB
      expect(script).toInclude("smithers run")
    })

    it("preserves task completion state (doesn't start from task 1)", async () => {
      const state: ResumeState = {
        runId: "existing-run",
        status: "running",
        completedTasks: 15,
        totalTasks: 18,
        stuckTasks: ["16:impl"],
        nextTask: "16:impl"
      }

      const config: ResumeConfig = {
        vmName: "ralph-1",
        controlDir: "/home/ralph/.runs/test",
        smithersRunnerDir: "/home/ralph/test/smithers-runner",
        reportsDir: "/home/ralph/.runs/test/reports",
        envVars: [],
        fix: false
      }

      const script = buildResumeScript(config, "existing-run", state)

      // Should log progress showing we don't start from scratch
      expect(script).toInclude("Completed: 15/18 tasks")

      // Should show we're continuing, not restarting
      expect(script).toInclude("Continuing from: 16:impl")
    })

    it("uses same database file (state preservation)", async () => {
      const config: ResumeConfig = {
        vmName: "ralph-1",
        controlDir: "/home/ralph/.runs/test-123",
        smithersRunnerDir: "/home/ralph/test/smithers-runner",
        reportsDir: "/home/ralph/.runs/test-123/reports",
        envVars: ["export SMITHERS_DB_PATH=/home/ralph/.runs/test-123/.smithers/run.db"],
        fix: false
      }

      const script = buildResumeScript(config, "existing-run", {
        runId: "existing-run",
        status: "running",
        completedTasks: 15,
        totalTasks: 18,
        stuckTasks: [],
        nextTask: "16:impl"
      })

      // Should preserve the database path
      expect(script).toInclude("SMITHERS_DB_PATH=/home/ralph/.runs/test-123/.smithers/run.db")
    })
  })

  describe("Edge Cases", () => {
    it("handles corrupted database gracefully", async () => {
      mockRunCommandOutput.mockResolvedValueOnce("corrupted data")

      const state = await analyzeRunState("ralph-1", "/path/to/db", "run-123")

      // Should not crash
      expect(state).toBeDefined()
      expect(state.runId).toBe("run-123")
    })

    it("handles missing database file", async () => {
      mockRunCommandOutput.mockResolvedValueOnce(JSON.stringify({
        error: "No such file",
        runId: null,
        status: null,
        completedTasks: 0,
        totalTasks: 0,
        stuckTasks: [],
        nextTask: null
      }))

      const state = await analyzeRunState("ralph-1", "/nonexistent/db", null)

      expect(state.runId).toBeNull()
      expect(state.completedTasks).toBe(0)
    })

    it("handles all tasks completed", async () => {
      const allDoneState: ResumeState = {
        runId: "run-123",
        status: "running",
        completedTasks: 18,
        totalTasks: 18,
        stuckTasks: [],
        nextTask: null
      }

      const config: ResumeConfig = {
        vmName: "ralph-1",
        controlDir: "/home/ralph/.runs/test",
        smithersRunnerDir: "/home/ralph/test/smithers-runner",
        reportsDir: "/home/ralph/.runs/test/reports",
        envVars: [],
        fix: false
      }

      const script = buildResumeScript(config, "run-123", allDoneState)

      // Should still work, will likely finish quickly
      expect(script).toInclude("Completed: 18/18 tasks")
    })

    it("handles all tasks stuck", async () => {
      const allStuckState: ResumeState = {
        runId: "run-123",
        status: "failed",
        completedTasks: 0,
        totalTasks: 18,
        stuckTasks: ["1:impl", "1:val", "2:impl"],
        nextTask: "1:impl"
      }

      const config: ResumeConfig = {
        vmName: "ralph-1",
        controlDir: "/home/ralph/.runs/test",
        smithersRunnerDir: "/home/ralph/test/smithers-runner",
        reportsDir: "/home/ralph/.runs/test/reports",
        envVars: [],
        fix: false
      }

      const script = buildResumeScript(config, "run-123", allStuckState)

      // Should reset all stuck tasks
      expect(script).toInclude("Resetting stuck tasks: 1:impl, 1:val, 2:impl")
    })

    it("handles special characters in paths", async () => {
      const config: ResumeConfig = {
        vmName: "ralph-1",
        controlDir: "/home/ralph/.runs/test-123-with_spaces",
        smithersRunnerDir: "/home/ralph/test (special)/smithers-runner",
        reportsDir: "/home/ralph/.runs/test-123-with_spaces/reports",
        envVars: [],
        fix: false
      }

      const script = buildResumeScript(config, "run-123", {
        runId: "run-123",
        status: "running",
        completedTasks: 10,
        totalTasks: 18,
        stuckTasks: [],
        nextTask: "11:impl"
      })

      // Paths should be properly quoted in script
      expect(script).toInclude('cd "/home/ralph/test (special)/smithers-runner"')
    })
  })
})
