import { createSmithers, Task, Workflow } from "smithers-orchestrator";
import { createCodexAgentWithPool } from "@dtechvision/fabrik-runtime/codex-auth";
import { z } from "zod";

const { smithers, outputs } = createSmithers(
  {
    page: z.object({
      filePath: z.string(),
      html: z.string(),
      summary: z.string(),
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
    name: "hello-world-agent",
    children: Task({
      id: "generate",
      output: outputs.page,
      agent,
      children: `Create a file at public/hello-world.html in this workspace with valid HTML that renders a single "Hello, world." heading.

Requirements:
- Create the file directly on disk.
- Keep HTML minimal and valid.

Return ONLY JSON with this shape:
{"filePath":"public/hello-world.html","html":"<!doctype html>...","summary":"..."}
`,
    }),
  }),
);
