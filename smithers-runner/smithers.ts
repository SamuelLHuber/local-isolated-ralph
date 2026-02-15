/**
 * Smithers Setup
 * 
 * Central configuration for all smithers components.
 * Import from here, not directly from smithers-orchestrator.
 */

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

// Define output schemas for type safety
export const outputSchemas = {
  discover: z.object({
    v: z.literal(1),
    tickets: z.array(z.object({
      id: z.string(),
      title: z.string(),
      tier: z.enum(["T1", "T2", "T3", "T4"]),
      description: z.string(),
      acceptanceCriteria: z.array(z.string()),
      dependencies: z.array(z.string()).nullable(),
      layersRequired: z.array(z.enum(["L1", "L2", "L3", "L4", "L5", "L6"])),
      reviewsRequired: z.array(z.string()),
      gates: z.array(z.enum(["lint", "typecheck", "build", "test", "coverage"])),
      model: z.enum(["cheap", "standard", "powerful"]),
    })).max(5),
    reasoning: z.string(),
    batchComplete: z.boolean(),
  }),
  
  gate: z.object({
    v: z.literal(1),
    passed: z.boolean(),
    command: z.string(),
    output: z.string(),
    durationMs: z.number(),
  }),
  
  report: z.object({
    v: z.literal(1),
    taskId: z.string(),
    tier: z.string(),
    status: z.enum(["done", "blocked", "failed"]),
    work: z.array(z.string()),
    files: z.array(z.string()),
    tests: z.array(z.string()),
    gates: z.array(z.any()),
    issues: z.array(z.string()),
    next: z.array(z.string()),
  }),
  
  finalReview: z.object({
    v: z.number(),
    reviewer: z.string().optional(),
    status: z.enum(["approved", "changes_requested"]),
    issues: z.array(z.string()).optional(),
    next: z.array(z.string()).optional(),
    reviewers: z.array(z.string()).optional(),
    approvedBy: z.array(z.string()).optional(),
    rejectedBy: z.array(z.string()).optional(),
    allIssues: z.array(z.string()).optional(),
    summary: z.string().optional(),
  }),
};

// Create smithers instance
export const { Workflow, Task, smithers, tables, db } = createSmithers(
  outputSchemas,
  { dbPath: process.env.SMITHERS_DB_PATH || "./.smithers/workflow.db" }
);

// Re-export types
export type { TaskContext } from "smithers-orchestrator";
