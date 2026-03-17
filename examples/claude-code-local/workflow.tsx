import {
  ClaudeCodeAgent,
  Ralph,
  Sequence,
  Task,
  Workflow,
  createSmithers,
} from "smithers-orchestrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const smithersDbPath =
  process.env.SMITHERS_DB_PATH ?? "workflows/claude-code-sample.db";
mkdirSync(dirname(smithersDbPath), { recursive: true });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const implementSchema = z.object({
  summary: z.string(),
  filesCreated: z.array(z.string()),
});

const reviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string()),
  summary: z.string(),
});

const { smithers, outputs } = createSmithers(
  {
    implement: implementSchema,
    review: reviewSchema,
  },
  { dbPath: smithersDbPath },
);

// ---------------------------------------------------------------------------
// Claude Code agent configuration
// ---------------------------------------------------------------------------
// Local (subscription):
//   ClaudeCodeAgent clears ANTHROPIC_API_KEY so `claude --print` uses the
//   interactive subscription login. No extra env vars needed.
//
// Cluster / CI (API billing):
//   Set ANTHROPIC_API_KEY in the env file passed via --env-file.
//   Optionally set ANTHROPIC_BASE_URL to route through a proxy.
//   Optionally set CLAUDE_MODEL to override the default model.
//
//   ClaudeCodeAgent always clears ANTHROPIC_API_KEY from the child process
//   env to force subscription billing. We work around this by:
//   1. Saving the key before construction
//   2. Deleting it from process.env so the constructor skip-path fires
//   3. Restoring it after construction so the child process inherits it
//
//   BaseCliAgent.generate() merges process.env first, then this.env on top.
//   Since the constructor didn't touch this.env (key was deleted before check),
//   the restored process.env.ANTHROPIC_API_KEY flows through to the child.

const savedApiKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const claudeModel =
  process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514";

// When ANTHROPIC_API_KEY is in the env (cluster/CI), use "user" settings
// so Claude reads from settings.json for model config. When running locally
// without a key, disable user-level settings to avoid personal config
// (proxy endpoints, custom models) from interfering.
const settingSources = savedApiKey ? "user" : "";

const coder = new ClaudeCodeAgent({
  model: claudeModel,
  systemPrompt:
    "You are a careful developer. Write clean, minimal code. Return ONLY the requested JSON.",
  timeoutMs: 10 * 60 * 1000,
  idleTimeoutMs: 5 * 60 * 1000,
  settingSources,
});

const reviewer = new ClaudeCodeAgent({
  model: claudeModel,
  systemPrompt:
    "You are a code reviewer. Inspect the workspace files and assess quality. Return ONLY the requested JSON.",
  timeoutMs: 10 * 60 * 1000,
  idleTimeoutMs: 5 * 60 * 1000,
  allowedTools: ["Read", "Bash"],
  settingSources,
});

// Restore the API key so the child claude process inherits it.
if (savedApiKey) {
  process.env.ANTHROPIC_API_KEY = savedApiKey;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default smithers((ctx) => {
  const latestReview = ctx.latest("review", "review") as
    | z.infer<typeof reviewSchema>
    | undefined;
  const approved = latestReview?.approved === true;

  return Workflow({
    name: "claude-code-sample",
    children: Ralph({
      id: "implement-review-loop",
      until: approved,
      maxIterations: 3,
      onMaxReached: "return-last",
      children: Sequence({
        children: [
          Task({
            key: "implement",
            id: "implement",
            output: outputs.implement,
            agent: coder,
            timeoutMs: 10 * 60 * 1000,
            retries: 1,
            children: `Create a minimal TODO app as a single HTML file at public/todo-app.html in this workspace.

Requirements:
- Single self-contained HTML file with embedded CSS and JavaScript.
- Add todo items via an input field and button.
- Mark items as completed by clicking them (strikethrough style).
- Delete items with a delete button.
- Show a count of remaining (uncompleted) items.
- Clean, readable code with semantic HTML.

${
  latestReview && !latestReview.approved
    ? `Previous review found these issues — fix them:\n${latestReview.issues.map((i) => `- ${i}`).join("\n")}`
    : ""
}

Return ONLY JSON with this shape:
{"summary": "...", "filesCreated": ["public/todo-app.html"]}`,
          }),
          Task({
            key: "review",
            id: "review",
            output: outputs.review,
            agent: reviewer,
            timeoutMs: 10 * 60 * 1000,
            retries: 1,
            children: `Review the TODO app at public/todo-app.html in this workspace.

Check for:
1. The file exists and contains valid HTML.
2. Add, complete (strikethrough), and delete functionality are present.
3. Remaining item count is displayed.
4. Code is clean and readable.
5. No external dependencies (self-contained).

Return ONLY JSON with this shape:
{"approved": true/false, "issues": ["issue 1", ...], "summary": "..."}`,
          }),
        ],
      }),
    }),
  });
});
