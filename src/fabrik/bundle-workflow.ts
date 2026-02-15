/**
 * Bundle workflow to standalone JS
 * Removes all external dependencies (smithers-orchestrator, React)
 * So the workflow can run without polluting the project
 */

import { buildSync } from "esbuild"
import { readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function bundleWorkflow(workflowPath: string): string {
  // Read the workflow
  const workflowSource = readFileSync(workflowPath, "utf8")
  
  // Create a temporary file for the bundled output
  const bundledPath = join(tmpdir(), `smithers-workflow-${Date.now()}.js`)
  
  try {
    // Bundle with esbuild
    buildSync({
      entryPoints: [workflowPath],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      outfile: bundledPath,
      external: [], // Bundle everything
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      banner: {
        js: `
// Self-contained smithers workflow - bundled with all dependencies
// This file has no external imports and can run standalone
`,
      },
    })
    
    return bundledPath
  } catch (error) {
    // If esbuild fails, try a simpler approach
    // Just return the original path and let smithers handle it
    console.warn(`Warning: Could not bundle workflow: ${error}`)
    return workflowPath
  }
}

/**
 * Alternative: Create a wrapper that makes imports resolve to global smithers
 */
export function createWorkflowWrapper(
  workflowPath: string,
  globalSmithersPath: string
): string {
  const wrapperPath = join(tmpdir(), `smithers-workflow-wrapper-${Date.now()}.js`)
  
  const wrapperContent = `
#!/usr/bin/env node
// Wrapper to make workflow imports resolve to global smithers

const Module = require('module');
const originalResolveFilename = Module._resolveFilename;

// Intercept smithers-orchestrator imports
Module._resolveFilename = function(request, parent, isMain) {
  if (request === 'smithers-orchestrator' || request.startsWith('smithers-orchestrator/')) {
    return require.resolve('${globalSmithersPath}');
  }
  if (request === 'react' || request === 'react-dom') {
    // Use smithers's bundled React
    return require.resolve('${globalSmithersPath}/../react');
  }
  return originalResolveFilename(request, parent, isMain);
};

// Now run the actual workflow
require('${workflowPath.replace(/\/g, '\\')}');
`
  
  writeFileSync(wrapperPath, wrapperContent, "utf8")
  return wrapperPath
}
