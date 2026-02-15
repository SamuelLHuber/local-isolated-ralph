# Smithers Runner

> Self-contained fabrik workflow runner using the smithers pattern.

## Architecture

This directory contains a **self-contained** workflow runner that follows the smithers sample pattern:

```
smithers-runner/
├── package.json          # Own dependencies (smithers-orchestrator, react, zod)
├── smithers.ts           # Central smithers setup (createSmithers)
├── workflow.tsx          # Main workflow using local smithers.ts
└── README.md
```

## How It Works

1. **Fabrik dispatches by syncing this directory** to the VM project folder
2. **Runner installs its own deps** via `bun install` (in runner dir, not project root)
3. **Executes workflow locally** with `bun run workflow.tsx` or `smithers resume`
4. **Project stays clean** - no smithers-orchestrator in main project node_modules

## Key Design

| Aspect | Old Approach | New Pattern |
|--------|--------------|-------------|
| **Dependencies** | Install smithers in project | Runner has its own package.json |
| **Imports** | From `"smithers-orchestrator"` directly | From local `./smithers.ts` |
| **Context** | Tried to use `useCtx()` hook | Pass `ctx` as prop from `smithers((ctx) => ...)` |
| **JSX** | Struggled with JSX runtime | Handled by smithers CLI |
| **Execution** | Complex VM dispatch | Simple `bun run workflow.tsx` |

## Dispatch Process

```bash
# 1. Fabrik syncs smithers-runner/ to VM
rsync smithers-runner/ → /home/ralph/work/.../smithers-runner/

# 2. Install deps in runner directory (not project root)
cd smithers-runner && bun install

# 3. Run workflow
bun run workflow.tsx
# or for resume:
smithers resume workflow.tsx

# 4. Workflow accesses project via ../ (parent directory)
```

## Workflow Access to Project

The workflow runs from `smithers-runner/` but can access the main project:

```tsx
// Access project files
const projectRoot = resolve("..");  // Parent of smithers-runner/
const srcFiles = readdirSync(join(projectRoot, "src"));

// Write to project
writeFileSync(join(projectRoot, "src/feature.ts"), code);

// Run commands in project
execSync("bun run build", { cwd: projectRoot });
```

## Benefits

✅ **Project stays clean** - No smithers dependencies in main package.json  
✅ **Self-contained** - Runner has everything it needs  
✅ **Works with smithers CLI** - Uses standard `smithers resume` pattern  
✅ **Type safe** - Local smithers.ts provides types  
✅ **Simple imports** - Just `import { Task } from "./smithers"`  

## Compared to Sample

This is essentially the same pattern as `@smitherssample/smithers-slop-factory-script/`:

- `smithers.ts` - Same purpose: central smithers setup
- `workflow.tsx` - Same pattern: `export default smithers((ctx) => ...)`
- Components import from `../smithers` - Same import pattern
- Run with `bun run workflow.tsx` - Same execution

The only difference: **fabrik syncs this directory** to the project VM instead of the project having it locally.
