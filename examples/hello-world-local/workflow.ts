import { createSmithers, CodexAgent, Ralph, Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, outputs } = createSmithers(
  {
    page: z.object({
      html: z.string(),
      done: z.boolean(),
    }),
  },
  { dbPath: "workflows/hello-world-agent.db" },
);

const agent = new CodexAgent({ json: true });

export default smithers((ctx) => {
  const latest = ctx.latest("page", "generate");
  const done = latest?.done === true;

  return Workflow({
    name: "hello-world-agent",
    children: [
      Ralph({
        key: "loop",
        id: "loop",
        until: done,
        maxIterations: 2,
        onMaxReached: "return-last",
        children: Task({
          id: "generate",
          output: outputs.page,
          agent,
          children:
            'Return ONLY JSON: {"html":"<!doctype html><h1>Hello, world.</h1>","done":true}',
        }),
      }),
      Task({
        key: "write",
        id: "write",
        output: outputs.page,
        skipIf: !latest,
        children: () => {
          const html = latest?.html ?? "<!doctype html><h1>Hello, world.</h1>";
          Bun.write("public/hello-world.html", html);
          return { html, done: true };
        },
      }),
    ],
  });
});
