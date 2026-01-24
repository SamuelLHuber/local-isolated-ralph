## Ralph (ghuntley.com/ralph)

**What it is:** An iterative automation technique for software development using LLMs in a continuous loop:

```bash
while :; do cat PROMPT.md | claude-code ; done
```

**Philosophy:**
- "Deterministically bad in an undeterministic world" — produces predictable failures that can be systematically addressed
- "Eventual consistency" — iterative refinement will eventually produce results
- When problems arise, tune the prompts rather than blame tools

**Key insight:** The agent is stateless, all continuity lives in files on disk.

- **Ralph** provides the orchestration pattern (bash loop, file-based state, iterative refinement)

The goal of Ralph:
"Developer starts a session and returns to a PR" with minimal intervention, while the git history looks indistinguishable from manual work.
