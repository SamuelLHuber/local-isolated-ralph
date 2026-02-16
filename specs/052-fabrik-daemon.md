# Spec: Fabrik Daemon (k3s-native)

> Background control plane for real-time fabrik job monitoring and host-cluster sync

**Status**: draft  
**Version**: 1.0.0  
**Last Updated**: 2026-02-16  
**Depends On**: `050-k3s-orchestrator`, `051-k3s-orchestrator-dashboard`  
**Replaces**: VM-based reconciliation (ralph-1, limactl, host DB sync issues)

---

## Identity

- **ID**: `052-fabrik-daemon`
- **Filename**: `specs/052-fabrik-daemon.json`
- **Branch prefix**: `fabrik-daemon-`
- **Commit trailer**: `spec: fabrik-daemon`

---

## Title

**Background control plane for real-time fabrik job monitoring and host-cluster sync**

---

## Context: Why Replace VMs with k3s-native

### VM Architecture Problems (Being Sunset)

The previous VM-based approach (`ralph-1` via limactl/libvirt) had fundamental issues:

1. **Dual Database Problem**: Host DB (stale cache) vs VM DB (truth) got out of sync
2. **Heartbeat Fragility**: Writer dies, main process continues, status lies
3. **SSH/Exec Overhead**: Every query requires limactl shell or SSH
4. **State Repair Nightmare**: Stuck tasks, crashed processes, manual SQL fixes
5. **No Native Observability**: LAOS runs on host, VMs send logs over network
6. **Resource Waste**: Full OS per VM, disk images, boot times

### k3s-native Solution

Moving to k3s in-cluster execution solves these:

```
┌─ Before: VM Architecture ──────────────────────────────────────┐
│  Host (macOS)                                                  │
│  ├── fabrik CLI                                                │
│  ├── ralph.db (stale, needs reconcile)                        │
│  └── LAOS (logs from VM over network)                          │
│       │                                                        │
│       ▼ SSH / limactl shell                                   │
│  ┌─ ralph-1 VM ─────────────────────────────────────────────┐│
│  │  ┌─ Smithers ─┐  ┌─ SQLite ─┐  ┌─ heartbeat ─┐            ││
│  │  │  workflow │→│   truth   │→│  (fragile)   │→┌Host DB┐││
│  │  └────────────┘  └───────────┘  └──────────────┘  │(stale)│││
│  └───────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘

┌─ After: k3s-native Architecture ───────────────────────────────┐
│  Host (any OS)                                                 │
│  ├── fabrik CLI                                                │
│  ├── fabrik-daemon (watches K8s, maintains local cache)       │
│  └── LAOS (irrelevant - in-cluster now)                       │
│                                                                │
│  Kubeconfig ──► k3s Cluster ────────────────────────────────────│
│  ┌─ fabrik-system ─────────────────────────────────────────┐   │
│  │  ┌─ fabrik-api-server ─┐  ┌─ fabrik-daemon ─┐          │   │
│  │  │   (control plane)   │  │  (in-cluster)   │          │   │
│  │  └─────────────────────┘  └──────────────────┘          │   │
│  │           │                     │                        │   │
│  │           ▼                     ▼ Watch                  │   │
│  │  ┌─ fabrik-runs ───────────────────────────────────────┐│   │
│  │  │  Jobs, CronJobs, Pods, PVCs (Smithers DB inside)   ││   │
│  │  │           ↑                                         ││   │
│  │  │  ┌─ Prometheus/Loki ─┐  ┌─ Grafana (LAOS) ─┐      ││   │
│  │  │  │  (metrics/logs)  │  │  (in-cluster)     │      ││   │
│  │  │  └──────────────────┘  └────────────────────┘      ││   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**Key insight**: With k3s, the cluster IS the computer. No split-brain between host and VM.

---

## Goals

1. **Maintain persistent K8s watches** for all fabrik resources (Jobs, CronJobs, Pods, PVCs)
2. **Stream real-time events** to CLI dashboard and web dashboard via Unix socket / WebSocket
3. **Mirror cluster state to host** for offline queries and fast local access (SQLite cache)
4. **Collect in-cluster metrics** via Prometheus/Loki (no more network roundtrips)
5. **Enable CLI TUI dashboard** (`fabrik dashboard`) with <100ms local response times
6. **Provide unified kubeconfig management** - daemon handles multiple clusters
7. **Support human gate alerting** via in-cluster AlertManager (not host-side desktop notifications)

---

## Non-Goals

- **VM support** — limactl, ralph-1, libvirt are sunset; k3s is the only target
- **Host-side LAOS** — observability stack runs in-cluster only
- **SSH/Exec-based queries** — all communication via K8s API (REST / watches)
- **Dual control planes** — no more host DB vs cluster truth divergence

---

## Architecture

### Daemon as K8s Controller

The daemon follows the **Kubernetes controller pattern**:

```typescript
// Controller loop
class FabrikDaemon {
  private kubeconfigs: Map<string, k8s.KubeConfig>; // cluster name → config
  private informers: Map<string, k8s.Informer[]>;  // cluster → resource informers
  private eventBus: EventEmitter;                  // local pub/sub
  private hostCache: SQLiteDatabase;              // ~/.cache/fabrik/daemon/cache.db
  
  async start() {
    // 1. Load all kubeconfigs
    for (const [name, path] of this.getKubeconfigs()) {
      const kc = new k8s.KubeConfig();
      kc.loadFromFile(path);
      this.kubeconfigs.set(name, kc);
      
      // 2. Start informers for each cluster
      this.informers.set(name, [
        this.watchJobs(kc, name),
        this.watchCronJobs(kc, name),
        this.watchPods(kc, name),
        this.watchPVCs(kc, name),
      ]);
    }
    
    // 3. Start Unix socket server for local clients
    this.startSocketServer();
    
    // 4. Start Prometheus metrics exporter (optional, for host metrics)
    this.startMetricsServer();
  }
  
  // K8s informer callbacks
  onJobAdded(job: k8s.V1Job, cluster: string) {
    const run = this.parseJobToRun(job);
    this.hostCache.upsertRun(run);
    this.eventBus.emit('run:added', { cluster, run });
  }
  
  onPodUpdated(pod: k8s.V1Pod, cluster: string) {
    const status = this.extractSmithersStatus(pod);
    this.hostCache.updateRunStatus(pod.labels['fabrik.dev/run-id'], status);
    this.eventBus.emit('run:updated', { cluster, runId, status });
  }
}
```

### Data Flow

```
K8s Cluster (k3s)
├── Job/CronJob/Pod changes
└──► K8s API Server
     └──► Daemon Informer (watch stream)
          ├──► Host SQLite Cache (async write)
          └──► Event Bus (immediate broadcast)
               ├──► CLI TUI (Unix socket)
               ├──► Web Dashboard (WebSocket via API server)
               └──► fabrik CLI (sync query)
```

### Host Cache Schema

```sql
-- ~/.cache/fabrik/daemon/cache.db
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,           -- ULID
  cluster TEXT NOT NULL,             -- 'dev-k3s', 'prod'
  namespace TEXT NOT NULL DEFAULT 'fabrik-runs',
  status TEXT CHECK(status IN ('pending', 'running', 'blocked', 'finished', 'failed', 'cancelled')),
  current_task TEXT,                 -- e.g., '16:impl'
  task_status TEXT,                  -- 'in-progress', 'finished', 'failed'
  progress_finished INTEGER,
  progress_total INTEGER,
  spec_id TEXT,
  template TEXT,
  created_at TEXT,                   -- ISO 8601
  updated_at TEXT,
  last_sync_at TEXT,                 -- daemon timestamp
  -- Source of truth: cluster; this cache is eventually consistent
);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(run_id),
  event_type TEXT CHECK(event_type IN ('status_changed', 'task_completed', 'blocked', 'log_line')),
  payload TEXT,                      -- JSON
  cluster_timestamp TEXT,            -- from K8s
  local_timestamp TEXT               -- when daemon received
);

CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_cluster ON runs(cluster);
CREATE INDEX idx_events_run_id ON run_events(run_id, cluster_timestamp);
```

---

## Requirements: Daemon Behavior

### 1. K8s Resource Watching

The daemon maintains **persistent watches** (not polling) on these resources per cluster:

| Resource | Watch For | Action |
|----------|-----------|--------|
| `Job` | Add, Update, Delete | Update run list, track completion |
| `CronJob` | Add, Update, Delete | Track schedules, next run time |
| `Pod` | Phase changes, container status | Extract Smithers heartbeat, task progress |
| `PVC` | Bound, Capacity | Track storage usage per run |
| `Event` (K8s Events) | Warnings, Errors | Log to host cache for debugging |

### 2. Smithers Status Extraction

From Pod status, the daemon extracts:

```typescript
interface SmithersPodStatus {
  runId: string;              // From label fabrik.dev/run-id
  phase: 'discover' | 'implement' | 'validate' | 'review' | 'human-gate' | 'done';
  currentTask?: string;       // e.g., "16:impl"
  taskAttempt: number;
  progressFinished: number;
  progressTotal: number;
  heartbeatAge: number;       // seconds since last heartbeat
  // Extracted from pod annotations or sidecar container
}

// Methods:
// A) Annotation-based (pod writes status to own annotation)
// B) Sidecar container (smithers-sidecar exposes HTTP /status)
// C) Exec into pod (kubectl exec cat /workspace/.smithers/status.json) - fallback only
```

**Preferred**: Annotation-based (no exec needed, K8s-native).

### 3. Event Streaming

Daemon provides **local Unix socket** for clients:

```typescript
// Client (TUI dashboard) connects
const socket = createConnection('/tmp/fabrik-daemon.sock');

// Subscribe to events
socket.write(JSON.stringify({
  action: 'subscribe',
  clusters: ['dev-k3s', 'prod'],  // or ['*'] for all
  filter: { status: ['running', 'blocked'] },
  includeHistory: 100  // last 100 events immediately
}));

// Receive events (JSON lines)
socket.on('data', (line) => {
  const event = JSON.parse(line);
  // { type: 'run:updated', runId: '01jk7v8x...', cluster: 'dev-k3s', status: 'blocked', ... }
});
```

### 4. Host Cache Sync

Async SQLite writes (non-blocking):

```typescript
// Informer callback (fast - just queue)
onPodUpdated(pod) {
  const status = this.extractStatus(pod);
  this.writeQueue.push({ type: 'upsert', table: 'runs', data: status });
}

// Background writer (batched)
async flushQueue() {
  const batch = this.writeQueue.splice(0, 100);
  await this.db.transaction(async (trx) => {
    for (const op of batch) {
      await trx[op.type](op.table, op.data);
    }
  });
}
```

### 5. Multi-Cluster Support

Daemon manages multiple kubeconfigs:

```yaml
# ~/.config/fabrik/daemon/clusters.yaml
clusters:
  - name: dev-k3s
    kubeconfig: ~/.kube/dev
    defaultNamespace: fabrik-runs
    priority: 1  # for ordering in UI
    
  - name: prod
    kubeconfig: ~/.kube/prod
    defaultNamespace: fabrik-runs
    priority: 2
    
  - name: local
    kubeconfig: /etc/rancher/k3s/k3s.yaml
    defaultNamespace: fabrik-runs
    priority: 0
```

Auto-discovery:
- Scan `~/.kube/config` for contexts with `fabrik` label
- Add clusters from `clusters.yaml`
- CLI can add: `fabrik daemon add-cluster --name staging --kubeconfig ...`

---

## Requirements: CLI Integration

### Daemon Commands

```bash
# Start daemon (auto-starts on first dashboard/watch use)
fabrik daemon start [--config ~/.config/fabrik/daemon/config.yaml]

# Status
curl --unix-socket /tmp/fabrik-daemon.sock http://localhost/status
# Or: fabrik daemon status

# View logs
fabrik daemon logs [--follow]

# Stop
fabrik daemon stop

# Manage clusters
fabrik daemon clusters list
fabrik daemon clusters add --name prod --kubeconfig ~/.kube/prod
fabrik daemon clusters remove prod

# Query cache directly (when daemon is running)
fabrik daemon query "SELECT * FROM runs WHERE status='blocked'"
```

### Dashboard Integration

```bash
# TUI dashboard connects to daemon
fabrik dashboard
# -- Uses Unix socket for real-time events
# -- Falls back to cache queries if daemon not running
# -- Can start daemon automatically if configured
```

### CLI Show/List Commands

```bash
# These now query daemon cache (fast, <10ms)
# Daemon syncs from K8s in background
fabrik runs list --cluster dev-k3s
fabrik runs show --id 01jk7v8x...

# Force fresh query (bypass cache)
fabrik runs show --id 01jk7v8x... --fresh
```

---

## Requirements: In-Cluster Observability

### LAOS Integration

The daemon sends its own metrics to in-cluster LAOS:

```typescript
// Daemon self-metrics
interface DaemonMetrics {
  // Sync lag
  'fabrik_daemon_sync_lag_seconds': Gauge;  // time since last K8s event processed
  
  // Cache stats
  'fabrik_daemon_cache_size': Gauge;  // number of runs in host cache
  'fabrik_daemon_cache_hit_ratio': Gauge;
  
  // Event stats
  'fabrik_daemon_events_total': Counter;  // total events processed
  'fabrik_daemon_events_dropped': Counter; // dropped due to backpressure
  
  // Connection health
  'fabrik_daemon_cluster_connected': Gauge;  // 1 if watching, 0 if disconnected
}
```

### Alerting (In-Cluster)

Human gates and errors alert via in-cluster AlertManager, NOT host-side:

```yaml
# AlertManager route for fabrik
routes:
  - match:
      alertname: FabrikHumanGateBlocked
    receiver: 'fabrik-pagerduty'
    continue: true
  - match:
      alertname: FabrikRunFailed
    receiver: 'fabrik-zulip'
    
receivers:
  - name: 'fabrik-pagerduty'
    pagerduty_configs:
      - service_key: '...'
        description: 'Run {{ $labels.run_id }} blocked on human gate'
        
  - name: 'fabrik-zulip'
    webhook_configs:
      - url: 'https://zulip.example.com/api/v1/messages'
        title: 'Fabrik Alert'
```

---

## Deployment

### Daemon as Host Process

```bash
# Install daemon as systemd service (Linux) or launchd (macOS)
fabrik daemon install-service

# Or run manually
fabrik daemon start

# Auto-starts with OS
systemctl enable fabrik-daemon  # Linux
launchctl load ~/Library/LaunchAgents/fabrik.daemon.plist  # macOS
```

### Daemon in Cluster (Future)

For remote access without host daemon:

```yaml
# Deploy daemon in fabrik-system namespace
# Exposes WebSocket for remote CLI connection
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fabrik-daemon-remote
  namespace: fabrik-system
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: daemon
        image: ghcr.io/dtechvision/fabrik-daemon:latest
        env:
        - name: MODE
          value: "remote"  # vs "host" mode
        - name: WEBSOCKET_PORT
          value: "8080"
        volumeMounts:
        - name: kubeconfig
          mountPath: /etc/fabrik/kubeconfig
          readOnly: true
```

Then host CLI connects via WebSocket:
```bash
fabrik runs list --remote wss://fabrik.example.com/daemon
```

---

## Migration from VM to k3s

### Sunset Plan

| Phase | Action | Timeline |
|-------|--------|----------|
| 1 | Freeze VM features | Now |
| 2 | Complete k3s-orchestrator spec | 1 week |
| 3 | Complete daemon spec (this) | 1 week |
| 4 | Implement daemon | 2 weeks |
| 5 | VM deprecation warnings | During daemon dev |
| 6 | Remove VM code | After k3s stable |

### Code Removal

Files to delete when VM support is removed:
- `src/fabrik/dispatch.ts` (or strip VM logic)
- `src/fabrik/vm.ts`, `src/fabrik/vm-utils.ts`
- `nix/modules/ralph.nix` (or simplify)
- `smithers-runner/` (moves to container image)
- `scripts/create-ralph.sh`, `setup-base-vm.sh`
- `docs/SETUP-MACOS.md`, `docs/SETUP-LINUX.md` (replaced with k3s setup)

---

## Acceptance Criteria

- [ ] Daemon maintains persistent K8s watches (not polling) for Jobs/Pods/PVCs
- [ ] Daemon updates host SQLite cache within 1 second of K8s event
- [ ] Daemon broadcasts events to Unix socket subscribers in <10ms
- [ ] `fabrik dashboard` connects to daemon and shows real-time updates
- [ ] `fabrik runs list` queries daemon cache (<10ms response)
- [ ] `fabrik runs show` extracts Smithers status from Pod annotations
- [ ] Daemon handles multiple clusters (dev, prod, local k3s)
- [ ] Daemon auto-discovers clusters from ~/.kube/config
- [ ] Daemon metrics exposed to in-cluster Prometheus
- [ ] Daemon logs to in-cluster Loki (not host files)
- [ ] No limactl/libvirt code paths in daemon (pure K8s)
- [ ] Daemon works with k3d (local dev) and production k3s
- [ ] Host cache works offline (shows last known state)
- [ ] Daemon reconnects automatically if K8s API connection drops
- [ ] `fabrik daemon install-service` works on macOS and Linux

---

## Assumptions

- k3s (or any K8s) is the only execution target — no VM fallback
- LAOS runs in-cluster only — host does not run observability stack
- User has kubectl and valid kubeconfig(s)
- Daemon has read access to all fabrik namespaces (fabrik-system, fabrik-runs)
- Daemon does NOT need write access to K8s (read-only watches)
- Smithers pods write status to their own annotations (or sidecar pattern)
- Unix sockets work on macOS (Darwin) and Linux
- Windows support is future/non-goal (WSL2 can use Linux daemon)

---

## Architecture Comparison

| Aspect | VM (Deprecated) | Daemon (This Spec) |
|--------|----------------|-------------------|
| **Source of truth** | SQLite in VM | SQLite in PVC (cluster) |
| **Query mechanism** | limactl shell / SSH | K8s API watch |
| **Latency** | 500ms-2s per query | <10ms (local cache) |
| **Offline support** | None (VM must be running) | Host cache shows last state |
| **Observability** | LAOS on host (network hops) | LAOS in-cluster (local) |
| **Multi-cluster** | Painful (multiple VMs) | Easy (multiple kubeconfigs) |
| **Resource overhead** | Full OS per VM | Shared k3s node |
| **State repair** | Manual SQL via limactl | K8s-native (delete/recreate Job) |
| **Split-brain** | Host DB vs VM DB | Single cluster truth |

---

## Relation to Other Specs

| Spec | Relation |
|------|----------|
| `050-k3s-orchestrator` | Daemon watches resources created by this spec |
| `051-dashboard` | Daemon provides data to TUI and web dashboard |
| `ralph.md` | Daemon replaces the "Ralph loop" with K8s-native controller |
| `COMPOUND-ENGINEERING.md` | Daemon enables compound work via in-cluster metrics |

---

## Summary

The fabrik daemon sunsets the VM architecture by:

1. **Moving execution to k3s** (Pods, Jobs, CronJobs)
2. **Watching K8s directly** (no more limactl, SSH, dual databases)
3. **Caching locally for speed** (SQLite mirror, <10ms queries)
4. **Streaming events** (Unix socket for TUI dashboard)
5. **Using in-cluster LAOS** (no host-side observability)

**Result**: Simpler mental model, no split-brain, faster queries, better observability.
