# Spec: k3s-orchestrator-dashboard

> Provide mission control dashboards for managing, dispatching, and monitoring fabrik jobs — both web UI and CLI TUI

**Status**: draft
**Version**: 1.1.0
**Last Updated**: 2026-02-16
**Depends On**: `050-k3s-orchestrator`
**Supersedes**: CLI-only interaction model. Dashboard (Web + TUI) + API server become the canonical control plane.

---

## Identity

- **ID**: `051-k3s-orchestrator-dashboard`
- **Filename**: `specs/051-k3s-orchestrator-dashboard.json`
- **Branch prefix**: `k3s-orchestrator-dashboard-`
- **Commit trailer**: `spec: k3s-orchestrator-dashboard`

---

## Title

**Provide a mission control dashboard for managing, dispatching, and monitoring fabrik jobs**

---

## Goals

1. **Provide real-time visibility** into all running Jobs, CronJobs, and their Smithers task-level progress
2. **Enable end-user specification creation** — author specs via the UI using the 10-question interview flow, generate todos, and dispatch runs visually
3. **Enable dispatching runs from the UI** — select spec, template, workflow, configure resources, and launch Jobs or CronJobs
4. **Enable human gate interaction** directly in the dashboard — approve/reject with notes, view task summary and reports, link out to VCS diffs
5. **Page users on human gate via browser notifications, Apple/Android push notifications, and alerting channels** (Grafana AlertManager, Zulip, PagerDuty)
6. **Provide admin mission control** — cluster health, node status, resource usage, token/API-key consumption, cost metrics across all runs
7. **Provide run history and result browsing** — Smithers DB task/review reports, logs, links to result storage and VCS branches
8. **Support multi-user access** with basic authentication

---

## Non-Goals

- **Full IDE / code editor / diff viewer** — link out to GitHub/VCS for diffs, dashboard does not render code
- **Replacing the CLI** — CLI remains the power-user interface; dashboard is complementary
- **Building a custom charting/metrics stack** — leverage Grafana (LAOS) for deep metrics; dashboard shows operational state and links to Grafana for drill-down
- **Offline mode** — dashboard requires connectivity to the cluster
- **Multi-tenancy** — single-user/team scope for v1; namespace strategy from k3s-orchestrator allows future extension

---

## Requirements: CLI TUI Dashboard (k9s-style)

In addition to the web dashboard, fabrik provides a **terminal UI (TUI) dashboard** inspired by k9s — for power users who prefer keyboard-driven, terminal-based interaction.

### TUI vs Web Dashboard

| Aspect | TUI Dashboard (`fabrik dashboard`) | Web Dashboard (browser) |
|--------|-----------------------------------|-------------------------|
| **Interface** | Terminal (keyboard-driven) | Browser (mouse + keyboard) |
| **Latency** | Lower (direct API/VM queries) | Higher (HTTP + SSR) |
| **Offline** | Partial (cached host DB) | No (requires connectivity) |
| **Multi-source** | Yes (VM + K8s side-by-side) | Yes (via API server) |
| **Use case** | Power users, quick checks, debugging | Detailed views, spec creation, onboarding |

### TUI Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Terminal (iTerm2, Alacritty, etc.)                              │
│                                                                  │
│  ┌─ fabrik dashboard ─────────────────────────────────────────┐ │
│  │  Ink (React for Terminal)                                 │ │
│  │  ├── Real-time VM/K8s queries (2s polling)                │ │
│  │  ├── Keyboard shortcuts (vim-style)                      │ │
│  │  ├── Split panes (runs | logs | details)                  │ │
│  │  └── Local cache ( SQLite ~/.cache/fabrik/dashboard.db ) │ │
│  │                                                             │ │
│  │  Modes:                                                     │ │
│  │  ├── runs      → List all runs (VM + K8s)                │ │
│  │  ├── run      → Detail view for selected run             │ │
│  │  ├── logs      → Stream logs from selected run           │ │
│  │  ├── specs     → List specs (cluster + local)            │ │
│  │  ├── dispatch  → Quick dispatch form (TUI-based)         │ │
│  │  └── admin     → Cluster health (nodes, storage, creds)  │ │
│  └───────────────────────────────────────────────────────────┘ │
│       │                                                          │
│       ├──► limactl shell (VM mode) → VM database               │
│       └──► kubectl (K8s mode) → API server → K8s resources     │
└─────────────────────────────────────────────────────────────────┘
```

### TUI Tech Stack

| Component | Library | Why |
|-----------|---------|-----|
| Framework | **Ink** (React for terminals) | Declarative, component-based, handles rendering |
| State | **Effect-TS** | Same patterns as rest of fabrik |
| Keyboard | **ink-use-stdout-dimensions** + custom hooks | Vim-style navigation |
| Tables | **ink-table** (or custom) | k9s-style resource tables |
| Spinners | **ink-spinner** | Loading states |
| Split Panes | **ink-box** + flex layout | Side-by-side panes |

### TUI Commands & Navigation

```bash
# Start TUI dashboard
fabrik dashboard                          # Auto-detect sources (VMs + K8s)
fabrik dashboard --vm ralph-1              # VM mode only
fabrik dashboard --kubeconfig ~/.kube/prod  # K8s mode only

# Inside TUI (vim-style shortcuts)
?           Show help / keyboard shortcuts
g r         Go to "runs" view (list all runs)
g s         Go to "specs" view
g a         Go to "admin" view
d           Dispatch new run (opens form)
r           Resume selected run
c           Cancel selected run
l           Stream logs for selected run
f           Fast-forward / jump to human gate feedback
Enter       View run details
Tab         Switch panes (left ↔ right)
q / Esc     Quit / go back
Ctrl+C      Force quit
```

### TUI Views

#### runs View (Default)

```
┌─ Fabrik Dashboard ───────────────────────────────────────────────┐
│ Runs (3 sources)                    [ralph-1] [dev-k3s] [prod]   │
├──────────────────────────────────────────────────────────────────┤
│ NAME          │ SOURCE   │ STATUS   │ TASK       │ PROGRESS     │
├───────────────┼──────────┼──────────┼────────────┼──────────────┤
│ run-113       │ ralph-1  │ running  │ 16:impl    │ 150/192 78% ▶│
│ run-114       │ dev-k3s  │ blocked  │ review     │ 88% ⚠️       │
│ 01jk7v8x...   │ prod     │ finished │ done       │ 100% ✓       │
│               │          │          │            │              │
│               │          │          │            │              │
├──────────────────────────────────────────────────────────────────┤
│ [r] resume │ [c] cancel │ [l] logs │ [d] dispatch │ [?] help     │
└──────────────────────────────────────────────────────────────────┘
```

**Columns:**
- NAME: Run ID (ULID or numeric for VMs)
- SOURCE: Which VM or K8s cluster
- STATUS: running | blocked | finished | failed | pending
- TASK: Current task (e.g., "16:impl", "review-3", "human-gate")
- PROGRESS: Tasks finished / total + percentage
- Indicators: ▶ selected, ⚠️ needs attention, ✓ completed

#### run View (Detail)

```
┌─ Run: run-113 ──────────────────────────────────────────────────┐
│ From: ralph-1  │ Status: running  │ Task: 16:impl (attempt 1)     │
├──────────────────────────────────────────────────────────────────┤
│ Timeline:                                                        │
│  ✓ 1:impl    2m ago     ✓ 1:val    3m ago                       │
│  ✓ 2:impl    5m ago     ✓ 2:val    6m ago                       │
│  → 16:impl   now        ⏳ 16:val   pending                     │
│                                                                  │
│ Active Reviewers: 3 of 8 complete                                │
│  ✓ CODE-QUALITY         ✓ TIGERSTYLE        → SECURITY         │
│                                                                  │
│ Last Log Output:                                                 │
│  [00:03:45] Running typecheck...                                 │
│  [00:03:52] ✓ Type check passed                                  │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ [l] stream logs │ [r] resume │ [c] cancel │ [f] feedback │ [←] back│
└──────────────────────────────────────────────────────────────────┘
```

#### logs View (Streaming)

```
┌─ Logs: run-113 ─────────────────────────────────────────────────┐
│ Source: ralph-1 │ Auto-scroll: ON │ Follow: ON                  │
├──────────────────────────────────────────────────────────────────┤
│ [00:00:00] → 16:impl (attempt 1, iteration 0)                   │
│ [00:00:45] ✓ 16:impl (attempt 1)                                │
│ [00:00:46] → 16:val (attempt 1, iteration 0)                    │
│ [00:01:02] ✓ 16:val (attempt 1)                                 │
│ [00:01:03] → 16:impl (attempt 1, iteration 1)                   │
│ ...                                                              │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ [s] toggle scroll │ [f] toggle follow │ [g] goto line │ [←] back│
└──────────────────────────────────────────────────────────────────┘
```

#### admin View (Mission Control)

```
┌─ Admin: ralph-1 ─────────────────────────────────────────────────┐
│ Nodes: 1 │ CPU: 45% │ Memory: 62% │ Storage: 12GB/30GB         │
├──────────────────────────────────────────────────────────────────┤
│ Active Runs: 3              │ Credentials: Anthropic 2 keys ✓   │
│ Blocked: 1 (needs feedback) │            OpenAI 1 key ⚠️       │
│ Finished (24h): 12          │            GitHub 1 key ✓         │
│                                                              │
│ Storage:                                                     │
│  run-113: 72MB  │ run-114: 45MB  │ run-115: 128MB               │
│                                                              │
│ LAOS: Connected ✓  │ Last backup: 2h ago                      │
├──────────────────────────────────────────────────────────────────┤
│ [b] backup now │ [r] rotate creds │ [c] cleanup old runs        │
└──────────────────────────────────────────────────────────────────┘
```

### TUI Dispatch Form

Quick TUI-based dispatch (simpler than web wizard):

```
┌─ Dispatch New Run ──────────────────────────────────────────────┐
│                                                                  │
│ Spec: [specs/feature.json      ] [Tab to select]               │
│ Todo: [specs/feature.todo.json  ] [optional]                    │
│                                                                     │
│ Source: ( ) ralph-1  (●) dev-k3s  ( ) prod-k3s               │
│                                                                     │
│ Template: (●) coding  ( ) report  ( ) marketing               │
│                                                                     │
│ [✓] Include .git                                            │
│                                                                     │
│ Resources: CPU [4    ]  Memory [8Gi ]                         │
│                                                                     │
│ [Enter] Dispatch  [Esc] Cancel                                 │
└──────────────────────────────────────────────────────────────────┘
```

### TUI Implementation Notes

**Ink Components Needed:**
```typescript
// Key components for TUI dashboard
import { Box, Text, useInput, useApp } from 'ink';
import { useState, useEffect } from 'react';

// Custom hooks
const useFabrikStatus = (source: Source) => {...};  // Poll VM/K8s
const useKeyboardNav = (items: any[]) => {...};    // vim-style j/k
const useSplitPane = () => {...};                   // Pane management

// Main views
const RunsView = () => {...};     // Table of runs
const RunDetailView = () => {...}; // Single run detail
const LogsView = () => {...};      // Streaming logs
const SpecsView = () => {...};     // Spec list
const DispatchForm = () => {...};  // TUI form
const AdminView = () => {...};     // Cluster health
```

**Sync Strategy:**
- Poll every 2s when TUI is active
- Maintain local cache (Ink state)
- Background sync to host DB (when idle)
- Detect stale data (VM timestamp vs local)

---

## Requirements: API

### Fabrik API Server

A backend API server deployed in the k3s cluster (`fabrik-system` namespace) built with **Bun + Effect**.

The API server is the **canonical backend for both dashboard AND CLI**. When `--kubeconfig` is used, the CLI talks to this API server (not kubectl directly). It wraps:
- Kubernetes API (via `kubectl` or K8s client) for Job/CronJob/Pod/Node state
- Smithers SQLite DB reads from run PVCs for task/review reports
- LAOS APIs (Loki for logs, Prometheus for metrics) for operational data
- `fabrik-credentials` Secret for credential status

```
API Endpoints (Effect RPC):

# Runs
runs.list()           → RunSummary[]       (all Jobs + CronJobs in fabrik-runs)
runs.get(runId)       → RunDetail          (full Smithers DB data + K8s status)
runs.dispatch(opts)   → DispatchResult     (create Job)
runs.cancel(runId)    → void               (delete Job)

# LAOS health
health.laos()         → LaosHealth         (check LAOS reachability; fail if down)
health.cluster()      → ClusterHealth      (K8s API + storage + images)

# Schedules (CronJobs)
schedules.list()      → ScheduleSummary[]
schedules.create(opts)→ ScheduleResult     (create CronJob)
schedules.delete(id)  → void

# Specs
specs.list()          → SpecSummary[]      (specs in cluster storage)
specs.get(id)         → SpecDetail         (spec + todo JSON)
specs.create(spec)    → SpecResult         (save spec JSON to cluster)
specs.validate(spec)  → ValidationResult

# Todos
todos.generate(specId)→ TodoResult         (generate todo from spec)

# Feedback (Human Gate)
feedback.pending()    → HumanGateEntry[]   (all blocked runs)
feedback.submit(opts) → void               (approve/reject)

# Cluster
cluster.health()      → ClusterHealth      (nodes, resources, storage, images)
cluster.nodes()       → NodeInfo[]

# Credentials
credentials.status()  → CredentialStatus[] (per-provider key count, rate-limit state)

# Admin / Metrics
admin.tokenUsage()    → TokenUsageReport   (per-run, per-provider API token consumption)
admin.costEstimate()  → CostReport         (estimated cost across providers)
admin.runStats()      → RunStatsReport     (success/fail rates, durations, by template)

# Environment Variables
env.list()            → EnvSetSummary[]    (all env sets by project/environment)
env.get(projectId, envName) → EnvSet       (full key-value map, .env format exportable)
env.set(projectId, envName, vars) → void   (create/update env set)
env.setKey(projectId, envName, key, value) → void  (update single key)
env.delete(projectId, envName) → void      (delete entire env set)
env.deleteKey(projectId, envName, key) → void  (delete single key)
env.validate(projectId, envName) → ValidationResult  (check required keys present)
env.parseDotenv(content) → ParsedEnv      (server-side .env parsing)
```

### Dashboard UI (TanStack Start + Effect + React)

Tech stack matches `effect-tanstack-start`:
- **TanStack Start** — full-stack React framework with SSR
- **TanStack Router** — file-based type-safe routing
- **Effect-TS** — business logic, RPC client, error handling
- **@effect/rpc** — type-safe client-server communication with the fabrik API
- **Tailwind CSS 4** — styling
- **Lucide React** — icons
- **Bun** — runtime

Deployed as a container in `fabrik-ui` namespace, exposed via:
- Port-forward: `kubectl port-forward -n fabrik-ui svc/fabrik-dashboard 3000:3000`
- Ingress: optional, configurable (Traefik ingress from k3s)

### Dashboard Pages / Routes

```
/                           → Overview (mission control home)
/runs                       → Run list (Jobs + CronJob runs, filterable)
/runs/:id                   → Run detail (Smithers task progress, reports, logs)
/runs/:id/feedback          → Human gate feedback form (approve/reject + notes)
/schedules                  → CronJob list (next run, history)
/schedules/new              → Create CronJob form
/dispatch                   → Dispatch new run (select spec, template, configure)
/specs                      → Spec list (browse, view status)
/specs/new                  → Spec creation wizard (10-question interview flow)
/specs/:id                  → Spec detail + todo viewer
/specs/:id/todo             → Todo generation / viewer
/admin                      → Admin mission control
/admin/cluster              → Cluster health (nodes, resources, storage)
/admin/credentials          → Credential status (key count, rate limits)
/admin/metrics              → Token usage, cost, run statistics
/admin/backups              → Backup status, trigger manual backup, view history
/settings                   → Dashboard settings (notification channels, LAOS URLs)
/login                      → Basic auth login

# Environment Variable Management
/env                        → Environment overview (all projects/environments)
/env/:projectId             → Project environments list (dev/prod/staging etc)
/env/:projectId/:envName    → Environment editor (key-value UI, .env upload/paste)
/env/:projectId/:envName/diff → Diff view before applying changes
```

---

## Requirements: Behavior

### Spec Creation Flow (End-User)

```
Given: User navigates to /specs/new
Then:  A step-by-step wizard presents the 10 interview questions (Q1-Q10)
And:   Each step validates input before proceeding
And:   On completion, the spec JSON is saved to cluster storage
And:   User is prompted to generate a todo

Given: User clicks "Generate Todo" on /specs/:id
Then:  The API calls the todo generation logic
And:   The generated todo JSON is displayed for review
And:   User can edit/approve the todo
And:   On approval, the todo is saved and the spec status moves to "ready"
```

### Dispatch Flow

```
Given: User navigates to /dispatch
Then:  User selects a spec (from cluster storage or upload)
And:   User selects a template (coding, report, marketing, custom)
And:   User optionally selects a workflow (default: smithers-spec-runner.tsx)
And:   User optionally configures: repo URL, resource limits, model, iterations
And:   User clicks "Dispatch"
Then:  API creates a K8s Job in fabrik-runs namespace
And:   User is redirected to /runs/:id to watch progress

Given: User navigates to /schedules/new
Then:  Same flow as dispatch plus cron schedule input
And:   Concurrency policy selector (Forbid/Allow/Replace)
And:   On submit, API creates a K8s CronJob
```

### Environment Variable Management Flow

**Vercel-Style Editor:**

```
Given: User navigates to /env
Then:  Dashboard shows list of all projects with environment counts
And:   Each project shows: dev, prod, staging badges with key counts

Given: User clicks on project "myapp"
Then:  Shows environment tabs: [dev] [prod] [staging] [+ New Env]
And:   Active tab shows key-value table

Given: User is on /env/myapp/dev
Then:  Dashboard shows:
       ┌─────────────────────────────────────────────────────────┐
       │  Project: myapp                                    [Sync]│
       │  Environment: [dev ▼] [prod ▼] [staging ▼] [+ New]   │
       ├─────────────────────────────────────────────────────────┤
       │  [Upload .env]  [Paste .env]  [+ Add Variable]          │
       │                                                         │
       │  ┌─────────────────────────────────────────────────┐   │
       │  │ KEY                    │ VALUE                  │ ✕ │ │
       │  ├────────────────────────┼────────────────────────┼───┤ │
       │  │ ANTHROPIC_API_KEY      │ sk-ant-...             │ ✕ │ │
       │  │ LAOS_LOKI_URL          │ http://loki...         │ ✕ │ │
       │  │ DEBUG                  │ true                   │ ✕ │ │
       │  └─────────────────────────────────────────────────┘   │
       │                                                         │
       │  [Save Changes]                                    │   │
       │  Diff: 1 added, 2 modified, 0 deleted              │   │
       └─────────────────────────────────────────────────────────┘

Given: User clicks "Upload .env"
Then:  File picker opens
And:   Selected file parsed server-side
And:   Diff preview shown before save

Given: User clicks "Paste .env"
Then:  Textarea modal opens with placeholder:
       "ANTHROPIC_API_KEY=sk-...\nLAOS_LOKI_URL=http://..."
And:   On paste, parses and shows diff

Given: User clicks "+ Add Variable"
Then:  New empty row appears with KEY/VALUE inputs
And:   Validates key format (alphanumeric + underscore)

Given: User modifies values and clicks "Save Changes"
Then:  API calls env.set() with full variable map
And:   If validation fails (missing required keys):
       Show error: "Missing required: LAOS_LOKI_URL"
And:   On success: Shows "Environment saved" toast
And:   Triggers reconciliation for any running pods (optional)

Given: User attempts to dispatch with missing environment
When:  On /dispatch, user selects --env staging
And:   fabrik-env-myapp-staging does not exist
Then:  Dashboard shows error inline:
       "Environment 'staging' not found. Create it first."
And:   Link to /env/myapp with "staging" pre-selected for creation
```

**Pre-Dispatch Validation:**

```
Given: User configures dispatch on /dispatch
When:  Selects repo "github.com/org/myapp" and env "dev"
Then:  Dashboard calls env.validate("myapp", "dev")
And:   If missing: Shows red error banner with link to create
And:   If missing required keys: Lists missing keys with suggested fixes
And:   "Dispatch" button disabled until resolved
```

**Bidirectional Sync UI:**

```
Given: User on /env/myapp/dev
When:  Clicks "Download .env" button
Then:  Downloads fabrik-myapp-dev.env file with:
       # Generated by fabrik from project=myapp env=dev
       # Downloaded: 2026-02-14T20:00:00Z
       KEY=value
       ...

Given: User has local .env changes
When:  Clicks "Upload and Merge"
Then:  Shows three-way diff: Current | Incoming | Merged
And:   User selects conflict resolution strategy
And:   Applies merged result
```

### Run Monitoring

```
Given: User navigates to /runs
Then:  A table shows all runs with: spec ID, template, status, duration, created at
And:   Status updates via polling (configurable interval, default: 5s)
And:   Filterable by: status, template, spec, date range

Given: User navigates to /runs/:id
Then:  Dashboard shows:
       - K8s Job status (Pending/Running/Succeeded/Failed)
       - Smithers phase (task N of M, review round, human gate)
       - Task list with per-task status (done/running/blocked/failed)
       - Task reports (expandable, showing do/verify/output)
       - Review reports (per-reviewer verdict)
       - Pod logs (streamed from Loki or kubectl logs)
       - Links to VCS (branch URL, PR if created)
       - Links to result storage (S3/WebDAV/PVC)
       - Heartbeat status (last seen, staleness)
```

### Human Gate Feedback

```
Given: A run reaches human gate (status: blocked)
Then:  The run appears on /runs with a "Needs Feedback" badge
And:   Browser notification is fired (Web Notifications API)
And:   Push notification sent via configured channel (Apple/Android push, Zulip, PagerDuty)
And:   /runs/:id/feedback page shows:
       - Task summary and what was accomplished
       - Review results from all 8 reviewers
       - Links to VCS diff (GitHub compare URL)
       - Links to result artifacts
       - Approve/Reject buttons with notes textarea

Given: User submits feedback (approve or reject)
Then:  API writes feedback to the Smithers DB in the pod's PVC
And:   Pod detects feedback and continues or stops
And:   Run status updates on the dashboard
And:   Notification channels receive resolution confirmation
```

### Notification System

```
Given: Dashboard settings has notification channels configured
When:  A human gate is reached
Then:  Notifications are dispatched via ALL configured channels:

Channel types:
- Browser: Web Notifications API (requires permission grant)
- Push: Apple Push Notifications (APNs) / Firebase Cloud Messaging (FCM)
- Zulip: Webhook to configured channel
- PagerDuty: Incident via Events API
- Grafana AlertManager: Alert routed per contact point configuration
- Email: SMTP (optional)

Each notification includes:
- Run ID, spec ID, template
- What phase the run reached
- Direct link to /runs/:id/feedback
```

### Admin Mission Control

```
Given: Admin navigates to /admin
Then:  Dashboard shows high-level overview:
       - Active runs count (by template, by status)
       - Cluster utilization (CPU/memory across nodes)
       - Recent failures with reasons
       - Upcoming CronJob runs

Given: Admin navigates to /admin/metrics
Then:  Dashboard shows:
       - Token usage per provider (Anthropic, OpenAI) across all runs
         - Token usage data is sourced from Smithers DB per-run task reports
           (Smithers records token counts per agent invocation in task_report rows)
           - Dependency: Smithers must emit token usage data (see k3s-orchestrator spec)
       - Estimated cost per run and aggregate
       - Run success/failure rates over time
       - Average run duration by template
       - Rate-limit events and credential rotation history

Given: Admin navigates to /admin/cluster
Then:  Dashboard shows:
       - Node list with status, CPU, memory, disk
       - Storage provisioner status (Longhorn/local-path)
       - PVC usage (how many run workspaces, total storage)
       - Image registry status
       - Links to Grafana dashboards for deep drill-down

Given: Admin navigates to /admin/credentials
Then:  Dashboard shows:
       - Per-provider key count (e.g. 2x Anthropic, 1x OpenAI)
       - Rate-limit status per key
       - Last rotation timestamp
       - Button to trigger credential rotation

Given: Admin navigates to /admin/env or clicks "Environments" from /admin
Then:  Dashboard shows environment management overview:
       - Total projects with env configured
       - Total environment variables across all projects
       - Projects missing required keys (ANTHROPIC_API_KEY, LAOS_LOKI_URL)
       - Recent env changes (last 24h)
       - Link to /env for detailed editing

Given: Admin clicks on specific project in /admin/env
Then:  Shows per-project env health:
       - Environment counts (dev/prod/staging)
       - Key completeness check per environment
       - Last update timestamp
       - "Quick Edit" button linking to /env/:projectId
```

### Authentication

```
Given: Dashboard is accessed without authentication
Then:  User is redirected to /login

Given: User provides valid basic auth credentials
Then:  Session is established (cookie-based)
And:   All API calls include the session token

Authentication is basic auth for v1:
- Credentials stored in a K8s Secret (fabrik-ui-auth)
- Username/password pairs
- No OAuth/OIDC for v1 (future spec)
```

---

## Requirements: Observability

### Dashboard Telemetry

The dashboard itself reports to LAOS:

| Signal | Destination | What |
|--------|-------------|------|
| Logs | Loki | API requests, errors, auth events |
| Traces | Tempo (via OpenTelemetry) | Request traces through API → K8s → Smithers DB |
| Metrics | Prometheus | Request latency, active sessions, notification delivery |
| Errors | Sentry (via LAOS) | Unhandled exceptions, API failures |
| Analytics | PostHog (via LAOS) | Page views, feature usage, user flows |

### Dashboard-Specific Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `fabrik.dashboard.requests` | counter | route, method, status |
| `fabrik.dashboard.latency` | histogram | route |
| `fabrik.dashboard.active_sessions` | gauge | — |
| `fabrik.dashboard.notifications.sent` | counter | channel, type |
| `fabrik.dashboard.notifications.failed` | counter | channel, type |
| `fabrik.dashboard.feedback.submitted` | counter | decision |

### Alerts

| Condition | Severity | Action |
|-----------|----------|--------|
| Dashboard pod unhealthy | P2 | Restart pod, check logs |
| API server unreachable from dashboard | P1 | Check fabrik-system pods |
| Notification delivery failure | P2 | Check channel configuration |
| Human gate unacknowledged >1hr | P1 | Escalate via PagerDuty |

---

## Requirements: Deployment

### Kubernetes Resources

```yaml
# Namespace
fabrik-ui

# Deployments
fabrik-api-server    (in fabrik-system)  # Bun + Effect API server
fabrik-dashboard     (in fabrik-ui)      # TanStack Start SSR app

# Services
fabrik-api-server    ClusterIP :4000     # internal, dashboard → API
fabrik-dashboard     ClusterIP :3000     # exposed via port-forward or ingress

# Ingress (optional)
fabrik-dashboard     dashboard.fabrik.local (or custom domain)

# Secrets
fabrik-ui-auth       (in fabrik-ui)      # basic auth credentials

# ConfigMap
fabrik-ui-config     (in fabrik-ui)      # LAOS URLs, notification config, API URL

# RBAC
fabrik-api-role          (ClusterRole)       # list/watch/exec pods, jobs, cronjobs, secrets, PVCs
fabrik-api-binding       (ClusterRoleBinding) # binds to fabrik-api-server ServiceAccount
fabrik-api-sa            (ServiceAccount)     # in fabrik-system
```

### Container Images

```nix
# Two new container images:
packages.<system>.docker-api-server   = ...   # Bun + Effect API server
packages.<system>.docker-dashboard    = ...   # TanStack Start app (SSR, Bun)
```

Both built with Dockerfile (matching `effect-tanstack-start` pattern) or Nix.

### Exposure Options

| Method | Command | Use Case |
|--------|---------|----------|
| Port-forward | `kubectl port-forward -n fabrik-ui svc/fabrik-dashboard 3000:3000` | Local dev, single user |
| Ingress | Traefik IngressRoute (k3s default) | Production, team access |
| NodePort | `svc/fabrik-dashboard type: NodePort` | Simple external access |

---

## Requirements: Integration with k3s-orchestrator

### Data Flow

```
User (browser)
    │
    ▼
fabrik-dashboard (fabrik-ui namespace)
    │  TanStack Start SSR
    │  @effect/rpc client
    │
    ▼
fabrik-api-server (fabrik-system namespace)
    │  Bun + Effect
    │  @effect/rpc server
    │
    ├──► kubectl (K8s API)
    │    ├── Jobs, CronJobs, Pods (fabrik-runs)
    │    ├── Secrets (fabrik-system)
    │    ├── Nodes, Resources
    │    └── PVCs (run workspaces)
    │
    ├──► Smithers SQLite DBs (Longhorn PVC mounted in fabrik-runs; API server
    │    reads via kubectl exec or dedicated sidecar — see PVC Access below)
    │    ├── task_report rows
    │    ├── review_report rows
    │    └── human_gate rows
    │
    ├──► LAOS APIs
    │    ├── Loki (logs)
    │    ├── Prometheus (metrics, token usage)
    │    └── Grafana (link generation for deep drill-down)
    │
    └──► Notification channels
         ├── Web Push (APNs / FCM)
         ├── Zulip webhook
         ├── PagerDuty Events API
         └── Grafana AlertManager
```

### PVC Access Pattern

PVCs in `fabrik-runs` cannot be directly mounted by the API server in `fabrik-system` (cross-namespace PVC mount is not supported in K8s).

**Solution**: The API server uses `kubectl exec` to read Smithers DB files from running pods, or `kubectl cp` from completed pods (before TTL cleanup):

```
Given: API server needs to read Smithers DB for /runs/:id
When:  Pod is still running
Then:  kubectl exec <pod> -- cat /workspace/.smithers/<ulid>.db > /tmp/<ulid>.db
And:   API server reads the local copy

When:  Pod has completed but not yet cleaned up (ttlSecondsAfterFinished window)
Then:  kubectl cp fabrik-runs/<pod>:/workspace/.smithers/<ulid>.db /tmp/<ulid>.db

When:  Pod is gone (cleaned up)
Then:  API server reads from backup storage (S3/WebDAV)
And:   If no backup exists, returns "results expired" error
```

**Alternative for production**: A Longhorn `ReadWriteMany` (RWX) volume or a shared NFS export from Longhorn could allow direct mounting, but this adds complexity. v1 uses kubectl exec/cp.

### CLI ↔ Dashboard Parity

The dashboard and CLI share the same underlying operations. The API server is the canonical backend for both:

| Operation | CLI (via API server) | Dashboard |
|-----------|---------------------|-----------|
| Dispatch run | `fabrik run --kubeconfig` | /dispatch page |
| Create schedule | `fabrik schedule --kubeconfig` | /schedules/new page |
| View runs | `fabrik runs list --kubeconfig` | /runs page |
| Run detail | `fabrik runs show --kubeconfig` | /runs/:id page |
| Cancel run | `fabrik runs cancel --kubeconfig` | /runs/:id Cancel button |
| Feedback | `fabrik feedback --kubeconfig` | /runs/:id/feedback page |
| Create spec | `fabrik spec interview` | /specs/new wizard |
| Cluster health | `fabrik doctor --kubeconfig` | /admin/cluster page |
| Credential status | `fabrik credentials list` | /admin/credentials page |
| Backup | `fabrik backup --kubeconfig` | /admin/backups page |

**Unified Backend**: Both CLI and dashboard call the same fabrik API server. There is ONE source of truth, not two competing reconciliation loops.

### Single Control Plane

The fabrik API server is the **only** component that talks to the Kubernetes API. Neither the CLI nor the dashboard queries K8s directly:

```
CLI (fabrik run --kubeconfig)
    │
    └──► fabrik API server (:4000, in fabrik-system)
              │
              ├──► K8s API (Jobs, CronJobs, Pods, Secrets)
              ├──► Smithers DBs (via Longhorn PVC)
              └──► LAOS APIs (Loki, Prometheus)

Dashboard (browser)
    │
    └──► fabrik API server (:4000, same instance)
```

This eliminates dual-control-plane drift. The host `ralph.db` is no longer needed — the API server IS the state authority.

---

## Requirements: Spec Creation Wizard

### 10-Question Interview Flow

The wizard mirrors the `specs/INTERVIEW.md` interview process:

| Step | Question | UI Element |
|------|----------|------------|
| 1 | Identity (kebab-case ID) | Text input with validation |
| 2 | Title (one sentence) | Text input with guidelines |
| 3 | Status | Auto-set to `draft` |
| 4 | Goals (3-7) | Dynamic list, add/remove items |
| 5 | Non-Goals | Dynamic list, add/remove items |
| 6 | Requirements: API | Rich text / structured input |
| 7 | Requirements: Behavior | Given/When/Then builder |
| 8 | Requirements: Observability | Metrics/Logs/Alerts form |
| 9 | Acceptance Criteria | Checklist builder |
| 10 | Assumptions | Dynamic list |

Each step:
- Shows guidance text from the interview document
- Validates before allowing next
- Allows going back to edit previous answers
- Shows live preview of the spec JSON

On completion:
- Spec JSON is saved to cluster storage (ConfigMap or PVC)
- User is offered "Generate Todo" action
- After todo approval, spec status → `ready`, dispatch button appears

---

## Acceptance Criteria

- [ ] Dashboard deploys in `fabrik-ui` namespace and is accessible via port-forward
- [ ] API server deploys in `fabrik-system` namespace and serves all RPC endpoints
- [ ] `/runs` page shows all Jobs/CronJobs with live status (polling-based)
- [ ] `/runs/:id` page shows Smithers task-level progress, reports, and pod logs
- [ ] `/runs/:id/feedback` page allows approve/reject with notes; pod unblocks on submit
- [ ] `/dispatch` page creates a K8s Job that runs to completion
- [ ] `/schedules/new` page creates a K8s CronJob visible in `/schedules`
- [ ] `/specs/new` wizard walks through 10 interview questions and saves valid spec JSON
- [ ] `/specs/:id/todo` generates and saves a todo JSON from the spec
- [ ] `/admin/cluster` shows node health, resource usage, storage status
- [ ] `/admin/metrics` shows per-run token usage and cost estimates
- [ ] `/admin/credentials` shows per-provider key count and rate-limit state
- [ ] Browser notifications fire when a human gate is reached
- [ ] At least one push notification channel works (Zulip webhook or browser push)
- [ ] Basic auth login works; unauthenticated requests redirect to `/login`
- [ ] Dashboard emits logs/traces/metrics to LAOS
- [ ] Optional Traefik ingress exposes dashboard externally
- [ ] Container images build for both API server and dashboard
- [ ] CLI and dashboard produce identical results for the same operations
- [ ] CLI with `--kubeconfig` talks to the API server, not kubectl directly
- [ ] `/runs/:id` Cancel button gracefully stops a running Job
- [ ] Dashboard fails with actionable error when LAOS is unreachable
- [ ] `/env` page lists all project environments with key counts
- [ ] `/env/:projectId/:envName` page provides Vercel-style key-value editor
- [ ] Environment variables can be uploaded via `.env` file, pasted as text, or edited individually
- [ ] Pre-dispatch validation prevents runs with missing or invalid environments
- [ ] Dashboard shows diff preview before saving environment changes
- [ ] Environment variables are injected into pods and available to Smithers workflows
- [ ] `/admin/env` shows environment health overview (missing keys, recent changes)
- [ ] No dual control plane: CLI and dashboard share the same API server backend

### CLI TUI Dashboard (k9s-style) Acceptance Criteria

- [ ] `fabrik dashboard` launches TUI dashboard in terminal (Ink-based)
- [ ] TUI shows runs from all sources (VMs + K8s clusters) in unified table view
- [ ] TUI updates every 2 seconds (configurable) with live status
- [ ] Keyboard navigation works: j/k (up/down), Enter (select), q (quit), ? (help)
- [ ] Multiple panes: runs list | run detail | logs (switchable with Tab)
- [ ] Vim-style shortcuts: g r (go runs), g s (go specs), g a (go admin), d (dispatch)
- [ ] TUI dispatch form allows quick run creation without web UI
- [ ] TUI streams logs in real-time from selected run
- [ ] TUI shows progress bars for task completion
- [ ] TUI highlights blocked runs with color coding (yellow=attention, red=failed)
- [ ] TUI works in both VM mode (`--vm`) and K8s mode (`--kubeconfig`)
- [ ] `fabrik daemon` runs in background, maintains persistent VM/K8s connections
- [ ] TUI connects to daemon via Unix socket for event streaming
- [ ] TUI shows "stale" indicator when connection to source is lost
- [ ] TUI handles terminal resize gracefully ( responsive layout)
- [ ] TUI uses 256 colors when available, falls back to basic colors
- [ ] TUI performance: <100ms to render 100 runs on modern hardware

---

## Assumptions

- `050-k3s-orchestrator` spec is implemented — the dashboard depends on its namespaces, PVCs, Secrets, and Job/CronJob resources
- LAOS is running (in-cluster or external) and reachable from the dashboard and API server
- The `effect-tanstack-start` stack (`~/git/playground/effect-tanstack-start/`) is the reference architecture for the **web** dashboard app: TanStack Start, Effect-TS, @effect/rpc, Tailwind CSS 4, Bun, Vitest
- The **TUI** dashboard uses **Ink** (React for terminals) with Effect-TS for state management
- The **daemon** (`fabrik-daemon`) uses Bun + Effect with async iterators for event streaming
- The API server uses Bun + Effect with @effect/rpc for type-safe communication
- `kubectl` is available in the API server pod (or a K8s client library is used)
- Smithers SQLite DBs in run PVCs are readable by the API server pod (via PVC mount or kubectl cp)
- Basic auth is sufficient for v1; OAuth/OIDC is a future spec
- Push notifications require configuration (APNs cert, FCM key, Zulip webhook URL) provided via dashboard settings
- Polling interval for run status is configurable (default: 5 seconds)
- The dashboard does not need to work offline — it always needs cluster connectivity
- Grafana is used for deep metric drill-down; the dashboard links to it rather than reimplementing charts
- LAOS must be running and reachable; dashboard and API server fail with actionable errors if LAOS health check fails
- Environment variables are stored as Kubernetes Secrets in `fabrik-system` namespace; dashboard has read/write access via RBAC
- The dashboard supports `.env` file format (KEY=VALUE, comments, newlines) for bulk import/export
- Project IDs are valid DNS-1123 labels (lowercase alphanumeric with hyphens)
- Environment names are simple strings (dev, prod, staging) with no special characters
- Required env vars (`ANTHROPIC_API_KEY`, `LAOS_LOKI_URL`) are enforced at the API level before dispatch

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  User (Browser / Mobile)                                                    │
│                                                                              │
│  ┌─ Browser ──────────────────────────────────────────────────────────┐     │
│  │  fabrik Dashboard (TanStack Start SSR)                             │     │
│  │  ├── /              Mission Control overview                       │     │
│  │  ├── /runs          Job monitoring + Smithers progress             │     │
│  │  ├── /dispatch      Visual run dispatch                            │     │
│  │  ├── /specs/new     10-question spec wizard                        │     │
│  │  ├── /schedules     CronJob management                             │     │
│  │  ├── /admin         Cluster health + metrics + credentials         │     │
│  │  └── notifications  Browser push + mobile push                     │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│       │ @effect/rpc (type-safe, polling)                                     │
│       ▼                                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  k3s Cluster                                                                 │
│                                                                              │
│  ┌─ fabrik-ui namespace ───────────────────────────────────────────────┐    │
│  │  Deployment: fabrik-dashboard                                       │    │
│  │  ├── TanStack Start (SSR, Bun runtime)                              │    │
│  │  ├── @effect/rpc client → fabrik-api-server                         │    │
│  │  └── Service :3000 (port-forward or Ingress)                        │    │
│  │                                                                      │    │
│  │  Secret: fabrik-ui-auth (basic auth credentials)                    │    │
│  │  ConfigMap: fabrik-ui-config (LAOS URLs, notification config)       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─ fabrik-system namespace ───────────────────────────────────────────┐    │
│  │  Deployment: fabrik-api-server                                      │    │
│  │  ├── Bun + Effect                                                   │    │
│  │  ├── @effect/rpc server                                             │    │
│  │  ├── kubectl / K8s API access (ServiceAccount + RBAC)               │    │
│  │  ├── PVC access for Smithers DB reads                               │    │
│  │  └── Service :4000 (ClusterIP, internal only)                       │    │
│  │                                                                      │    │
│  │  Secret: fabrik-credentials (API keys, multi-key)                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─ fabrik-runs namespace ─────────────────────────────────────────────┐    │
│  │  Jobs, CronJobs, Pods, PVCs (run workspaces)                        │    │
│  │  (managed by k3s-orchestrator, read by API server)                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─ fabrik-monitoring (optional) ──────────────────────────────────────┐    │
│  │  LAOS: Grafana / Loki / Tempo / Prometheus / Sentry / PostHog      │    │
│  │  AlertManager → Zulip / PagerDuty / Email                          │    │
│  │  Dashboard links to Grafana for deep drill-down                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─ Notification Channels ─────────────────────────────────────────────┐    │
│  │  ├── Web Push (Service Worker in browser)                           │    │
│  │  ├── Apple Push Notifications (APNs)                                │    │
│  │  ├── Firebase Cloud Messaging (FCM / Android)                       │    │
│  │  ├── Zulip Webhook                                                  │    │
│  │  ├── PagerDuty Events API v2                                        │    │
│  │  └── Grafana AlertManager contact points                            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Relation to Existing Code

| Source | What We Reuse | Where |
|--------|---------------|-------|
| `effect-tanstack-start` | Full tech stack: TanStack Start, Effect, @effect/rpc, Tailwind, Vitest, Bun, LAOS integration, Dockerfile | Dashboard app |
| `050-k3s-orchestrator` spec | Namespaces, PVCs, Jobs, CronJobs, Secrets, storage, credential rotation | API server reads these |
| `specs/INTERVIEW.md` | 10-question interview content | /specs/new wizard guidance text |
| `prompts/COMPOUND-ENGINEERING.md` | Todo generation guidance | /specs/:id/todo generation |
| `src/fabrik/dispatch.ts` | Dispatch logic patterns | API server dispatch endpoint |
| `src/fabrik/reconcile.ts` | Reconciliation patterns | API server run status |
| `src/fabrik/feedback.ts` | Feedback write patterns | API server feedback endpoint |
| `src/fabrik/specs.ts` | Spec validation logic | API server spec validation |
| LAOS stack | Grafana, Loki, Tempo, Prometheus, Sentry, PostHog | Dashboard telemetry + admin metrics |
