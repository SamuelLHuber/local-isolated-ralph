# Spec: k3s-orchestrator-dashboard

> Mission control dashboards for fabrik — web UI and CLI TUI, both direct K8s access

**Status**: draft  
**Version**: 2.1.0  
**Last Updated**: 2026-02-16  
**Depends On**: `051-k3s-orchestrator`  
**Supersedes**: All previous dashboard approaches. Direct K8s API access only (like kubectl/k9s).

---

## Changelog

- **v2.1.0** (2026-02-16): Added debugging section (kubectl/k9s), clarified log streaming mechanism
- **v2.0.0** (2026-02-16): Direct K8s API spec, Ink-based TUI, no daemon
- **v1.1.0** (2026-02-16): First draft with daemon (since removed)

---

## Identity

**What**: Two dashboard interfaces for monitoring and managing fabrik jobs:
1. **Web Dashboard**: Browser-based, rich UI, full features
2. **CLI TUI**: Terminal-based, keyboard-driven, fast (like k9s)

**Both use direct K8s API** - no daemon, no API server, just `@kubernetes/client-node` like kubectl.

**Not**: 
- VM dashboards (sunset)
- Daemon-based (overkill, k9s doesn't need one)
- Separate API server (adds complexity, K8s API is sufficient)

---

## Goals

1. **Direct K8s access**: Both dashboards query K8s API directly (like kubectl, k9s)
2. **Real-time updates**: Watch API for live changes (no polling daemon)
3. **Unified experience**: Web and TUI show same data, same shortcuts where applicable
4. **Fast queries**: Host-side SQLite cache for repeat lookups (optional, not required)
5. **Multi-cluster**: View and switch between dev/staging/prod clusters
6. **Keyboard-driven TUI**: k9s-style vim navigation for power users

---

## Non-Goals

- Separate API server (K8s API is our API)
- Background daemon (direct watches are sufficient)
- VM support (sunset)
- Database administration (use kubectl exec for that)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Host Machine                                    │
│                                                                             │
│  ┌─ Web Dashboard ───────────────────────────────────────────────────────┐   │
│  │  React + Vite app                                                     │   │
│  │  │                                                                    │   │
│  │  ├──► @kubernetes/client-node ──────► K8s API (clusters)              │   │
│  │  │                                   (direct, like kubectl)          │   │
│  │  │                                                                    │   │
│  │  └──► Optional: SQLite cache (~/.cache/fabrik/dashboard.db)          │   │
│  │         (speeds up repeat queries, not required)                      │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─ CLI TUI Dashboard ────────────────────────────────────────────────────┐   │
│  │  Ink (React for terminal)                                            │   │
│  │  │                                                                    │   │
│  │  ├──► @kubernetes/client-node ──────► K8s API (clusters)              │   │
│  │  │                                   (direct, like k9s)                │   │
│  │  │                                                                    │   │
│  │  └──► Optional: SQLite cache                                          │   │
│  │         (populated on-demand, speeds up TUI nav)                     │   │
│  │                                                                    │   │
│  │  Modes:                                                              │   │
│  │  ├── runs      → List all runs (multi-cluster table)                │   │
│  │  ├── run       → Detail view for selected run                       │   │
│  │  ├── logs      → Stream logs from pod (kubectl logs -f)            │   │
│  │  ├── specs     → List specs (from clusters + local)                 │   │
│  │  ├── dispatch  → Quick dispatch form (TUI wizard)                   │   │
│  │  └── cluster   → Cluster health (nodes, storage, events)            │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─ CLI Commands ─────────────────────────────────────────────────────────┐   │
│  │  fabrik dashboard                     → Launch TUI                   │   │
│  │  fabrik runs list                     → Direct K8s query             │   │
│  │  fabrik runs show --id <run-id>       → K8s API get                 │   │
│  │  fabrik runs watch                    → K8s watch API               │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            k3s Cluster(s)                                  │
│                                                                             │
│  ┌─ fabrik-system namespace ─────────────────────────────────────────────┐   │
│  │  ├─ fabrik-credentials Secret                                        │   │
│  │  ├─ fabrik-env-* Secrets (per-project)                               │   │
│  │  └─ (No API server needed - direct K8s access)                       │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─ fabrik-runs namespace ──────────────────────────────────────────────┐   │
│  │  ├─ Job/fabrik-* (with labels/annotations from Smithers)             │   │
│  │  ├─ Pod/fabrik-* (phase, task, progress in metadata)                 │   │
│  │  ├─ PVC/data-fabrik-* (persistent state)                              │   │
│  │  └─ Events (K8s events for job lifecycle)                            │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─ LAOS (in-cluster or external) ───────────────────────────────────────┐   │
│  │  Prometheus scrapes pod metrics                                        │   │
│  │  Loki aggregates logs from all runs                                   │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Requirements: Web Dashboard

### Access

```bash
# Option 1: Port-forward (dev/local)
kubectl port-forward -n fabrik-system svc/fabrik-dashboard 3000:3000
open http://localhost:3000

# Option 2: Ingress (production)
# Deployed with ingress, HTTPS, auth
```

### Views

| View | URL | Description |
|------|-----|-------------|
| Runs List | `/runs` | All jobs across clusters, filterable |
| Run Detail | `/runs/:id` | Phase, task, progress, logs, specs |
| Specs | `/specs` | Available specs, create new |
| Dispatch | `/dispatch` | Interview wizard → Job creation |
| Schedules | `/schedules` | CronJobs list |
| Cluster Health | `/admin` | Nodes, storage, events |

### Real-time Updates

Uses K8s Watch API (not polling):
```typescript
const watch = new Watch(kubeConfig);
const stream = watch.watch(
  '/apis/batch/v1/namespaces/fabrik-runs/jobs',
  {},
  (type, job) => {
    // type: ADDED, MODIFIED, DELETED
    updateUI(job);
  }
);
```

---

## Requirements: CLI TUI Dashboard

### Launch

```bash
fabrik dashboard                          # Connect to current context
fabrik dashboard --context dev-k3s       # Specific context
fabrik dashboard --all-contexts          # Multi-cluster view
```

### Navigation (k9s-style)

```
Key         Action
─────────────────────────────────────
?           Show help
:runs       Jump to runs view
g r         Go runs (alias)
:specs      Jump to specs view
g s         Go specs (alias)
:logs       Jump to logs view
g l         Go logs (alias)

j / ↓       Move down
k / ↑       Move up
h / ←       Go back
l / →       Select / detail
q           Quit current view
Ctrl+C      Force quit

/           Filter (live search)
:           Command palette
```

### Runs View (Default)

```
┌─ Fabrik Dashboard ───────────────────────────────────────────────┐
│ Context: [dev-k3s*] [staging] [prod]  (Tab to switch)          │
├──────────────────────────────────────────────────────────────────┤
│ NAME              │ STATUS   │ PHASE       │ TASK        │ AGE  │
├───────────────────┼──────────┼─────────────┼─────────────┼──────┤
│ 01jk7v8x...       │ running  │ implement   │ 16:impl     │ 5m   │
│ 01jk7v9y...       │ blocked  │ review      │ review-3    │ 12m  │
│ 01jk7vaz...       │ finished │ done        │ -           │ 1h   │
│                   │          │             │             │      │
├──────────────────────────────────────────────────────────────────┤
│ [Enter] Detail │ [l] Logs │ [c] Cancel │ [r] Resume │ [?] Help│
└──────────────────────────────────────────────────────────────────┘
```

**Columns**:
- NAME: Run ID (ULID, truncated)
- STATUS: running | blocked | finished | failed | pending (from label)
- PHASE: interview | implement | review | gate | done (from label)
- TASK: Current task from `fabrik.dev/task` label
- AGE: Job creation time

### Run Detail View

```
┌─ Run: 01jk7v8x... ──────────────────────────────────────────────┐
│ Context: dev-k3s │ Status: running │ Phase: implement            │
├──────────────────────────────────────────────────────────────────┤
│ Timeline:                                                        │
│  ✓ 1:impl    2m ago     ✓ 1:val    3m ago                       │
│  ✓ 2:impl    5m ago     ✓ 2:val    6m ago                       │
│  → 16:impl   now        ⏳ 16:val   pending                       │
│                                                                  │
│ Progress: 150/192 tasks (78%)                                   │
│ ████████████████████████████████████░░░░░░░░░░                  │
│                                                                  │
│ Pod: fabrik-01jk7v8x...-abcd                                     │
│ Attempt: 1 / Iteration: 0                                        │
│                                                                  │
│ Spec: feature-x.json                                             │
│ Project: myapp (dev environment)                                 │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ [l] Stream logs │ [c] Cancel │ [r] Resume │ [←] Back            │
└──────────────────────────────────────────────────────────────────┘
```

**Progress bar**: From `fabrik.dev/progress` annotation (JSON parsed).

### Logs View

```
┌─ Logs: 01jk7v8x... ─────────────────────────────────────────────┐
│ Pod: fabrik-01jk7v8x...-abcd │ Follow: ON │ Container: smithers│
├──────────────────────────────────────────────────────────────────┤
│ [00:00:00] → 16:impl (attempt 1, iteration 0)                     │
│ [00:00:45] ✓ 16:impl (attempt 1)                                 │
│ [00:00:46] → 16:val (attempt 1, iteration 0)                     │
│ [00:01:02] ✓ 16:val (attempt 1)                                  │
│ [00:01:03] → 16:impl (attempt 1, iteration 1)                    │
│ ...                                                              │
│                                                                  │
│ [00:05:30] Claude API rate limit hit, retrying in 60s...       │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ [f] Toggle follow │ [s] Search │ [g] Goto │ [t] Timestamps │ [←]  │
└──────────────────────────────────────────────────────────────────┘
```

**Implementation**: `kubectl logs -f` via `@kubernetes/client-node`:
```typescript
const logStream = await k8sApi.readNamespacedPodLog(
  podName,
  namespace,
  container,
  false, // follow
  true,  // timestamps
  undefined, // tailLines
  undefined, // pretty
  undefined, // previous
  undefined, // sinceSeconds
  undefined, // sinceTime
  true // follow as stream
);

// Stream to TUI
logStream.on('data', (chunk) => {
  appendToTui(chunk.toString());
});
```

### Dispatch Form (TUI)

```
┌─ Dispatch New Run ──────────────────────────────────────────────┐
│                                                                  │
│ Spec: [specs/feature.json    ] (Tab: autocomplete)              │
│ Todo: [specs/feature.todo.jso] (optional)                       │
│                                                                  │
│ Project: [myapp_____________] (validated live)                   │
│   ✓ Valid DNS-1123 ID                                          │
│                                                                  │
│ Environment: (●) dev  ( ) staging  ( ) prod                      │
│                                                                  │
│ Cluster: (●) dev-k3s  ( ) staging  ( ) prod                      │
│                                                                  │
│ Template: (●) coding  ( ) report  ( ) marketing                  │
│                                                                  │
│ Resources:                                                       │
│   CPU:    [2____] cores                                        │
│   Memory: [4____] Gi                                            │
│                                                                  │
│ [Enter] Dispatch  [Esc] Cancel                                   │
└──────────────────────────────────────────────────────────────────┘
```

**Project ID validation**:
- Live validation as user types
- Red/green indicator
- Error message: "Must be DNS-1123: lowercase alphanumeric + hyphens, max 63 chars"
- Examples: ✓ `myapp`, ✓ `my-app-123`, ✗ `MyApp`, ✗ `my_app`, ✗ `my.app`

### Cluster Health View

```
┌─ Cluster Health: dev-k3s ─────────────────────────────────────┐
│                                                                  │
│ Nodes: 3 │ CPU: 45% used │ Memory: 62% used │ Storage: 12GB/30GB│
│                                                                  │
│ Namespaces:                                                      │
│  fabrik-system: ✓ (credentials: 5 keys, envs: 12)                │
│  fabrik-runs:   ✓ (active: 3, completed today: 12)               │
│                                                                  │
│ Recent Events:                                                   │
│  2m ago  │ Normal  │ Job fabrik-01jk7... │ Completed           │
│  5m ago  │ Warning │ Pod fabrik-01jk8... │ ImagePullBackOff    │
│  12m ago │ Normal  │ Job fabrik-01jk9... │ Created              │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ [r] Refresh │ [e] Events │ [n] Nodes │ [←] Back                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

### Web Dashboard

| Component | Library | Purpose |
|-----------|---------|---------|
| Framework | React + Vite | UI components |
| Styling | Tailwind CSS 4 | Design system |
| Router | TanStack Router | Type-safe routing |
| Queries | TanStack Query | Server state management |
| K8s Client | `@kubernetes/client-node` | K8s API access |
| Build | Bun | Fast builds |

### CLI TUI Dashboard

| Component | Library | Purpose |
|-----------|---------|---------|
| Framework | Ink (React for terminals) | TUI rendering |
| State | Effect-TS | Business logic |
| Keyboard | Custom hooks (vim-style) | Navigation |
| Tables | Custom (k9s-style) | Resource lists |
| K8s Client | `@kubernetes/client-node` | K8s API access |
| Logs | `@kubernetes/client-node` (stream) | Real-time logs |

---

## Direct K8s Implementation

### No API Server, No Daemon

Like kubectl and k9s, we talk directly to K8s:

```typescript
// Shared K8s client for all interfaces
class FabrikK8sClient {
  private kubeConfig: KubeConfig;
  private coreApi: CoreV1Api;
  private batchApi: BatchV1Api;
  
  constructor() {
    this.kubeConfig = new KubeConfig();
    this.kubeConfig.loadFromDefault();  // ~/.kube/config
    this.coreApi = this.kubeConfig.makeApiClient(CoreV1Api);
    this.batchApi = this.kubeConfig.makeApiClient(BatchV1Api);
  }
  
  // List runs across all contexts
  async listRuns(contexts?: string[]): Promise<Run[]> {
    const runs: Run[] = [];
    const targets = contexts || this.getAllContexts();
    
    await Promise.all(targets.map(async (ctx) => {
      this.kubeConfig.setCurrentContext(ctx);
      const jobs = await this.batchApi.listNamespacedJob(
        'fabrik-runs',
        undefined, undefined, undefined, undefined,
        'fabrik.dev/managed-by=fabrik'
      );
      
      for (const job of jobs.body.items) {
        const runId = job.metadata?.labels?.['fabrik.dev/run-id'];
        if (!runId) continue;
        
        runs.push({
          id: runId,
          context: ctx,
          status: this.getStatus(job),
          phase: job.metadata?.labels?.['fabrik.dev/phase'] || 'unknown',
          task: job.metadata?.labels?.['fabrik.dev/task'] || 'unknown',
          progress: this.parseProgress(job),
          age: job.metadata?.creationTimestamp,
        });
      }
    }));
    
    return runs.sort((a, b) => b.age.localeCompare(a.age));
  }
  
  // Watch for real-time updates
  watchRuns(context: string, callback: (event: RunEvent) => void): () => void {
    this.kubeConfig.setCurrentContext(context);
    const watch = new Watch(this.kubeConfig);
    
    const req = watch.watch(
      '/apis/batch/v1/namespaces/fabrik-runs/jobs',
      { labelSelector: 'fabrik.dev/managed-by=fabrik' },
      (type, obj) => {
        callback({ type, run: this.parseJob(obj) });
      },
      (err) => console.error('Watch error:', err)
    );
    
    // Return abort function
    return () => req.then(r => r.abort());
  }
  
  // Stream logs
  async *streamLogs(
    context: string,
    runId: string,
    container: string = 'smithers'
  ): AsyncGenerator<string> {
    this.kubeConfig.setCurrentContext(context);
    const pod = await this.findPodForRun(runId);
    
    const stream = await this.coreApi.readNamespacedPodLog(
      pod.metadata!.name!,
      'fabrik-runs',
      container,
      true,  // follow
      true,  // timestamps
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true   // stream
    );
    
    for await (const chunk of stream) {
      yield chunk.toString();
    }
  }
  
  private getStatus(job: V1Job): RunStatus {
    if (job.status?.succeeded) return 'finished';
    if (job.status?.failed) return 'failed';
    if (job.status?.active) {
      const phase = job.metadata?.labels?.['fabrik.dev/phase'];
      return phase === 'gate' ? 'blocked' : 'running';
    }
    return 'pending';
  }
  
  private parseProgress(job: V1Job): Progress | undefined {
    const annotation = job.metadata?.annotations?.['fabrik.dev/progress'];
    if (!annotation) return undefined;
    try {
      return JSON.parse(annotation);
    } catch {
      return undefined;
    }
  }
}
```

### Optional Cache Layer

For TUI performance (not required):

```typescript
// Simple SQLite cache for fast repeat queries
// Not a daemon - just a local database
class RunCache {
  private db: Database;
  private ttlSeconds: number = 5;  // Very short TTL
  
  async get(runId: string): Promise<Run | null> {
    const row = this.db.query(
      'SELECT * FROM runs WHERE id = ? AND updated > ?',
      [runId, Date.now() - this.ttlSeconds * 1000]
    );
    return row || null;
  }
  
  async set(run: Run): Promise<void> {
    this.db.run(
      'INSERT OR REPLACE INTO runs (id, data, updated) VALUES (?, ?, ?)',
      [run.id, JSON.stringify(run), Date.now()]
    );
  }
  
  // Warm cache in background
  async warmCache(runs: Run[]): Promise<void> {
    for (const run of runs) {
      await this.set(run);
    }
  }
}
```

---

## Acceptance Criteria

### Web Dashboard

- [ ] Dashboard deploys as simple static site or container (not API server)
- [ ] Dashboard connects to K8s via kubeconfig (like kubectl)
- [ ] `/runs` shows all Jobs with real-time updates via K8s watch
- [ ] Run status shows phase, task, progress from labels/annotations
- [ ] `/runs/:id` streams logs in real-time
- [ ] `/dispatch` creates Job via K8s API (not separate API server)
- [ ] Project ID field validates live against DNS-1123 rules
- [ ] Invalid project IDs rejected with clear error message
- [ ] Multi-context support (dev/staging/prod in dropdown)

### CLI TUI Dashboard

- [ ] `fabrik dashboard` launches TUI in terminal
- [ ] TUI shows runs from all contexts (or current context)
- [ ] Vim-style navigation: j/k, h/l, g r/g s/g l
- [ ] Real-time updates via K8s watch (not polling)
- [ ] `l` key streams logs from selected run
- [ ] `c` key cancels job (kubectl delete job)
- [ ] `r` key resumes job (delete pod, Job recreates)
- [ ] Project ID validated in dispatch form (live feedback)
- [ ] Progress bar renders from `fabrik.dev/progress` annotation
- [ ] Works without cache (direct K8s), faster with cache

### Both

- [ ] No daemon process required
- [ ] No API server required
- [ ] Direct K8s API access like kubectl/k9s
- [ ] Optional SQLite cache for performance (not required)
- [ ] Multi-cluster support via kubeconfig contexts

---

## Debugging with kubectl/k9s

While Fabrik provides dashboards, sometimes you need direct K8s access.

**kubectl (Standard K8s CLI):**

```bash
# List fabrik jobs
kubectl get jobs -n fabrik-runs -l fabrik.dev/managed-by=fabrik

# Get run details
kubectl describe job -n fabrik-runs fabrik-01jk7v8x...

# Stream logs (what Fabrik TUI does)
kubectl logs -n fabrik-runs -l fabrik.dev/run-id=01jk7v8x... -f

# Execute into running pod
kubectl exec -n fabrik-runs -it fabrik-01jk7v8x...-abcd -- /bin/sh

# Check pod annotations (Smithers status)
kubectl get pod -n fabrik-runs fabrik-01jk7v8x...-abcd -o jsonpath='{.metadata.annotations}'

# Port-forward to debug
kubectl port-forward -n fabrik-runs pod/fabrik-01jk7v8x...-abcd 8080:8080
```

**k9s (Terminal UI for K8s):**

```bash
# Install k9s (if not already)
brew install k9s  # macOS
nix-shell -p k9s  # NixOS

# Launch (uses current kubeconfig context)
k9s -n fabrik-runs

# Key bindings in k9s:
# :jobs       → View jobs
# /fabrik     → Filter fabrik resources
# l           → Logs
# s           → Shell into pod
# d           → Describe resource
# Ctrl+C      → Quit
```

**When to use what:**

| Scenario | Tool | Why |
|----------|------|-----|
| Daily monitoring | `fabrik dashboard` | Unified view, progress bars |
| Quick check | `k9s` | Fast, familiar if you know K8s |
| Debug stuck pod | `kubectl exec` | Direct access to Smithers DB |
| Analyze failures | `kubectl describe` | Full event history |
| Custom queries | `kubectl + jq` | Arbitrary JSON processing |

---

## Assumptions

1. **kubeconfig**: `~/.kube/config` exists with valid contexts
2. **kubectl**: Available for fallback/debugging
3. **Permissions**: User has read access to fabrik-runs, read/write to fabrik-system
4. **K8s API**: Accessible from host (port-forward or direct)
5. **No daemon**: We query K8s directly (like kubectl)
6. **Context switching**: `kubectl config use-context` or TUI dropdown
7. **Project IDs**: Validated client-side before K8s API calls
8. **Watch API**: Available (works on k3s, EKS, GKE, etc.)
9. **Smithers**: Updates pod labels/annotations in real-time
10. **Storage**: Local SQLite cache optional, not required

---

## Schema

### kubeconfig Context Format

```yaml
# ~/.kube/config
apiVersion: v1
kind: Config
contexts:
  - name: dev-k3s
    context:
      cluster: dev-k3s
      user: dev-k3s-admin
      namespace: fabrik-runs  # Default for fabrik
  - name: prod
    context:
      cluster: prod-eks
      user: prod-admin
      namespace: fabrik-runs

current-context: dev-k3s
```

### Run Status from K8s

```typescript
interface RunStatus {
  // From Job metadata
  id: string;              // labels['fabrik.dev/run-id']
  context: string;         // kubeconfig context name
  
  // From Job status + labels
  status: 'pending' | 'running' | 'blocked' | 'finished' | 'failed';
  phase: 'interview' | 'implement' | 'review' | 'gate' | 'done' | 'unknown';
  task: string;            // labels['fabrik.dev/task']
  
  // From annotations
  progress?: {
    finished: number;
    total: number;
  };  // JSON.parse(annotations['fabrik.dev/progress'])
  
  // From metadata
  age: string;             // creationTimestamp
  updatedAt?: string;       // annotations['fabrik.dev/updated']
}
```

---

## Glossary

- **TUI**: Terminal User Interface (text-based UI)
- **Ink**: React for terminals
- **Watch API**: K8s streaming API for real-time changes
- **Context**: K8s cluster + credentials + namespace from kubeconfig
- **Label**: K8s metadata for selection (status, phase, task)
- **Annotation**: K8s metadata for arbitrary data (progress JSON)
- **Port-forward**: kubectl command to expose cluster service locally
- **Cache**: Optional local SQLite for faster repeat queries

---

## Migration from VM (Notes)

- VM dashboards (ralph-1, limactl) → `fabrik dashboard` TUI
- `fabrik runs show --vm ralph-1` → `fabrik runs show --context dev-k3s`
- Host DB sync issues → No more host DB, query K8s directly
- SSH/limactl shell → `kubectl exec` or `fabrik run attach`

---

## Changelog

- **v2.0.0** (2026-02-16):
  - Removed daemon concept entirely (direct K8s access like kubectl)
  - Removed API server (K8s API is sufficient)
  - Removed all VM references
  - Simplified to direct `@kubernetes/client-node` usage
  - Added k9s-style TUI specification
  - Made cache optional (performance boost, not required)
  - Aligned with kubectl/k9s patterns

- **v1.1.0** (2026-02-16):
  - Added CLI TUI dashboard alongside web
  - First draft of daemon architecture (since removed)

- **v1.0.0** (2026-02-14):
  - Initial web dashboard specification
