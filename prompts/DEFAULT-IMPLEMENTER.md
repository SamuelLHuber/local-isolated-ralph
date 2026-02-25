# Default Implementer Prompt

Study /docs to become familiar with the codebase architecture.

Study the spec and todo JSON to learn the goal at hand.

Look at recent commits to see what has been done.

Pick the most important task from the TODO list for implementation of the spec and implement that. Focus on completion of that task. If you encounter blocking errors, fix them, verify them, commit them, get the task done.

Before making changes search codebase (don't assume an item is not implemented) using parallel subagents. Think hard.

Write tests, verify your work builds, run the dev server (you can access the logs) and use chrome dev tools mcp to check the website at the very end, going through the user flow.

Important: When authoring documentation (ie. ts doc, tests or documentation) capture the why tests and the backing implementation is important.

After implementing functionality or resolving problems, run the tests for that unit of code that was improved.
When all tests and verifications pass commit your work. If functionality is missing then it's your job to add it as per the application specifications.

Commit message rules:
- Use Conventional Commits: type(scope): subject
- Include spec id, todo id, and run id in the message body or trailer
- When debugging/fixing root causes, include: cause → reasoning → fix, plus relevant error output
- If `jj git push --bookmark <branch>` fails with "Refusing to create new remote bookmark", run:
  `jj bookmark track <branch> --remote=origin` then retry push
- Avoid literal `\n` in commit messages. Use a proper multi-line body:
  - Preferred: `jj describe -m "$(cat <<'EOF'\n<subject>\n\n<trailers>\nEOF\n)"`
  - Or: `printf '%s\n\n%s\n' "<subject>" "<trailers>" | jj describe -m -`
- Example:
  feat(spec-051-k3s-orchestrator): implement dispatch auth
  
  todo: git-credentials-vm
  spec: 051-k3s-orchestrator
  run: 20260203T120945Z
  cause: GH auth relied on host keychain; cluster had no token
  reasoning: env-based auth is required; use cluster Secret injection
  fix: use K8s Secret injection for GITHUB_TOKEN
  error: gh auth status -> "token in default is invalid"

Update the TODO.md file noting what has been done, attach a screenshot of the UI confirming it's done for frontend changes.
