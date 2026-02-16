/**
 * Resume Module - Proper Run State Preservation
 * 
 * Fixes the critical bug where `smithers resume` creates new runs instead of
 * continuing existing ones. Uses direct database state manipulation to:
 * 1. Find the latest run for a given fabrik run ID
 * 2. Reset stuck 'in-progress' tasks to 'pending'
 * 3. Preserve all completed work (tasks 1-N finished)
 * 4. Continue from the first pending task
 * 
 * German Engineering: Ordnung · Gründlichkeit · Sachlichkeit
 */

import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { homedir } from "node:os"
import { runCommand, runCommandOutput } from "./exec.js"

export interface ResumeConfig {
  vmName: string
  controlDir: string
  smithersRunnerDir: string
  reportsDir: string
  envVars: string[]
  fix?: boolean
}

export interface ResumeState {
  runId: string | null
  status: "running" | "finished" | "failed" | "cancelled" | null
  completedTasks: number
  totalTasks: number
  stuckTasks: string[]
  nextTask: string | null
}

/**
 * Get the latest smithers run ID from the database
 */
export async function getSmithersRunId(
  vmName: string, 
  smithersDbPath: string
): Promise<string | null> {
  const script = `python3 << 'PYSCRIPT'
import sqlite3
import sys
db_path = "${smithersDbPath}"
try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT run_id FROM _smithers_runs WHERE status IN ('running', 'failed') ORDER BY started_at_ms DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    if row:
        print(row[0])
    else:
        print("")
except Exception as e:
    print("")
PYSCRIPT`

  const result = await runCommandOutput(vmName, script)
  return result.trim() || null
}

/**
 * Analyze the current state of a run
 */
export async function analyzeRunState(
  vmName: string,
  smithersDbPath: string,
  smithersRunId: string | null
): Promise<ResumeState> {
  const script = `python3 << 'PYSCRIPT'
import sqlite3
import json
import sys

db_path = "${smithersDbPath}"
run_id = "${smithersRunId || ''}"

try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Get run status
    if run_id:
        cursor.execute("SELECT status FROM _smithers_runs WHERE run_id = ?", (run_id,))
        row = cursor.fetchone()
        status = row[0] if row else None
    else:
        status = None
    
    # Get all task states for this run
    if run_id:
        cursor.execute("""
            SELECT node_id, state 
            FROM _smithers_nodes 
            WHERE run_id = ? AND (node_id LIKE '%:impl' OR node_id LIKE '%:val')
            ORDER BY node_id
        """, (run_id,))
    else:
        # Get from all runs
        cursor.execute("""
            SELECT node_id, state 
            FROM _smithers_nodes 
            WHERE node_id LIKE '%:impl' OR node_id LIKE '%:val'
            ORDER BY updated_at_ms DESC
        """)
    
    rows = cursor.fetchall()
    
    # Calculate progress
    total = len(rows)
    finished = sum(1 for r in rows if r[1] == 'finished')
    stuck = [r[0] for r in rows if r[1] == 'in-progress']
    
    # Find next pending task
    pending = [r[0] for r in rows if r[1] == 'pending']
    next_task = pending[0] if pending else None
    
    conn.close()
    
    result = {
        "runId": run_id,
        "status": status,
        "completedTasks": finished,
        "totalTasks": total,
        "stuckTasks": stuck,
        "nextTask": next_task
    }
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({"error": str(e)}))
PYSCRIPT`

  const output = await runCommandOutput(vmName, script)
  
  try {
    return JSON.parse(output.trim()) as ResumeState
  } catch {
    return {
      runId: smithersRunId,
      status: null,
      completedTasks: 0,
      totalTasks: 0,
      stuckTasks: [],
      nextTask: null
    }
  }
}

/**
 * Reset stuck tasks to pending state
 */
export async function resetStuckTasks(
  vmName: string,
  smithersDbPath: string,
  smithersRunId: string
): Promise<string[]> {
  const script = `python3 << 'PYSCRIPT'
import sqlite3
import json

db_path = "${smithersDbPath}"
run_id = "${smithersRunId}"

try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Find stuck tasks
    cursor.execute("""
        SELECT node_id 
        FROM _smithers_nodes 
        WHERE run_id = ? AND state = 'in-progress'
    """, (run_id,))
    
    stuck = [row[0] for row in cursor.fetchall()]
    
    # Reset them to pending
    for task_id in stuck:
        cursor.execute("""
            UPDATE _smithers_nodes 
            SET state = 'pending', last_attempt = NULL 
            WHERE run_id = ? AND node_id = ? AND state = 'in-progress'
        """, (run_id, task_id))
    
    conn.commit()
    conn.close()
    
    print(json.dumps({"reset": stuck}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
PYSCRIPT`

  const output = await runCommandOutput(vmName, script)
  
  try {
    const result = JSON.parse(output.trim()) as { reset?: string[], error?: string }
    return result.reset || []
  } catch {
    return []
  }
}

/**
 * Truncate large database entries (for --fix mode)
 */
export async function truncateLargeEntries(
  vmName: string,
  smithersDbPath: string,
  maxSize: number = 500000  // 500KB
): Promise<{ truncated: number, total: number }> {
  const script = `python3 << 'PYSCRIPT'
import sqlite3
import json

db_path = "${smithersDbPath}"
max_size = ${maxSize}

try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Find all tables that might have large content
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]
    
    truncated = 0
    total_checked = 0
    
    for table in tables:
        # Get column names
        cursor.execute(f"PRAGMA table_info({table})")
        columns = [row[1] for row in cursor.fetchall()]
        
        # Check text/blob columns
        for col in columns:
            cursor.execute(f"""
                SELECT rowid, {col} FROM {table} 
                WHERE typeof({col}) = 'text' AND length({col}) > ?
            """, (max_size,))
            
            rows = cursor.fetchall()
            total_checked += len(rows)
            
            for rowid, content in rows:
                # Keep last 500KB, truncate rest
                truncated_content = content[-max_size:] + f"...[TRUNCATED: was {len(content)} chars]"
                cursor.execute(f"""
                    UPDATE {table} SET {col} = ? WHERE rowid = ?
                """, (truncated_content, rowid))
                truncated += 1
    
    conn.commit()
    conn.close()
    
    print(json.dumps({"truncated": truncated, "total": total_checked}))
except Exception as e:
    print(json.dumps({"error": str(e), "truncated": 0, "total": 0}))
PYSCRIPT`

  const output = await runCommandOutput(vmName, script)
  
  try {
    return JSON.parse(output.trim()) as { truncated: number, total: number }
  } catch {
    return { truncated: 0, total: 0 }
  }
}

/**
 * Build the proper resume script that preserves state
 */
export function buildResumeScript(
  config: ResumeConfig,
  smithersRunId: string | null,
  state: ResumeState
): string {
  const { smithersRunnerDir, reportsDir, envVars, fix } = config
  const workflowFile = existsSync(`${smithersRunnerDir}/workflow-dynamic.tsx`)
    ? "workflow-dynamic.tsx"
    : "workflow.tsx"

  // Build the script parts
  const parts: string[] = [
    `cd "${smithersRunnerDir}"`,
    'export PATH="$HOME/.bun/bin:$HOME/.bun/install/global/node_modules/.bin:$PATH"',
    "if [ -f ~/.config/ralph/ralph.env ]; then set -a; source ~/.config/ralph/ralph.env; set +a; fi",
    "if [ -n \"${GITHUB_TOKEN:-}\" ]; then export GH_TOKEN=\"${GITHUB_TOKEN}\"; fi",
    ...envVars,
  ]

  // Add state reset logic if we have a run ID
  if (smithersRunId) {
    parts.push(`echo "[resume] Found existing run: ${smithersRunId}"`)
    parts.push(`echo "[resume] Completed: ${state.completedTasks}/${state.totalTasks} tasks"`)
    
    if (state.stuckTasks.length > 0) {
      parts.push(`echo "[resume] Resetting stuck tasks: ${state.stuckTasks.join(', ')}"`)
    }
    
    if (state.nextTask) {
      parts.push(`echo "[resume] Continuing from: ${state.nextTask}"`)
    }

    // Reset stuck tasks before running
    parts.push(`python3 << 'PYRESET'
import sqlite3
import os
db_path = os.environ.get('SMITHERS_DB_PATH', '')
if db_path and db_path != 'undefined':
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        # Reset all in-progress to pending
        cursor.execute("UPDATE _smithers_nodes SET state = 'pending', last_attempt = NULL WHERE state = 'in-progress'")
        conn.commit()
        conn.close()
        print(f"[resume] Reset {cursor.rowcount} stuck tasks")
    except Exception as e:
        print(f"[resume] Reset warning: {e}")
PYRESET`)
  }

  // Add fix mode truncation if requested
  if (fix) {
    parts.push(`echo "[resume] Running database fix (truncating large entries)..."`)
    parts.push(`python3 << 'PYFIX'
import sqlite3
import os
db_path = os.environ.get('SMITHERS_DB_PATH', '')
max_size = 500000
if db_path and db_path != 'undefined':
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        truncated = 0
        for table in ['_smithers_cache', '_smithers_events', '_smithers_tool_calls']:
            try:
                cursor.execute(f"SELECT rowid, result FROM {table} WHERE length(result) > ?", (max_size,))
                for rowid, content in cursor.fetchall():
                    new_content = content[-max_size:] + f"...[TRUNCATED: was {len(content)} chars]"
                    cursor.execute(f"UPDATE {table} SET result = ? WHERE rowid = ?", (new_content, rowid))
                    truncated += 1
            except:
                pass
        conn.commit()
        conn.close()
        print(f"[resume] Truncated {truncated} large entries")
    except Exception as e:
        print(f"[resume] Fix warning: {e}")
PYFIX`)
  }

  // Run the workflow - it will read existing state from DB
  parts.push(`echo "[resume] Starting workflow: ${workflowFile}"`)
  parts.push(`smithers run ${workflowFile} 2>&1 | tee -a "${reportsDir}/smithers-resume.log"`)

  return parts.join("\n")
}

/**
 * Resume a run with proper state preservation
 */
export async function resumeRun(config: ResumeConfig): Promise<{
  success: boolean
  smithersRunId: string | null
  state: ResumeState
  script: string
}> {
  const { vmName, controlDir } = config
  
  // Find the smithers DB path
  const smithersDbPath = resolve(controlDir, ".smithers", "run.db")
  
  // Get the existing run ID
  const smithersRunId = await getSmithersRunId(vmName, smithersDbPath)
  
  // Analyze the state
  const state = await analyzeRunState(vmName, smithersDbPath, smithersRunId)
  
  // Build the resume script
  const script = buildResumeScript(config, smithersRunId, state)
  
  return {
    success: true,
    smithersRunId,
    state,
    script
  }
}
