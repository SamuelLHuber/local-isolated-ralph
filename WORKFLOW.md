# Workflow Guide: Compound Engineering mit Fabrik

**Scope**: Dieses Dokument beschreibt den vollständigen Workflow von Spec-Erstellung bis Human Gate.

**Implicit Assumption**: Der Leser hat QUICKSTART.md durchgearbeitet und versteht die 80/20-Regel (80% Planning, 20% Execution).

---

## 1. Compound Engineering: Die 4 Prinzipien

### 1.1 Plan thoroughly before writing code
- Spec ist der Vertrag. Änderungen kosten 10x.
- Keine Implementation ohne abgeschlossenes Interview.

### 1.2 Review to catch issues and capture learnings
- 8 Reviewer (automatisch, parallel).
- Jedes Finding wird zu wiederverwendbarem Pattern.

### 1.3 Codify knowledge so it's reusable
- `@property` TSDoc nennt Invarianten explizit.
- Branded Types verhindern primitive obsession.
- Todo-Templates werden in `prompts/reviewers/` dokumentiert.

### 1.4 Keep quality high so future changes are easy
- 6 Guarantee Layers (L1-L6).
- Je höher die Qualität, desto schneller der nächste Cycle.

---

## 2. Der Workflow (Step-by-Step)

### Phase 1: Spec-Erstellung (40% der Zeit)

```bash
# Step 1: Interview-Guide ausgeben
./dist/fabrik spec interview | tee /tmp/spec-interview.txt

# Step 2: Mit Agent durchführen
# Input: Konversation mit dem Agent über die 10 Fragen
# Output: specs/{id}.json
cat /tmp/spec-interview.txt | claude-code

# Step 3: Validieren
./dist/fabrik spec validate
```

**Die 10 Fragen** (implizit in `fabrik spec interview`):
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

**Critical**: Spec muss `status: "ready"` haben vor dem nächsten Schritt.

---

### Phase 2: Todo-Generierung (40% der Zeit)

```bash
# Step 1: Todo-Guide ausgeben
./dist/fabrik todo generate | tee /tmp/todo-guide.txt

# Step 2: Mit Agent durchführen
# Input: specs/{id}.json
# Output: specs/{id}.todo.json
cat /tmp/todo-guide.txt | claude-code

# Step 3: Validieren
./dist/fabrik spec validate
```

**Criticality Tier** (bestimmt DoD):

| Tier | Beispiele | Layers |
|------|-----------|--------|
| T1 | Money, Auth, Signing, irreversible State | ALL 6 (L1-L5 + Simulation) |
| T2 | User data, Business logic, State machines | L1-L5 |
| T3 | Features, UI state, Caching | L1-L4 |
| T4 | Analytics, Logging, Metrics | L1, L4 |

**T1 DoD** (muss alles geprüft sein):
- [ ] L1: Branded types
- [ ] L2: Effect.assert für pre/postconditions
- [ ] L3: DB UNIQUE/CHECK constraints
- [ ] L4: @property TSDoc auf jedem Invariant-Test
- [ ] L4: Property-based tests (conservation, idempotency)
- [ ] L4: 90%+ line coverage, 85%+ branch coverage
- [ ] L5: TODOs für production alerts
- [ ] L6: Seed-based simulation plan
- [ ] Review: All 8 Reviewer approved
- [ ] VCS: Gepusht zu GitHub, CI passed
- [ ] Human: Gate cleared

---

### Phase 3: Execution (20% der Zeit)

```bash
# Single-VM Workflow
./dist/fabrik run \
  --spec specs/feature.json \
  --todo specs/feature.todo.json \
  --vm ralph-1 \
  --project /path/to/target/repo        # Optional: Ziel-Repo außerhalb VM
```

**Was passiert intern**:

```
spec.json + todo.json (minified)
           │
           ▼
    smithers-spec-runner.tsx
           │
           ├─ Sequentielle Tasks (mit skipIf bei Fehler)
           ├─ JJ: jj new main && jj bookmark create feature-1
           ├─ Work → jj describe → jj git push --branch feature-1
           │
           ▼
    Review Loop (Ralph bis maxIterations)
           ├─ 8 Reviewer parallel
           ├─ Bei "changes_requested": Review-Tasks generieren
           └─ Resubmit bis "approved" oder max erreicht
           │
           ▼
    Human Gate (blocked)
           └─ Wartet auf: fabrik feedback --decision approve
```

---

## 3. VCS-Strategien (JJ)

### 3.1 Single-Ralph: Feature Branch

```bash
# In der VM (automatisch durch Agent)
jj new main
jj bookmark create feature-1
# ... work ...
jj describe -m "feat(feature-1): implement X"
jj git push --branch feature-1
```

**Implicit Assumption**: Der Agent arbeitet im `/home/ralph/work/...` Verzeichnis, nicht auf dem Host.

### 3.2 Multi-Ralph: Separate VMs

```bash
# Host: Starte mehrere Runs
./dist/fabrik run --spec specs/auth.json --vm ralph-1 &
./dist/fabrik run --spec specs/dashboard.json --vm ralph-2 &
./dist/fabrik run --spec specs/api-fix.json --vm ralph-3 &

# Monitor
./dist/fabrik runs watch --vm ralph-1 &
./dist/fabrik runs watch --vm ralph-2 &
./dist/fabrik runs watch --vm ralph-3 &
```

**Implicit Assumption**: Jede VM hat eigenen Workdir. Keine Kollisionen möglich.

### 3.3 Multi-Ralph: Fleet Mode

```bash
./dist/fabrik fleet \
  --specs-dir specs \
  --vm-prefix ralph \
  --project /path/to/repo
```

**Implicit Assumption**: Fleet matched specs/*.json zu verfügbaren VMs (ralph-1, ralph-2, ...).

---

## 4. Review Pipeline (8 Reviewer)

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

**Reviewer-Prompts**: `prompts/reviewers/{id}.md`

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

**Zustand**: Nach Review-Loop wird `human_gate` row geschrieben:

```json
{
  "v": 1,
  "status": "blocked",
  "reason": "Human review required before next spec run."
}
```

**Aktionen**:

```bash
# Genehmigen
./dist/fabrik feedback \
  --vm ralph-1 \
  --spec specs/feature.json \
  --decision approve \
  --notes "Implementation correct. Tests pass."

# Ablehnen (mit Begründung für Re-run)
./dist/fabrik feedback \
  --vm ralph-1 \
  --spec specs/feature.json \
  --decision reject \
  --notes "Security issue in auth flow. Fix and re-run."
```

**Implicit Assumption**: Kein automatischer Übergang von "blocked". Human decision ist bindend.

---

## 6. Monitoring & Debugging

### 6.1 Live Monitoring

```bash
# Terminal 1: Desktop notifications
./dist/fabrik runs watch --vm ralph-1

# Terminal 2: Logs streamen
./dist/fabrik laos logs --follow

# Browser: Grafana
open http://localhost:3010/explore
```

### 6.2 Post-Mortem

```bash
# Run Details
./dist/fabrik runs show --id <run-id>

# Ausgabe enthält:
# - failure_reason (wenn failed)
# - blocked_task (wenn blocked)
# - reports/run-context.json (Prompt-Hashes)
# - .smithers/*.db (SQLite mit allen Reports)

# SQLite inspizieren
sqlite3 .smithers/feature.db "SELECT * FROM taskReport;"
sqlite3 .smithers/feature.db "SELECT * FROM reviewReport;"
sqlite3 .smithers/feature.db "SELECT * FROM humanGate;"
```

---

## 7. Compound Effect: Der Flywheel

**Monat 1**: Langsamer als "just coding" (Planungsoverhead)
**Monat 3**: Gleiche Geschwindigkeit, weniger Bugs
**Monat 6**: Schneller als traditionell (Patterns etabliert)
**Monat 12**: 2-3x Velocity (Zinseszins auf Qualität)

**Mechanismus**:
1. Spec → Wiederverwendbare Requirement-Patterns
2. Todo → Wiederverwendbare Task-Templates
3. Reviewer → Wiederverwendbare Checklisten
4. L1-L6 → Jede Änderung ist sicherer als die vorherige

---

## 8. Kommandoreferenz

| Befehl | Zweck | Output |
|--------|-------|--------|
| `fabrik spec interview` | 10-Fragen Guide | Terminal (pipe to agent) |
| `fabrik todo generate` | Todo-Guide | Terminal (pipe to agent) |
| `fabrik spec validate` | JSON Schema check | Exit code 0/1 |
| `fabrik spec minify` | .min.json generieren | Filesystem |
| `fabrik run ...` | Workflow dispatch | SQLite + Reports |
| `fabrik runs list` | Übersicht aller Runs | Table |
| `fabrik runs show --id X` | Einzelnes Run Detail | JSON |
| `fabrik runs watch` | Desktop notifications | Desktop popup |
| `fabrik feedback ...` | Human Gate decision | SQLite update |
| `fabrik fleet ...` | Multi-VM dispatch | SQLite + Reports |

---

## 9. Implizite Annahmen (Critical)

1. **VCS**: JJ ist installiert und konfiguriert (`jj --version`)
2. **Auth**: `~/.pi/agent/auth.json` existiert (oder codex/claude equivalent)
3. **Token**: `GITHUB_TOKEN` ist gesetzt und gültig (scope: `repo`, `workflow`)
4. **LAOS**: Läuft auf localhost:3010 (für Logs/Metrics)
5. **VMs**: Existieren und sind erreichbar (`fabrik laos status` zeigt healthy)
6. **Network**: VMs können GitHub erreichen (firewall/egress erlaubt)
7. **Disk**: VMs haben >10GB frei für Repos + Dependencies
8. **Reihenfolge**: Spec → Todo → Run (bindend, nicht überspringbar)
9. **Human Gate**: Erfordert explizites Feedback (kein Timeout)
10. **Review**: 8 Reviewer laufen parallel (Netzwerk/Bandwidth erforderlich)
