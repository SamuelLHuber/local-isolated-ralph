/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CodexAgent, createSmithers, Workflow, Task } from "smithers-orchestrator";
import { z } from "zod";

const coder = new CodexAgent({
  model: process.env.SMITHERS_MODEL,
  sandbox: "workspace-write",
  skipGitRepoCheck: true,
});

const jjRepo = process.env.SMITHERS_JJ_REPO;
const jjBookmark = process.env.SMITHERS_JJ_BOOKMARK;
const jjBookmarkCommand = jjBookmark ?? "<bookmark>";

const { smithers, outputs } = createSmithers(
  {
    implementation: z.object({
      appName: z.string(),
      appDir: z.string(),
      filesCreated: z.array(z.string()),
      summary: z.string(),
      runCommands: z.array(z.string()),
    }),
    vcs: z.object({
      ok: z.boolean(),
      action: z.string(),
      appDir: z.string().optional(),
      detail: z.string().optional(),
    }),
  },
  { dbPath: "workflows/counter-app-agent.db" },
);

export default smithers((ctx) => {
  const appName = String(ctx.input.appName ?? "react-counter-app");
  const workdir = process.cwd();
  const appDir = join(workdir, appName);

  return (
    <Workflow name="build-react-counter-app-agentic">
      <Task id="prepare-repo" output={outputs.vcs} skipIf={!jjRepo}>
        {async () => {
          if (!jjRepo) return { ok: true, action: "skip" };
          if (existsSync(appDir)) {
            throw new Error(`Target path already exists: ${appDir}`);
          }
          await $`jj git clone ${jjRepo} ${appDir}`.cwd(workdir);
          return { ok: true, action: "clone", appDir };
        }}
      </Task>
      <Task id="ensure-target-dir" output={outputs.vcs} skipIf={Boolean(jjRepo)}>
        {() => {
          if (!existsSync(appDir)) {
            mkdirSync(appDir, { recursive: true });
          }
          return { ok: true, action: "mkdir", appDir };
        }}
      </Task>
      <Task id="implement-counter-app" output={outputs.implementation} agent={coder}>
        {`Create a simple React counter app in this workspace.

Working directory: ${workdir}
Target folder name: ${appName}
Target path: ${join(workdir, appName)}

Requirements:
- If SMITHERS_JJ_REPO is set, the repo is already cloned into the target path.
- If SMITHERS_JJ_REPO is not set, the target folder already exists.
- Build a Vite + React app in the target folder.
- Implement a counter UI with buttons for increment, decrement, and reset.
- Include minimal styling.
- Use pinned dependency versions only (no latest, ^, ~, *).
- Create the project files directly in the filesystem.
- Do not ask questions; complete the implementation now.
- Do not run any jj commands; workflow steps handle cloning and VCS updates.

After creating files, include in your JSON output:
- appName
- appDir
- filesCreated (relative paths under the app directory)
- summary
- runCommands (commands to run locally, e.g. npm install, npm run dev, npm run build)`}
      </Task>
      <Task id="commit-and-push" output={outputs.vcs} skipIf={!jjBookmark}>
        {async () => {
          if (!jjBookmark) return { ok: true, action: "skip" };
          const jjDir = join(appDir, ".jj");
          if (!existsSync(jjDir)) {
            throw new Error(`Missing .jj directory in ${appDir}`);
          }
          const diff = (await $`jj diff --summary -r @`.cwd(appDir).text()).trim();
          if (!diff) {
            return { ok: true, action: "skip", appDir, detail: "no changes" };
          }
          await $`jj commit -m ${`feat(counter-local): generate ${appName}`}`.cwd(appDir);
          await $`jj bookmark set ${jjBookmarkCommand} -r @`.cwd(appDir);
          await $`jj git push --bookmark ${jjBookmarkCommand}`.cwd(appDir);
          return { ok: true, action: "push", appDir };
        }}
      </Task>
    </Workflow>
  );
});
