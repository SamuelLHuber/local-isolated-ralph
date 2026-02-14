/**
 * Markdown Spec Parser Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { parseMarkdownSpec, isMarkdownSpec } from "../markdown-spec"

describe("Markdown Spec Parser", () => {
  const testDir = join(tmpdir(), "fabrik-test-" + Date.now())
  
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })
  
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })
  
  it("detects markdown files correctly", () => {
    expect(isMarkdownSpec("spec.md")).toBe(true)
    expect(isMarkdownSpec("spec.mdx")).toBe(true)
    expect(isMarkdownSpec("spec.json")).toBe(false)
    expect(isMarkdownSpec("spec.txt")).toBe(false)
  })
  
  it("parses basic markdown spec", () => {
    const content = `# Specification: Test Feature

## Overview
This is a test spec.

## Goals
- Goal 1: Implement X
- Goal 2: Support Y

## Non-Goals
- Out of scope

## Requirements
- API endpoint for X
- Validation for Y

## Acceptance Criteria
- User can do X
- Tests pass
`
    
    const path = join(testDir, "test-spec.md")
    writeFileSync(path, content)
    
    const parsed = parseMarkdownSpec(path)
    
    expect(parsed.source).toBe("markdown")
    expect(parsed.title).toBe("Specification: Test Feature")
    expect(parsed.goals).toHaveLength(2)
    expect(parsed.goals[0]).toBe("Goal 1: Implement X")
    expect(parsed.nonGoals).toHaveLength(1)
    expect(parsed.requirements.api).toContain("API endpoint for X")
  })
  
  it("extracts spec id from frontmatter", () => {
    const content = `---
id: test-feature-v1
---

# Test Feature

## Goals
- Test goal
`
    
    const path = join(testDir, "test-spec.md")
    writeFileSync(path, content)
    
    const parsed = parseMarkdownSpec(path)
    expect(parsed.id).toBe("test-feature-v1")
  })
  
  it("extracts spec id from filename", () => {
    const content = `# Test Feature

## Goals
- Test goal
`
    
    const path = join(testDir, "spec-test-feature.md")
    writeFileSync(path, content)
    
    const parsed = parseMarkdownSpec(path)
    expect(parsed.id).toBe("test-feature")
  })
  
  it("handles empty sections gracefully", () => {
    const content = `# Minimal Spec

## Overview
Minimal
`
    
    const path = join(testDir, "minimal.md")
    writeFileSync(path, content)
    
    const parsed = parseMarkdownSpec(path)
    expect(parsed.goals).toHaveLength(0)
    expect(parsed.nonGoals).toHaveLength(0)
    expect(parsed.acceptance).toHaveLength(0)
  })
  
  it("preserves raw content for agent context", () => {
    const content = `# Spec Title

## Overview
Overview text here.

## Goals
- Goal 1
- Goal 2
`
    
    const path = join(testDir, "test.md")
    writeFileSync(path, content)
    
    const parsed = parseMarkdownSpec(path)
    expect(parsed.raw).toBeDefined()
    expect(parsed.raw.length).toBeGreaterThan(0)
    expect(parsed.raw).toInclude("Spec Title")
  })
})

describe("Edge Cases", () => {
  const testDir = join(tmpdir(), "fabrik-test-edge-" + Date.now())
  
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })
  
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })
  
  it("handles numbered lists in sections", () => {
    const content = `# Numbered Spec

## Goals
1. First goal
2. Second goal
3. Third goal
`
    
    const path = join(testDir, "numbered.md")
    writeFileSync(path, content)
    
    const parsed = parseMarkdownSpec(path)
    expect(parsed.goals).toHaveLength(3)
    expect(parsed.goals[0]).toBe("First goal")
  })
  
  it("handles deeply nested list items", () => {
    const content = `# Nested Spec

## Goals
- Top level goal
  - Nested detail 1
  - Nested detail 2
- Another goal
`
    
    const path = join(testDir, "nested.md")
    writeFileSync(path, content)
    
    const parsed = parseMarkdownSpec(path)
    expect(parsed.goals.length).toBeGreaterThanOrEqual(1)
  })
  
  it("handles spec with no H1 title", () => {
    const content = `## Specification: Feature Name

## Goals
- Some goal
`
    
    const path = join(testDir, "no-h1.md")
    writeFileSync(path, content)
    
    const parsed = parseMarkdownSpec(path)
    expect(parsed.title).toInclude("Feature Name")
  })
})
