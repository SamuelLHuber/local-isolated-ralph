# Ralph Workflow Guide

Smithers is required; the legacy bash loop is not used.

How to run single and multi-Ralph setups efficiently.

## Smithers Full-Orchestration Mode (Required)

Smithers replaces the bash loop inside each VM. The host still handles VM lifecycle and sync, but Smithers runs the plan. The legacy bash loop is no longer used. JJ is the required VCS (colocated Git backend).

## Prompt Control

Provide per-run instructions with `PROMPT.md` and reviewer instructions with `REVIEW_PROMPT.md`:

```bash
./scripts/dispatch.sh --spec specs/feature.min.json ralph-1 specs/feature.min.json \
  --prompt ./prompts/PROMPT-implementer.md \
  --review-prompt ./prompts/PROMPT-reviewer.md
```

## JJ Primer (Required)

```
Clone:              jj git clone <url> <dir>
Init in repo:       jj git init
Start change:       jj new master
Status:             jj status
Diff:               jj diff
Describe change:    jj describe
Push change:        jj git push --bookmark <branch>
```

Commit message rules:
- Conventional Commits: type(scope): subject
- Trailers: spec, todo, run
- For root-cause fixes, include: cause → reasoning → fix and relevant error output

```
Host dispatch.sh
     │
     ▼
VM workdir (spec.min.json + todo.min.json + workflow.tsx)
     │
     ▼
smithers workflow.tsx
  ├─ runs tasks sequentially or in parallel
  ├─ writes reports/<task>.report.json
  └─ persists state in .smithers/*.db
```

Recommended when you want durable, inspectable multi-step plans with deterministic replay.

## Git Strategies for Parallel Work

### Single Ralph: Feature Branches

One Ralph, one branch, simple:

```bash
# Ralph works on a feature branch
git checkout -b feat/user-auth
# ... Ralph implements ...
git push -u origin feat/user-auth
gh pr create
```

### Multi-Ralph: Separate VMs, Separate Branches

Each VM clones the repo and works on its own branch:

```bash
# In ralph-1 VM:
git clone git@github.com:org/repo.git
cd repo
git checkout -b feat/auth
# ... Ralph implements ...

# In ralph-2 VM:
git clone git@github.com:org/repo.git
cd repo
git checkout -b feat/dashboard
# ... Ralph implements ...
```

Each Ralph pushes to its own branch → creates its own PR. Simple.

### Multi-Ralph: Jujutsu (jj) - Advanced Parallel Work

[Jujutsu](https://github.com/martinvonz/jj) handles parallel changes natively (no worktrees needed):

```bash
# Initialize or clone
jj git clone git@github.com:org/repo.git
cd repo

# Create changes for each Ralph (no explicit branches needed)
jj new master -m "feat: user auth"      # Creates change A
jj new master -m "feat: dashboard"      # Creates change B
jj new master -m "fix: api error"       # Creates change C

# Each Ralph works on a different change
# jj handles rebasing automatically when main updates
```

**Benefits:**
- No branch name juggling
- Automatic rebasing when main updates
- First-class parallel changes in a single working directory
- Easier to squash/reorganize before PR

### Multi-Ralph: Same Spec, Different Tasks (jj)

Multiple Ralphs can work on ONE large spec, each picking different tasks:

```bash
# One spec with multiple tasks
# specs/big-feature.md:
#   - Task 1: Add user model
#   - Task 2: Add auth endpoints
#   - Task 3: Add tests
#   - Task 4: Add documentation

# All Ralphs start from main, work on different tasks
jj new master -m "task-1: user model"     # Ralph-1 picks this
jj new master -m "task-2: auth endpoints" # Ralph-2 picks this
jj new master -m "task-3: tests"          # Ralph-3 picks this
jj new master -m "task-4: docs"           # Ralph-4 picks this

# jj automatically handles when tasks touch same files
# Conflicts surface immediately, agents can coordinate
```

**How it works:**
1. Orchestrator parses spec, creates jj changes for each task
2. Each Ralph gets assigned a change to work on
3. Ralphs commit to their change as they work
4. jj auto-rebases when main updates or other changes land
5. When all tasks done, squash or merge as needed

```bash
# After all Ralphs complete, combine changes
jj rebase -s task-1 -d main
jj rebase -s task-2 -d task-1
jj rebase -s task-3 -d task-2
jj rebase -s task-4 -d task-3

# Or keep parallel and merge all at once
jj git push --all
# Create PR that includes all changes
```

**Conflict handling:**
- jj shows conflicts immediately (even uncommitted)
- Ralphs can see "task-2 conflicts with your changes"
- Orchestrator can pause one Ralph while another resolves
- Or let both continue and resolve conflicts at merge time

---

## Shared Spec Workflow (Swarm on One Feature)

Multiple Ralphs work on the same large feature, each owning a task:

```
┌─────────────────────────────────────────────────────────────────┐
│  specs/big-feature.md                                           │
│  ├── Task 1: Add user model (Ralph-1)                          │
│  ├── Task 2: Add auth endpoints (Ralph-2)                       │
│  ├── Task 3: Add tests (Ralph-3)                                │
│  └── Task 4: Add documentation (Ralph-4)                        │
└─────────────────────────────────────────────────────────────────┘
                             │
                    jj new master (×4)
                             │
         ┌───────────┬───────┴───────┬───────────┐
         ▼           ▼               ▼           ▼
    ┌─────────┐ ┌─────────┐    ┌─────────┐ ┌─────────┐
    │ Ralph-1 │ │ Ralph-2 │    │ Ralph-3 │ │ Ralph-4 │
    │ task-1  │ │ task-2  │    │ task-3  │ │ task-4  │
    │ model   │ │ api     │    │ tests   │ │ docs    │
    └────┬────┘ └────┬────┘    └────┬────┘ └────┬────┘
         │           │               │           │
         └───────────┴───────┬───────┴───────────┘
                             │
                    jj squash / merge
                             │
                             ▼
                    ┌─────────────────┐
                    │  Single PR      │
                    │  "Big Feature"  │
                    └─────────────────┘
```

### Setup

```bash
# 1. Write your spec with clear task breakdown
cat > specs/big-feature.md << 'EOF'
# Big Feature Spec

## Overview
Add complete user authentication system.

## Tasks

### Task 1: User Model
- Add User entity with email, password hash, created_at
- Add migration
- Files: src/models/user.ts, src/db/migrations/

### Task 2: Auth Endpoints
- POST /auth/register
- POST /auth/login
- POST /auth/refresh
- Files: src/routes/auth.ts, src/services/auth.ts

### Task 3: Tests
- Unit tests for auth service
- Integration tests for endpoints
- Files: tests/

### Task 4: Documentation
- API docs for auth endpoints
- README updates
- Files: docs/, README.md
EOF

# 2. Create jj changes for each task
cd ~/projects/myapp
jj new master -m "task-1: user model"
jj new master -m "task-2: auth endpoints"
jj new master -m "task-3: tests"
jj new master -m "task-4: documentation"

# 3. Prepare spec/todo JSON for each task
#    (store in specs/, then validate + minify)
bun run scripts/validate-specs.ts
bun run scripts/minify-specs.ts

# 4. Launch swarm (fleet)
./scripts/smithers-fleet.sh specs ralph
```

### Dependency Handling

Tasks often depend on each other. Handle this with jj stacking:

```bash
# Task 2 depends on Task 1? Stack them:
jj rebase -s task-2 -d task-1

# Now task-2 sees task-1's changes
# Ralph-2 can continue working

# When task-1 updates, task-2 auto-rebases
```

### Merging Results

```bash
# Option A: Linear history (rebase chain)
jj rebase -s task-1 -d main
jj rebase -s task-2 -d task-1
jj rebase -s task-3 -d task-2
jj rebase -s task-4 -d task-3

# Option B: Merge commit (parallel history)
jj new task-1 task-2 task-3 task-4 -m "feat: big feature complete"

# Push and create PR
jj git push -c @
gh pr create --title "Big Feature" --body "Implements auth system"
```

---

## Single Ralph Workflow (Smithers Required)

```
┌──────────────────────────────────────┐
│  Human writes spec + todo            │
│  └── specs/feature-x.json/.todo.json │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│  Ralph implements                    │
│  └── Commits to feat/feature-x      │
│  └── Creates PR when done            │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│  Human reviews reports               │
│  └── Approves or requests changes    │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│  Merge & ship                        │
│  └── Human gets "shipped" notice     │
└──────────────────────────────────────┘
```

### Setup

```bash
# Create VM
./scripts/create-ralph.sh ralph-1

# Prepare spec + todo
cp specs/templates/spec.json specs/feature-x.json
cp specs/templates/todo.json specs/feature-x.todo.json
# Edit both files, then validate + minify
bun run scripts/validate-specs.ts
bun run scripts/minify-specs.ts

# Start Smithers workflow
./scripts/dispatch.sh --spec specs/feature-x.min.json ralph-1 specs/feature-x.min.json

# Watch
tmux attach -t ralph-1
```

---

## Multi-Ralph Parallel Workflow (Smithers Required)

```
┌────────────────────────────────────────────────────────────┐
│  Human writes specs + todos                                │
│  └── specs/auth.json, specs/dashboard.json, specs/api.json │
└────────────────────────────┬───────────────────────────────┘
                             ▼
┌─────────────┬─────────────┬─────────────┬─────────────────┐
│  Ralph-1    │  Ralph-2    │  Ralph-3    │  Ralph-4        │
│  (VM)       │  (VM)       │  (VM)       │  (VM)           │
│  feat/auth  │  feat/dash  │  fix/api    │  feat/notifs    │
└──────┬──────┴──────┬──────┴──────┬──────┴────────┬────────┘
       │             │             │               │
       ▼             ▼             ▼               ▼
┌──────────────────────────────────────────────────────────┐
│  4 PRs created in parallel                               │
└──────────────────────────────────────────────────────────┘
```

### Setup

```bash
# Prepare specs + todos
cp specs/templates/spec.json specs/auth.json
cp specs/templates/todo.json specs/auth.todo.json
cp specs/templates/spec.json specs/dashboard.json
cp specs/templates/todo.json specs/dashboard.todo.json
cp specs/templates/spec.json specs/api-fix.json
cp specs/templates/todo.json specs/api-fix.todo.json

# Edit files, then validate + minify
bun run scripts/validate-specs.ts
bun run scripts/minify-specs.ts

# Create VMs
for i in 1 2 3; do
  ./scripts/create-ralph.sh ralph-$i 2 4 20
done

# Start fleet (fleet)
./scripts/smithers-fleet.sh specs ralph

# Monitor via logs/LAOS or VM tmux if you start a local session
```

---

## Multi-Agent Coordination (Implementer + Reviewer)

Reviewer agents provide code quality, security, and spec-compliance feedback. After review, a human approves before the next spec run.

Runs are immutable: every dispatch creates a new workdir. Track runs in `~/.cache/ralph/ralph.db` and clean old workdirs when needed.

```
┌─────────────────────────────────────────────────────────────────┐
│  Human writes spec                                              │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Implementer Smithers                                           │
│  └── Implements feature                                         │
│  └── Writes reports/<task>.report.json                          │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │  Reports Directory    │
                    │  reports/*.json       │
                    └───────────┬───────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Reviewer Smithers                                              │
│  └── Reviews code vs spec + reports                             │
│  └── Writes reports/review.json                                 │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │  Feedback loops back  │
                    │  to Implementer       │
                    └───────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Human                                                         │
│  └── Reviews reports/review.json                                │
│  └── Approves or updates spec/todo                              │
│  └── Starts next spec run                                       │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Human gets notified: "Feature X shipped"                       │
│  └── Only intervenes for spec questions                         │
└─────────────────────────────────────────────────────────────────┘
```

### Setup

```bash
# Create implementer VM
./scripts/create-ralph.sh ralph-impl 4 6 30

# Create reviewer VM
./scripts/create-ralph.sh ralph-review 2 4 20

# Start reviewer workflow (Smithers)
./scripts/dispatch.sh --spec specs/reviewer.min.json --workflow scripts/smithers-reviewer.tsx ralph-review specs/reviewer.min.json

# Review runs automatically after tasks in scripts/smithers-spec-runner.tsx.
```

### Review Output

**Reviewer Output:**
```json
// reports/review.json
{
  "v": 1,
  "status": "approved",
  "issues": [],
  "next": []
}
```

**Human Gate:**
```json
// reports/human-gate.json
{
  "v": 1,
  "status": "blocked",
  "reason": "Human review required before next spec run."
}
```

**Record Human Feedback (host):**
```bash
./scripts/record-human-feedback.sh --vm ralph-1 --spec specs/feature-x.min.json \
  --decision approve --notes "Spec satisfied."
```

---

## Human Touchpoints

With this setup, humans only need to:

| Action | When |
|--------|------|
| **Write specs** | Start of feature |
| **Answer questions** | When a task report or human gate is `blocked` |
| **Final merge approval** | After review.json and human approval |
| **Receive shipped notification** | Feature complete |

The goal: **Humans write specs, agents ship features.**

---

## Directory Structure

```
~/
├── specs/                        # Spec + TODO JSON (on host)
│   ├── auth.json
│   ├── auth.todo.json
│   ├── auth.min.json
│   ├── auth.todo.min.json
│   └── ...
│
└── vms/                          # VM storage (Linux only)
    └── wisp/
```

Inside each VM:
```
~/
├── repo/                         # Cloned repository
│   └── (working on feature branch)
├── specs/                        # Copied from host
├── reports/                      # task reports
└── .smithers/                    # SQLite state
```

---

## Quick Commands

```bash
# Single Ralph
./scripts/dispatch.sh --spec specs/feature.min.json ralph-1 specs/feature.min.json

# Multi-Ralph (fleet)
./scripts/smithers-fleet.sh specs ralph

# Multi-Ralph in single VM (density mode)
./scripts/dispatch.sh --spec specs/auth.min.json ralph-1 specs/auth.min.json
./scripts/dispatch.sh --spec specs/dashboard.min.json ralph-1 specs/dashboard.min.json

# List all Ralphs
./scripts/list-ralphs.sh

# Cleanup
./scripts/cleanup-ralphs.sh --all
```
