/**
 * Workflow Validation
 *
 * Catches errors before VM dispatch:
 * - Type/syntax errors
 * - Missing imports
 * - JSX pragma issues
 * - Dependency version conflicts
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { runCommandOutput } from "./exec.js"

export type ValidationResult = {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Validate workflow file before dispatch
 */
export function validateWorkflow(workflowPath: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. Check file exists
  if (!existsSync(workflowPath)) {
    return { valid: false, errors: [`Workflow file not found: ${workflowPath}`], warnings: [] }
  }

  const source = readFileSync(workflowPath, "utf8")

  // 2. Check for JSX pragma - smithers workflows don't need one (handled by smithers CLI)
  // Only warn if using custom JSX runtime that might conflict
  if (source.includes("@jsxImportSource") && !source.includes("@jsxImportSource smithers-orchestrator")) {
    warnings.push("Custom @jsxImportSource detected - may conflict with smithers CLI")
  }

  if (source.includes("@jsxImportSource") && !source.includes("@jsxImportSource smithers-orchestrator")) {
    warnings.push("JSX pragma doesn't point to smithers-orchestrator (may cause runtime issues)")
  }

  // 3. React import check - for smithers workflows, React is provided by the framework
  // Only warn if explicitly using React hooks/context that would need it
  const hasReactImport = /import\s+\*?\s*as?\s+React\s+from\s+['"]react['"]/.test(source) ||
                         /import\s+React\s+from\s+['"]react['"]/.test(source)
  const usesReactDirectly = /React\.use[A-Z]/.test(source) || /React\.createElement/.test(source)
  
  if (usesReactDirectly && !hasReactImport) {
    warnings.push("React methods used but no React import found")
  }

  // 4. Check for required imports
  const requiredImports = [
    { name: "createSmithers", critical: true },
    { name: "zod", critical: false, pattern: /from\s+['"]zod['"]/ },
  ]

  for (const imp of requiredImports) {
    const pattern = imp.pattern || new RegExp(`import\\s*\\{[^}]*${imp.name}`)
    if (!pattern.test(source)) {
      const msg = `Missing import: ${imp.name}`
      if (imp.critical) {
        errors.push(msg)
      } else {
        warnings.push(msg)
      }
    }
  }

  // 5. Check for common syntax issues
  // Unclosed JSX tags
  const openTags = (source.match(/<[A-Z][a-zA-Z]*/g) || []).length
  const closeTags = (source.match(/<\/[A-Z][a-zA-Z]*/g) || []).length
  const selfClosing = (source.match(/\/>/g) || []).length
  
  // Rough check - not perfect but catches obvious issues
  if (openTags > closeTags + selfClosing + 1) { // +1 for flexibility
    warnings.push(`Potentially unclosed JSX tags (open: ${openTags}, close: ${closeTags + selfClosing})`)
  }

  // 6. Template literal check removed - regex approach had too many false positives
  // TypeScript compilation (step 7) will catch actual syntax errors

  // 7. Try TypeScript compilation check if tsc is available
  const tsCheck = checkTypeScript(workflowPath)
  // Only add as error if tsc is available and compilation actually failed
  // If tsc not found, it's just a warning (optional validation)
  if (!tsCheck.valid && !tsCheck.warnings.some(w => w.includes("not installed"))) {
    errors.push(...tsCheck.errors)
  }
  warnings.push(...tsCheck.warnings)

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

/**
 * Run TypeScript compiler check
 */
function checkTypeScript(workflowPath: string): ValidationResult {
  try {
    // Check if tsc is available (don't throw, just check)
    try {
      runCommandOutput("which", ["tsc"], { context: "check tsc" })
    } catch {
      // tsc not available - this is OK, just skip type checking
      return {
        valid: true,
        errors: [],
        warnings: ["TypeScript not installed, skipping type check (install with: bun add -d typescript)"]
      }
    }
    
    // Try to compile with strict checks
    const dir = dirname(workflowPath)
    runCommandOutput(
      "tsc",
      ["--noEmit", "--skipLibCheck", "--jsx", "react-jsx", workflowPath],
      { context: "type check workflow", cwd: dir }
    )
    
    return { valid: true, errors: [], warnings: [] }
  } catch (error) {
    // Compilation failed
    return {
      valid: false,
      errors: [`TypeScript compilation failed: ${error}`],
      warnings: []
    }
  }
}

/**
 * Check if React version is compatible
 */
export function checkReactCompatibility(projectPath: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  try {
    // Read project's package.json
    const packageJsonPath = join(projectPath, "package.json")
    if (!existsSync(packageJsonPath)) {
      return { valid: true, errors: [], warnings: ["No package.json found, skipping React version check"] }
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
    const reactVersion = packageJson.dependencies?.react || packageJson.devDependencies?.react
    
    if (reactVersion) {
      // smithers-orchestrator typically needs React 18+
      const majorVersion = parseInt(reactVersion.match(/\d+/)?.[0] || "0")
      
      if (majorVersion < 18) {
        errors.push(`React version ${reactVersion} may be incompatible with smithers-orchestrator (needs React 18+)`)
      }
      
      // Check for conflicting React versions
      if (packageJson.dependencies?.react && packageJson.devDependencies?.react) {
        warnings.push("React in both dependencies and devDependencies (potential version conflict)")
      }
    }

    // Check for smithers-orchestrator
    const smithersVersion = packageJson.dependencies?.["smithers-orchestrator"] || 
                            packageJson.devDependencies?.["smithers-orchestrator"]
    
    if (!smithersVersion) {
      warnings.push("smithers-orchestrator not in package.json (will be installed at runtime)")
    }

  } catch (error) {
    warnings.push(`Could not check React compatibility: ${error}`)
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Full validation before dispatch
 */
export function validateBeforeDispatch(
  workflowPath: string,
  projectPath?: string
): ValidationResult {
  const workflowValidation = validateWorkflow(workflowPath)
  
  if (!workflowValidation.valid) {
    return workflowValidation
  }

  // Additional checks if project path provided
  if (projectPath) {
    const reactCheck = checkReactCompatibility(projectPath)
    return {
      valid: workflowValidation.valid && reactCheck.valid,
      errors: [...workflowValidation.errors, ...reactCheck.errors],
      warnings: [...workflowValidation.warnings, ...reactCheck.warnings]
    }
  }

  return workflowValidation
}

/**
 * Print validation results
 */
export function printValidationResults(result: ValidationResult): void {
  if (result.errors.length > 0) {
    console.error("❌ Workflow validation failed:")
    for (const error of result.errors) {
      console.error(`   - ${error}`)
    }
  }

  if (result.warnings.length > 0) {
    console.warn("⚠️  Workflow warnings:")
    for (const warning of result.warnings) {
      console.warn(`   - ${warning}`)
    }
  }

  if (result.valid && result.warnings.length === 0) {
    console.log("✅ Workflow validation passed")
  }
}
