/**
 * Workflow Validation Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { validateWorkflow, validateBeforeDispatch, checkReactCompatibility } from "../validate-workflow"

describe("Workflow Validation", () => {
  const testDir = join(tmpdir(), "fabrik-validate-test-" + Date.now())
  
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })
  
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })
  
  describe("validateWorkflow", () => {
    it("fails if file doesn't exist", () => {
      const result = validateWorkflow("/nonexistent/file.tsx")
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toInclude("not found")
    })
    
    it("requires @jsxImportSource pragma", () => {
      const content = `
import { createSmithers } from "smithers-orchestrator"
export default () => <div />
`
      const path = join(testDir, "workflow.tsx")
      writeFileSync(path, content)
      
      const result = validateWorkflow(path)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toInclude("@jsxImportSource")
    })
    
    it("warns if JSX pragma doesn't point to smithers", () => {
      const content = `/** @jsxImportSource react */
import { createSmithers } from "smithers-orchestrator"
export default () => <div />
`
      const path = join(testDir, "workflow.tsx")
      writeFileSync(path, content)
      
      const result = validateWorkflow(path)
      expect(result.warnings[0]).toInclude("smithers-orchestrator")
    })
    
    it("passes with correct pragma", () => {
      const content = `/** @jsxImportSource smithers-orchestrator */
import * as React from "react"
import { z } from "zod"
import { createSmithers } from "smithers-orchestrator"
export default () => <div />
`
      const path = join(testDir, "workflow.tsx")
      writeFileSync(path, content)
      
      const result = validateWorkflow(path)
      expect(result.valid).toBe(true)
    })
    
    it("warns about missing React import with JSX", () => {
      const content = `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator"
export default () => <div />
`
      const path = join(testDir, "workflow.tsx")
      writeFileSync(path, content)
      
      const result = validateWorkflow(path)
      expect(result.warnings.some(w => w.includes("React"))).toBe(true)
    })
    
    it("skipped - template literal check removed due to false positives", () => {
      // Template literal validation removed - regex approach couldn't distinguish
      // between actual nested templates and strings containing backticks
      expect(true).toBe(true)
    })
  })
  
  describe("checkReactCompatibility", () => {
    it("warns if no package.json found", () => {
      const result = checkReactCompatibility(testDir)
      expect(result.warnings[0]).toInclude("No package.json")
    })
    
    it("fails for React < 18", () => {
      const packageJson = {
        dependencies: { react: "^17.0.0" }
      }
      writeFileSync(join(testDir, "package.json"), JSON.stringify(packageJson))
      
      const result = checkReactCompatibility(testDir)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toInclude("React 18")
    })
    
    it("passes for React 18+", () => {
      const packageJson = {
        dependencies: { react: "^18.2.0" }
      }
      writeFileSync(join(testDir, "package.json"), JSON.stringify(packageJson))
      
      const result = checkReactCompatibility(testDir)
      expect(result.valid).toBe(true)
    })
    
    it("warns about duplicate React in deps and devDeps", () => {
      const packageJson = {
        dependencies: { react: "^18.2.0" },
        devDependencies: { react: "^18.0.0" }
      }
      writeFileSync(join(testDir, "package.json"), JSON.stringify(packageJson))
      
      const result = checkReactCompatibility(testDir)
      expect(result.warnings[0]).toInclude("both dependencies")
    })
  })
  
  describe("validateBeforeDispatch", () => {
    it("combines workflow and project validation", () => {
      const workflowContent = `/** @jsxImportSource smithers-orchestrator */
import * as React from "react"
import { z } from "zod"
import { createSmithers } from "smithers-orchestrator"
export default () => <div />
`
      const workflowPath = join(testDir, "workflow.tsx")
      writeFileSync(workflowPath, workflowContent)
      
      const packageJson = {
        dependencies: { react: "^18.2.0" }
      }
      writeFileSync(join(testDir, "package.json"), JSON.stringify(packageJson))
      
      const result = validateBeforeDispatch(workflowPath, testDir)
      expect(result.valid).toBe(true)
    })
  })
})
