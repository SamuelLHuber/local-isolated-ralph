# Ralph Workflow Guide

How to run single and multi-Ralph setups efficiently.

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
jj new main -m "feat: user auth"      # Creates change A
jj new main -m "feat: dashboard"      # Creates change B
jj new main -m "fix: api error"       # Creates change C

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
jj new main -m "task-1: user model"     # Ralph-1 picks this
jj new main -m "task-2: auth endpoints" # Ralph-2 picks this
jj new main -m "task-3: tests"          # Ralph-3 picks this
jj new main -m "task-4: docs"           # Ralph-4 picks this

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
                    jj new main (×4)
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
jj new main -m "task-1: user model"
jj new main -m "task-2: auth endpoints"
jj new main -m "task-3: tests"
jj new main -m "task-4: documentation"

# 3. Assign prompts to each Ralph
for i in 1 2 3 4; do
  mkdir -p ~/tasks/task-$i
  cp prompts/PROMPT-task.md ~/tasks/task-$i/PROMPT.md
  # Edit each PROMPT.md with specific task details
done

# 4. Launch swarm
./scripts/ralph-fleet.sh ~/tasks/
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

## Single Ralph Workflow

```
┌──────────────────────────────────────┐
│  Human writes spec                   │
│  └── specs/feature-x.md              │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│  Ralph implements                    │
│  └── Commits to feat/feature-x      │
│  └── Creates PR when done            │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│  Human reviews PR                    │
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

# Prepare task
mkdir -p ~/tasks/feature-x
cp prompts/PROMPT-implementer.md ~/tasks/feature-x/PROMPT.md
# Edit PROMPT.md with your spec

# Start Ralph
./scripts/ralph-start.sh ralph-1 ~/tasks/feature-x/PROMPT.md

# Watch
tmux attach -t ralph-1
```

---

## Multi-Ralph Parallel Workflow

```
┌────────────────────────────────────────────────────────────┐
│  Human writes specs                                        │
│  └── specs/auth.md, specs/dashboard.md, specs/api-fix.md   │
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
# Create tasks with prompts
mkdir -p ~/tasks/{auth,dashboard,api-fix}
for task in auth dashboard api-fix; do
  cp prompts/PROMPT-implementer.md ~/tasks/$task/PROMPT.md
  # Edit each PROMPT.md with specific spec and branch name
done

# Create VMs
for i in 1 2 3; do
  ./scripts/create-ralph.sh ralph-$i 2 4 20
done

# Start fleet
./scripts/ralph-fleet.sh ~/tasks/

# View all in tmux
tmux attach -t ralph-fleet
```

---

## Multi-Agent Coordination (Implementer + Reviewer)

Reduce human review by having reviewer agents provide feedback:

```
┌─────────────────────────────────────────────────────────────────┐
│  Human writes spec                                              │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Implementer Ralph                                              │
│  └── Implements feature                                         │
│  └── Creates PR                                                 │
│  └── Writes to outbox/: "PR ready for review"                   │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │  Message Queue        │
                    │  (shared filesystem)  │
                    │                       │
                    │  inbox/  ◄─────────┐  │
                    │  outbox/ ──────────┼──│
                    └───────────┬────────┘  │
                                ▼           │
┌─────────────────────────────────────────────────────────────────┐
│  Reviewer Ralph                                                 │
│  └── Watches inbox/ for new PRs                                 │
│  └── Reviews code against spec                                  │
│  └── Writes feedback to outbox/                                 │
│  └── Or approves if good                                        │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │  Feedback loops back  │
                    │  to Implementer       │
                    └───────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Implementer Ralph                                              │
│  └── Reads review feedback from inbox/                          │
│  └── Addresses issues                                           │
│  └── Updates PR                                                 │
│  └── Cycle continues until approved                             │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Human gets notified: "Feature X shipped"                       │
│  └── Only intervenes for spec questions                         │
└─────────────────────────────────────────────────────────────────┘
```

### Setup

```bash
# Shared message directory (on host, mounted to both VMs)
mkdir -p ~/ralph-messages/{inbox,outbox,specs}

# Create implementer VM
./scripts/create-ralph.sh ralph-impl 4 6 30

# Create reviewer VM
./scripts/create-ralph.sh ralph-review 2 4 20

# Start implementer with shared messages mounted
# (In VM, ~/messages points to host's ~/ralph-messages)

# Start reviewer watching for PRs
./scripts/ralph-start.sh ralph-review ~/tasks/reviewer/PROMPT.md
```

### Message Format

**PR Ready (implementer → reviewer):**
```json
// outbox/pr-001.json
{
  "type": "pr-ready",
  "id": "001",
  "branch": "feat/auth",
  "spec": "specs/auth.md",
  "summary": "Implemented JWT auth with refresh tokens"
}
```

**Review Feedback (reviewer → implementer):**
```markdown
// inbox/review-001.md
## Review for PR #001

### Issues
- [ ] Missing rate limiting on /auth/token endpoint
- [ ] Tests don't cover token expiration

### Verdict: CHANGES_REQUESTED
```

**Approval (reviewer → orchestrator):**
```json
// outbox/approved-001.json
{
  "type": "approved",
  "id": "001",
  "branch": "feat/auth",
  "ready_to_merge": true
}
```

---

## Human Touchpoints

With this setup, humans only need to:

| Action | When |
|--------|------|
| **Write specs** | Start of feature |
| **Answer questions** | When Ralph outputs `NEEDS_INPUT` |
| **Final merge approval** | Optional, can auto-merge if reviewer approved |
| **Receive shipped notification** | Feature complete |

The goal: **Humans write specs, agents ship features.**

---

## Directory Structure

```
~/
├── tasks/                        # Task definitions (on host)
│   ├── auth/
│   │   └── PROMPT.md             # Spec for auth feature
│   ├── dashboard/
│   │   └── PROMPT.md
│   └── api-fix/
│       └── PROMPT.md
│
├── ralph-messages/               # Shared message queue
│   ├── inbox/                    # Messages TO agents
│   ├── outbox/                   # Messages FROM agents
│   └── specs/                    # Feature specifications
│
└── vms/                          # VM storage (Linux only)
    └── wisp/
```

Inside each VM:
```
~/
├── repo/                         # Cloned repository
│   └── (working on feature branch)
├── PROMPT.md                     # Copied from host
└── ralph/
    └── state/                    # Loop state tracking
```

---

## Quick Commands

```bash
# Single Ralph
./scripts/ralph-start.sh ralph-1 ~/tasks/feature/PROMPT.md
tmux attach -t ralph-1

# Multi-Ralph fleet
./scripts/ralph-fleet.sh ~/tasks/
tmux attach -t ralph-fleet

# Multi-Ralph in single VM (density mode)
./scripts/ralph-multi.sh ralph-1 ~/tasks/auth ~/tasks/dashboard

# List all Ralphs
./scripts/list-ralphs.sh

# Cleanup
./scripts/cleanup-ralphs.sh --all
```
