/** @jsxImportSource smithers-orchestrator */
import { join } from "node:path";
import { CodexAgent, createSmithers, Workflow, Task } from "smithers-orchestrator";
import { z } from "zod";

const coder = new CodexAgent({
  model: process.env.SMITHERS_MODEL,
  sandbox: "workspace-write",
  skipGitRepoCheck: true,
});

const { smithers, outputs } = createSmithers(
  {
    implementation: z.object({
      appName: z.string(),
      appDir: z.string(),
      filesCreated: z.array(z.string()),
      summary: z.string(),
      runCommands: z.array(z.string()),
    }),
  },
  { dbPath: "workflows/counter-app-agent.db" },
);

export default smithers((ctx) => {
  const appName = String(ctx.input.appName ?? "react-counter-app");
  const workdir = process.cwd();

  return (
    <Workflow name="build-react-counter-app-agentic">
      <Task id="implement-counter-app" output={outputs.implementation} agent={coder}>
        {`Create a simple React counter app in this workspace.

Working directory: ${workdir}
Target folder name: ${appName}
Target path: ${join(workdir, appName)}

Requirements:
- Build a Vite + React app in the target folder.
- Implement a counter UI with buttons for increment, decrement, and reset.
- Include minimal styling.
- Use pinned dependency versions only (no latest, ^, ~, *).
- Create the project files directly in the filesystem.
- Do not ask questions; complete the implementation now.

After creating files, include in your JSON output:
- appName
- appDir
- filesCreated (relative paths under the app directory)
- summary
- runCommands (commands to run locally, e.g. npm install, npm run dev, npm run build)`}
      </Task>
    </Workflow>
  );
});
