# Compound Engineering: Quickstart

**Prerequisite**: This guide assumes you have completed platform-specific setup (SETUP-MACOS.md or SETUP-LINUX.md).

**Implicit Assumption**: All commands run from `local-isolated-ralph` directory unless noted.

---

## 1. Voraussetzungen prüfen (Pre-flight Check)

```bash
# Agent-Authentifizierung
pi --version        # Muss installiert sein
pi /login           # Einmalig ausführen, erstellt ~/.pi/agent/auth.json

# GitHub Token (für Push/PR)
export GITHUB_TOKEN="ghp_..."   # Oder in ~/.config/ralph/ralph.env

# Optional: Alternative Agents
# codex login        # Nur wenn RALPH_AGENT=codex
# claude auth login  # Nur wenn RALPH_AGENT=claude
```

**Implicit Assumption**: Ohne `GITHUB_TOKEN` kann der Agent keine Branches pushen. Der Workflow wird blockieren.

---

## 2. LAOS starten (Observability)

```bash
fabrik laos up
fabrik laos status   # Muss "healthy" zeigen
```

**Implicit Assumption**: LAOS läuft auf localhost:3010 (Grafana). Der Agent sendet Logs dorthin.

---

## 3. VM erstellen

```bash
fabrik laos up                              # 1. Observability
./scripts/create-ralph.sh ralph-1 4 8 30    # 2. VM (4 CPU, 8GB RAM, 30GB disk)
./scripts/setup-base-vm.sh                  # 3. Setup (ausgeführt IN der VM)
```

**Implicit Assumption**: `setup-base-vm.sh` muss IN der VM ausgeführt werden, nicht auf dem Host.

**macOS**: `colima ssh -p ralph-1`
**Linux**: `ssh ralph@$(virsh domifaddr ralph-1 | grep ipv4 | awk '{print $4}' | cut -d/ -f1)`

---

## 4. Compound Engineering Workflow

**Principle**: 80% Planning, 20% Execution

### Step 1: Spec erstellen (Planning - 40%)

```bash
# Interview-Guide ausgeben (self-contained, kein externes File nötig)
./dist/fabrik spec interview | tee /tmp/interview-prompt.txt

# Mit Agent durchführen, Output: specs/feature.json
cat /tmp/interview-prompt.txt | claude-code

# Validieren
./dist/fabrik spec validate
```

**Critical**: Spec muss vor Todo existieren. Reihenfolge ist bindend.

### Step 2: Todo generieren (Planning - 40%)

```bash
# Todo-Guide ausgeben
./dist/fabrik todo generate | tee /tmp/todo-prompt.txt

# Mit Agent durchführen, Input: specs/feature.json, Output: specs/feature.todo.json
cat /tmp/todo-prompt.txt | claude-code

# Validieren
./dist/fabrik spec validate
```

**Implicit Assumption**: Todo ohne Spec ist ungültig. Die Verknüpfung erfolgt über identische `id`.

### Step 3: Workflow dispatch (Execution - 20%)

```bash
# Single run
./dist/fabrik run \
  --spec specs/feature.json \
  --todo specs/feature.todo.json \
  --vm ralph-1 \
  --project /path/to/target/repo    # Ziel-Repo (optional, sonst VM-intern)
```

**Implicit Assumption**: `--project` kopiert das Repo in die VM. Der Agent arbeitet dort, nicht auf dem Host.

---

## 5. Monitoring

```bash
# Terminal 1: Watch
./dist/fabrik runs watch --vm ralph-1

# Browser: Grafana
open http://localhost:3010

# Status prüfen
./dist/fabrik runs list --vm ralph-1
./dist/fabrik runs show --id <run-id>
```

**Implicit Assumption**: `runs watch` benötigt `terminal-notifier` (macOS) oder `libnotify-bin` (Linux) für Desktop-Notifications.

---

## 6. Human Gate (Review)

Nach 8 Reviewern (automatisch) → Human Gate:

```bash
# Genehmigen oder ablehnen
./dist/fabrik feedback \
  --vm ralph-1 \
  --spec specs/feature.json \
  --decision approve \
  --notes "Implementation correct, tests pass"
```

**Implicit Assumption**: Ohne explizites Feedback bleibt der Run im Status `blocked`. Kein automatischer Timeout.

---

## Zusammenfassung: Der Compound Cycle

```
┌────────────────────────────────────────────────────────────────┐
│  80% PLANNING                                                  │
│  ├── fabrik spec interview  → specs/feature.json              │
│  └── fabrik todo generate     → specs/feature.todo.json         │
├────────────────────────────────────────────────────────────────┤
│  20% EXECUTION                                                 │
│  └── fabrik run --spec ... --todo ... --vm ralph-1             │
│      └── 8 Reviewer → Human Gate → Done                       │
└────────────────────────────────────────────────────────────────┘
```

**Compound Effect**: Jeder durchlaufene Cycle macht den nächsten schneller (wiederverwendbare Patterns, etablierte Reviewer).

---

## Fehlerbehandlung

| Symptom | Ursache | Lösung |
|---------|---------|--------|
| "token in default is invalid" | GITHUB_TOKEN fehlt/ungültig | `export GITHUB_TOKEN=...` oder in `ralph.env` |
| "blocked" ohne Ende | Human Gate wartet | `fabrik feedback --decision approve ...` |
| "stale_process" | VM heartbeat timeout | VM prüfen: `fabrik runs show --id <id>` |
| Reviewer finden nichts | Prompt fehlt | Reviewer-Prompts in `prompts/reviewers/` prüfen |

---

## Kommandoreferenz

| Befehl | Zweck |
|--------|-------|
| `fabrik spec interview` | 10-Fragen Interview-Guide (self-contained) |
| `fabrik todo generate` | Todo-Generierung-Guide (self-contained) |
| `fabrik spec validate` | Spec/Todo JSON validieren |
| `fabrik run --spec X --todo Y --vm Z` | Workflow dispatch |
| `fabrik runs watch --vm Z` | Desktop-Notifications bei Blockierung |
| `fabrik feedback --vm Z --spec X --decision approve` | Human Gate freigeben |
| `fabrik laos up/status/down` | Observability Stack |

---

## Implizite Annahmen (Implicit Assumptions)

1. **Agent-Auth**: `~/.pi/agent/auth.json` existiert (erstellt via `pi /login`)
2. **GitHub Token**: `GITHUB_TOKEN` ist gesetzt (für Push/PR)
3. **LAOS**: Läuft auf localhost:3010 (Logs/Metrics)
4. **VM**: `ralph-1` existiert und ist erreichbar
5. **Network**: VMs können GitHub erreichen (für Clone/Push)
6. **Disk**: VM hat ausreichend Platz für Repo + Dependencies
7. **Reihenfolge**: Spec → Todo → Run (bindend)
8. **Human Gate**: Muss explizit bestätigt werden (kein Auto-Approve)
