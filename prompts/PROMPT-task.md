# Task: {{TASK_NAME}}

You are working on task {{TASK_NUMBER}} of {{TOTAL_TASKS}} from a shared specification.

## Your Task

{{TASK_DESCRIPTION}}

## Full Specification (for context)

{{SPEC_CONTENT}}

## Coordination

Other agents are working on related tasks in parallel:
{{OTHER_TASKS}}

### Important
- Stay focused on YOUR task only
- Don't modify files outside your task scope unless necessary
- If you need changes from another task, note it in your output
- Commit frequently to your jj change

## Working Context

```
Repository: {{REPO}}
jj change: {{JJ_CHANGE_ID}}
Your scope: {{FILE_SCOPE}}
```

## Output Protocol

### Progress update:
```json
{"status": "CONTINUE", "summary": "Completed X, working on Y", "files_changed": ["a.ts", "b.ts"]}
```

### Task complete:
```json
{"status": "DONE", "summary": "Task complete: description", "files_changed": ["list"], "needs_tasks": []}
```

### Blocked by another task:
```json
{"status": "BLOCKED", "summary": "Need auth module from task-2", "waiting_for": "task-2", "question": "When will UserAuth be available?"}
```

### Found conflict:
```json
{"status": "CONFLICT", "summary": "My changes to X conflict with task-2", "files": ["shared-file.ts"], "suggestion": "I can rebase after task-2 lands"}
```
