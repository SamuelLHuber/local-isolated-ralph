/** @jsxImportSource smithers-orchestrator */
import { Task, Workflow, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { createCodexAgentWithPool } from "@dtechvision/fabrik-runtime/codex-auth";

const { smithers, outputs } = createSmithers(
  {
    report: z.object({
      filePath: z.string(),
      summary: z.string(),
      usedClusterPool: z.boolean(),
    }),
  },
  { dbPath: process.env.SMITHERS_DB_PATH ?? "/workspace/.smithers/state.db" },
);

const agent = createCodexAgentWithPool({
  model: process.env.SMITHERS_MODEL,
  sandbox: "workspace-write",
  skipGitRepoCheck: true,
  json: true,
});

export default smithers(() =>
  Workflow({
    name: "codex-auth-rotation-sample",
    children: Task({
      id: "generate",
      output: outputs.report,
      agent,
      children: `Create a file at tmp/codex-auth-rotation-proof.txt in this workspace.

Requirements:
- Write two short lines:
  1. "codex auth rotation sample"
  2. "run: <SMITHERS_RUN_ID or unknown>"
- Keep the file plain text.
- Assume credentials may come from a mounted auth pool handled by the runtime helper.

Return ONLY JSON with this shape:
{"filePath":"tmp/codex-auth-rotation-proof.txt","summary":"...","usedClusterPool":true}
`,
    }),
  }),
);
