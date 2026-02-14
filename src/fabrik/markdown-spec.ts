/**
 * Markdown Spec Parser
 * 
 * Converts markdown specs (spec.md) to internal spec format.
 * Extracts structured sections like Goals, Non-Goals, etc.
 */

import { readFileSync } from "node:fs"
import { basename } from "node:path"

export type SpecSection = 
  | "overview" 
  | "goals" 
  | "nonGoals" 
  | "requirements" 
  | "acceptance" 
  | "assumptions"
  | "features"
  | "unknown"

export type ParsedSpec = {
  id: string
  title: string
  source: "markdown" | "json"
  goals: string[]
  nonGoals: string[]
  requirements: {
    api: string[]
    behavior: string[]
    observability: string[]
  }
  acceptance: string[]
  assumptions: string[]
  raw: string  // Full markdown for agent context
}

const sectionPatterns: { pattern: RegExp; section: SpecSection }[] = [
  { pattern: /^##?\s*Goals?$/im, section: "goals" },
  { pattern: /^##?\s*Non[- ]?Goals?$/im, section: "nonGoals" },
  { pattern: /^##?\s*(?:Requirements?|Req|API|Behavior)$/im, section: "requirements" },
  { pattern: /^##?\s*(?:Acceptance|Accept|Criteria)$/im, section: "acceptance" },
  { pattern: /^##?\s*(?:Assumptions?|Assume)$/im, section: "assumptions" },
  { pattern: /^##?\s*(?:Features?|Implementation)$/im, section: "features" },
  { pattern: /^##?\s*(?:Overview?|Summary|Background)$/im, section: "overview" },
]

function extractTitle(content: string): string {
  // Try H1 first
  const h1Match = content.match(/^#\s+(.+)$/m)
  if (h1Match) return h1Match[1].trim()
  
  // Try "Specification: " prefix
  const specMatch = content.match(/Specification:\s*(.+)$/m)
  if (specMatch) return specMatch[1].trim()
  
  return "Untitled Spec"
}

function extractId(path: string, content: string): string {
  // Try frontmatter
  const frontmatterMatch = content.match(/^---\s*\n[\s\S]*?id:\s*(.+?)\s*\n[\s\S]*?---/m)
  if (frontmatterMatch) return frontmatterMatch[1].trim()
  
  // Try filename
  const base = basename(path, ".md")
  if (base.startsWith("spec-")) return base.replace("spec-", "")
  if (base.startsWith("spec_")) return base.replace("spec_", "")
  
  // Generate from title
  const title = extractTitle(content)
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)
}

function extractListItems(content: string, startIdx: number): string[] {
  const items: string[] = []
  const lines = content.slice(startIdx).split("\n")
  
  let inList = false
  let currentItem = ""
  
  for (const line of lines) {
    // Check for list item
    const listMatch = line.match(/^(\s*)[-*+]\s+(.+)$/)
    const numberedMatch = line.match(/^(\s*)\d+\.\s+(.+)$/)
    
    if (listMatch || numberedMatch) {
      // Save previous item
      if (currentItem) items.push(currentItem.trim())
      
      // Start new item
      const match = listMatch || numberedMatch!
      currentItem = match[2]
      inList = true
    } else if (inList && line.match(/^\s{2,}/)) {
      // Continuation of list item
      currentItem += " " + line.trim()
    } else if (line.match(/^##?\s/)) {
      // Next section - stop
      break
    } else if (line.trim() === "") {
      // Empty line - might be end of list
      continue
    } else if (inList && !line.match(/^\s/)) {
      // Non-indented content after list - end
      break
    }
  }
  
  if (currentItem) items.push(currentItem.trim())
  return items.filter(i => i.length > 0)
}

function findSectionBounds(content: string, section: SpecSection): { start: number; end: number } | null {
  const pattern = sectionPatterns.find(p => p.section === section)?.pattern
  if (!pattern) return null
  
  const match = content.match(pattern)
  if (!match) return null
  
  const start = match.index! + match[0].length
  
  // Find next section or end of file
  const remaining = content.slice(start)
  let end = content.length
  
  for (const { pattern: nextPattern } of sectionPatterns) {
    const nextMatch = remaining.match(nextPattern)
    if (nextMatch && nextMatch.index !== undefined && nextMatch.index < end - start) {
      end = start + nextMatch.index
    }
  }
  
  return { start, end }
}

export function parseMarkdownSpec(path: string): ParsedSpec {
  const raw = readFileSync(path, "utf8")
  
  const id = extractId(path, raw)
  const title = extractTitle(raw)
  
  // Extract sections
  const goalsBounds = findSectionBounds(raw, "goals")
  const nonGoalsBounds = findSectionBounds(raw, "nonGoals")
  const reqBounds = findSectionBounds(raw, "requirements")
  const acceptBounds = findSectionBounds(raw, "acceptance")
  const assumeBounds = findSectionBounds(raw, "assumptions")
  
  const goals = goalsBounds ? extractListItems(raw, goalsBounds.start) : []
  const nonGoals = nonGoalsBounds ? extractListItems(raw, nonGoalsBounds.start) : []
  
  // Parse requirements into categories
  const reqItems = reqBounds ? extractListItems(raw, reqBounds.start) : []
  const requirements = {
    api: reqItems.filter(r => r.toLowerCase().includes("api") || r.toLowerCase().includes("endpoint")),
    behavior: reqItems.filter(r => !r.toLowerCase().includes("api") && !r.toLowerCase().includes("endpoint")),
    observability: reqItems.filter(r => r.toLowerCase().includes("log") || r.toLowerCase().includes("metric") || r.toLowerCase().includes("observ"))
  }
  
  // Distribute remaining requirements to behavior if empty
  if (requirements.behavior.length === 0 && reqItems.length > 0) {
    requirements.behavior = reqItems
  }
  
  const acceptance = acceptBounds ? extractListItems(raw, acceptBounds.start) : []
  const assumptions = assumeBounds ? extractListItems(raw, assumeBounds.start) : []
  
  return {
    id,
    title,
    source: "markdown",
    goals,
    nonGoals,
    requirements,
    acceptance,
    assumptions,
    raw
  }
}

export function isMarkdownSpec(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx")
}
