# Workflow Guide: Compound Engineering with Fabrik

**Scope**: Complete workflow from Spec creation to Human Gate.

**Implicit Assumption**: Reader has completed QUICKSTART.md and understands the 80/20 rule (80% Planning, 20% Execution).

---

## 1. Compound Engineering: The 4 Principles

### 1.1 Plan thoroughly before writing code
- Spec is the contract. Changes cost 10x.
- No implementation without completed interview.

### 1.2 Review to catch issues and capture learnings
- 8 Reviewers (automatic, parallel).
- Every finding becomes a reusable pattern.

### 1.3 Codify knowledge so it's reusable
- `@property` TSDoc names invariants explicitly.
- Branded Types prevent primitive obsession.
- Todo templates documented in `prompts/reviewers/`.

### 1.4 Keep quality high so future changes are easy
- 6 Guarantee Layers (L1-L6).
- Higher quality = faster next cycle.

---

## 2. The Workflow (Step-by-Step)

### Phase 1: Spec Creation (40% of time)

```bash
# Step 1: Output interview guide
./dist/fabrik spec interview | tee /tmp/spec-interview.txt

# Step 2: Run with agent
# Input: Conversation with agent about the 10 questions
# Output: specs/{id}.json
cat /tmp/spec-interview.txt | claude-code

# Step 3: Validate
./dist/fabrik spec validate
```

**The 10 Questions** (implicit in `fabrik spec interview`):
1. IDENTITY: Kebab-case ID
2. TITLE: One sentence, active voice, NO implementation
3. STATUS: draft | ready | in-progress | review | done | superseded
4. GOALS: 3-7 outcomes, MUST accomplish, NO implementation details
5. NON-GOALS: Explicitly out of scope (prevents creep)
6. API: Interfaces, signatures, branded types, error channels
7. BEHAVIOR: Business rules, state transitions, edge cases
8. OBSERVABILITY: Metrics, logs, alerts, health checks
9. ACCEPTANCE: Testable criteria, performance thresholds
10. ASSUMPTIONS: What could change (deps, platform, volume)

**Critical**: Spec must have `status: "ready"` before next step.

---

### Phase 2: Todo Generation (40% of time)

```bash
# Step 1: Output todo guide
./dist/fabrik todo generate | tee /tmp/todo-guide.txt

# Step 2: Run with agent
# Input: specs/{id}.json
# Output: specs/{id}.todo.json
cat /tmp/todo-guide.txt | claude-code

# Step 3: Validate
./dist/fabrik spec validate
```

**Criticality Tier** (determines DoD):

| Tier | Examples | Layers |
|------|----------|--------|
| T1 | Money, Auth, Signing, irreversible State | ALL 6 (L1-L5 + Simulation) |
| T2 | User data, Business logic, State machines | L1-L5 |
| T3 | Features, UI state, Caching | L1-L4 |
| T4 | Analytics, Logging, Metrics | L1, L4 |

**T1 DoD** (all must be checked):
- [ ] L1: Branded types
- [ ] L2: Effect.assert for pre/postconditions
- [ ] L3: DB UNIQUE/CHECK constraints
- [ ] L4: @property TSDoc on every invariant test
- [ ] L4: Property-based tests (conservation, idempotency)
- [ ] L4: 90%+ line coverage, 85%+ branch coverage
- [ ] L5: TODOs for production alerts
- [ ] L6: Seed-based simulation plan
- [ ] Review: All 8 reviewers approved
- [ ] VCS: Pushed to GitHub, CI passed
- [ ] Human: Gate cleared

---

### Phase 3: Execution (20% of time)

```bash
# Single-VM Workflow
./dist/fabrik run \
  --spec specs/feature.json \
  --todo specs/feature.todo.json \
  --vm ralph-1 \
  --project /path/to/target/repo        # Optional: target repo outside VM
```

**Internal Flow**:

```
spec.json + todo.json (minified)
           │
           ▼
    smithers-spec-runner.tsx
           │
           ├─ Sequential Tasks (with skipIf on error)
           ├─ JJ: jj new main && jj bookmark create feature-1
           ├─ Work → jj describe → jj git push --branch feature-1
           │
           ▼
    Review Loop (Ralph until maxIterations)
           ├─ 8 Reviewers parallel
           ├─ On "changes_requested": Generate review tasks
           └─ Resubmit until "approved" or max reached
           │
           ▼
    Human Gate (blocked)
           └─ Waits for: fabrik feedback --decision approve
```

---

## 3. VCS Strategies (JJ)

### 3.1 Single-Ralph: Feature Branch

```bash
# In VM (automatic by agent)
jj new main
jj bookmark create feature-1
# ... work ...
jj describe -m "feat(feature-1): implement X"
jj git push --branch feature-1
```

**Implicit Assumption**: Agent works in `/home/ralph/work/...` directory, not on host.

### 3.2 Multi-Ralph: Separate VMs

```bash
# Host: Start multiple runs
./dist/fabrik run --spec specs/auth.json --vm ralph-1 &
./dist/fabrik run --spec specs/dashboard.json --vm ralph-2 &
./dist/fabrik run --spec specs/api-fix.json --vm ralph-3 &

# Monitor
./dist/fabrik runs watch --vm ralph-1 &
./dist/fabrik runs watch --vm ralph-2 &
./dist/fabrik runs watch --vm ralph-3 &
```

**Implicit Assumption**: Each VM has own workdir. No collisions possible.

### 3.3 Multi-Ralph: Fleet Mode

```bash
./dist/fabrik fleet \
  --specs-dir specs \
  --vm-prefix ralph \
  --project /path/to/repo
```

**Implicit Assumption**: Fleet matches specs/*.json to available VMs (ralph-1, ralph-2, ...).

---

## 4. Review Pipeline (8 Reviewers)

**Parallel Execution**:

```
Parallel:
  ├─ security
  ├─ code-quality
  ├─ simplicity
  ├─ test-coverage
  ├─ maintainability
  ├─ tigerstyle
  ├─ nasa-10-rules
  └─ correctness-guarantees
```

**Reviewer Prompts**: `prompts/reviewers/{id}.md`

**Custom Models** (optional):
```json
// reviewer-models.json
{
  "_default": "sonnet",
  "security": "opus",
  "correctness-guarantees": "opus"
}
```

```bash
./dist/fabrik run ... --review-models ./reviewer-models.json --review-max 3
```

---

## 5. Human Gate

**State**: After review loop, `human_gate` row written:

```json
{
  "v": 1,
  "status": "blocked",
  "reason": "Human review required before next spec run."
}
```

**Actions**:

```bash
# Approve
./dist/fabrik feedback \
  --vm ralph-1 \
  --spec specs/feature.json \
  --decision approve \
  --notes "Implementation correct. Tests pass."

# Reject (with reason for re-run)
./dist/fabrik feedback \
  --vm ralph-1 \
  --spec specs/feature.json \
  --decision reject \
  --notes "Security issue in auth flow. Fix and re-run."
```

**Implicit Assumption**: No automatic transition from "blocked". Human decision is binding.

---

## 6. Monitoring & Debugging

### 6.1 Live Monitoring

```bash
# Terminal 1: Desktop notifications
./dist/fabrik runs watch --vm ralph-1

# Terminal 2: Stream logs
./dist/fabrik laos logs --follow

# Browser: Grafana
open http://localhost:3010/explore
```

### 6.2 Post-Mortem

```bash
# Run details
./dist/fabrik runs show --id <run-id>

# Output includes:
# - failure_reason (if failed)
# - blocked_task (if blocked)
# - reports/run-context.json (prompt hashes)
# - .smithers/*.db (SQLite with all reports)

# Inspect SQLite
sqlite3 .smithers/feature.db "SELECT * FROM taskReport;"
sqlite3 .smithers/feature.db "SELECT * FROM reviewReport;"
sqlite3 .smithers/feature.db "SELECT * FROM humanGate;"
```

---

## 7. Compound Effect: The Flywheel

**Month 1**: Slower than "just coding" (planning overhead)
**Month 3**: Same speed, fewer bugs
**Month 6**: Faster than traditional (patterns established)
**Month 12**: 2-3x Velocity (compound interest on quality)

**Mechanism**:
1. Spec → Reusable requirement patterns
2. Todo → Reusable task templates
3. Reviewers → Reusable checklists
4. L1-L6 → Each change safer than previous

---

## 8. Command Reference

| Command | Purpose | Output |
|---------|---------|--------|
| `fabrik spec interview` | 10-question guide | Terminal (pipe to agent) |
| `fabrik todo generate` | Todo guide | Terminal (pipe to agent) |
| `fabrik spec validate` | JSON Schema check | Exit code 0/1 |
| `fabrik spec minify` | Generate .min.json | Filesystem |
| `fabrik run ...` | Workflow dispatch | SQLite + Reports |
| `fabrik runs list` | Overview all runs | Table |
| `fabrik runs show --id X` | Single run detail | JSON |
| `fabrik runs watch` | Desktop notifications | Desktop popup |
| `fabrik feedback ...` | Human Gate decision | SQLite update |
| `fabrik fleet ...` | Multi-VM dispatch | SQLite + Reports |

---

## 9. Implicit Assumptions (Critical)

1. **VCS**: JJ installed and configured (`jj --version`)
2. **Auth**: `~/.pi/agent/auth.json` exists (or codex/claude equivalent)
3. **Token**: `GITHUB_TOKEN` set and valid (scope: `repo`, `workflow`)
4. **LAOS**: Running on localhost:3010 (for logs/metrics)
5. **VMs**: Exist and reachable (`fabrik laos status` shows healthy)
6. **Network**: VMs can reach GitHub (firewall/egress allowed)
7. **Disk**: VMs have >10GB free for repos + dependencies
8. **Order**: Spec → Todo → Run (binding, not skippable)
9. **Human Gate**: Requires explicit feedback (no timeout)
10. **Review**: 8 reviewers run parallel (network/bandwidth required)
