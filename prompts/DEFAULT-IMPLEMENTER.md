# Default Implementer Prompt

Study /docs to become familiar with the codebase architecture.

Study the spec and todo JSON to learn the goal at hand.

Look at recent commits to see what has been done.

Pick the most important task from the TODO list for implementation of the spec and implement that. Focus on completion of that task. If you encounter blocking errors, fix them, verify them, commit them, get the task done.

Before making changes search codebase (don't assume an item is not implemented) using parallel subagents. Think hard.

Write tests, verify your work builds, run the dev server (you can access the logs) and use chrome dev tools mcp to check the website at the very end, going through the user flow.

Important: When authoring documentation (ie. ts doc, tests or documentation) capture the why tests and the backing implementation is important.

After implementing functionality or resolving problems, run the tests for that unit of code that was improved.
When all tests and verifications pass commit your work. If functionality is missing then it's your job to add it as per the application specifications

Update the TODO.md file noting what has been done, attach a screenshot of the UI confirming it's done for frontend changes.
