# Spec: Run Health Controller

> Unified, stateless health supervision for Fabrik runs — monitors, triages, and heals automatically with full observability

**Status**: draft  
**Version**: 2.0.0 (replaces 054-cron-monitoring)  
**Last Updated**: 2026-04-12  
**Depends On**: `051-k3s-orchestrator`

---

## Changelog

- **v2.0.0** (2026-04-12): Complete rewrite. Unified supervisor controller replacing separate cron-monitoring. Stateless architecture with annotation-based state machine. Added automated healing, forensics integration, and full OTel observability.
- **v1.0.0** (2026-02-16): Initial cron-monitoring spec (missed runs, duration alerts only).

---

## Identity

**What**: A stateless Kubernetes controller that actively supervises all Fabrik runs (Jobs/Pods). It detects anomalies (crashes, stuck processes), performs automated forensic triage using `@.agents/skills/fabrik-smithers-run-forensics`, attempts self-healing for transient failures, and deterministically gives up (marks as `failed`) when healing is impossible.

**Why**: 
- CronJobs and long-running Jobs fail silently or get stuck.
- Manual intervention (`fabrik run resume`) should not be required for transient issues (OOM, node pressure, temporary network blips).
- Forensic analysis (PVC state, Smithers DB, git branch health) should be automated and observable.
- Deterministic failure handling: either healed automatically or marked failed with clear reason.

**Not**:
- A replacement for Kubernetes scheduling (CronJob/Job controllers remain primary).
- A sidecar container inside Run pods (runs as separate Deployment in `fabrik-system`).
- A persistent state database (all state lives in Kubernetes annotations; controller is stateless).
- A tool for complex workflow orchestration (no Job chains or dependencies).

---

## Goals

1. **Stateless supervision**: Controller holds no persistent state; all runtime state lives in K8s annotations.
2. **Automated triage**: Forensic analysis triggered automatically on anomalies via the forensics skill.
3. **Self-healing**: Idempotent healing actions (pod restart, resume trigger) for transient failures.
4. **Deterministic give-up**: Clear conditions when to stop trying and mark run as `failed`.
5. **Dual trigger model**: Event-driven (watch) for fast response + periodic sweep (15min) for safety.
6. **Full observability**: Complete OTel instrumentation (traces, metrics, logs) for every triage decision.
7. **No leader election**: Idempotent reconciliation allows multiple replicas without coordination.

---

## Design Principles

- **K8s is the source of truth**: All health state lives in annotations (`fabrik.sh/health`, `fabrik.sh/triage-*`).
- **Stateless controllers**: Controller pods can restart, scale, or duplicate without data loss or conflicts.
- **Idempotent healing**: Every healing action must be safe to execute multiple times with the same result.
- **Conservative failure**: When uncertain, give up and mark failed (fail-safe) rather than retry indefinitely.
- **Immutable images respected**: Healing never modifies Job spec or image; only pod deletion or resume with same digest.
- **Full trace correlation**: Controller spans link to Smithers spans via `fabrik.run_id` for end-to-end debugging.

---

## Architecture

```
┌─ Fabrik Run Health Controller ──────────────────────────────────────────────┐
│                                                                             │
│  ┌─ Deployment: fabrik-health-controller (2 replicas, stateless) ────────┐   │
│  │  ┌─ Container ──────────────────────────────────────────────────────┐   │   │
│  │  │  ├─ Watch API: Jobs/Pods in fabrik-runs namespace               │   │   │
│  │  │  ├─ Sweep Loop: Every 15min (backup for missed events)         │   │   │
│  │  │  ├─ Reconcile: Annotation-based state machine                   │   │   │
│  │  │  ├─ Forensics: Skill execution (kubectl, PVC, DB, git)        │   │   │
│  │  │  └─ Healing: Idempotent actions (delete pod, trigger resume)   │   │   │
│  │  └──────────────────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌─ Observability (LAOS / OTel) ───────────────────────────────────────────────┐   │
│  │  ├─ Traces: Every triage as OTel trace (trigger → forensics → healing)      │   │
│  │  ├─ Metrics: Prometheus metrics endpoint (/metrics)                           │   │
│  │  └─ Logs: Structured JSON to stdout → Loki                                  │   │
│  └───────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌─ Interaction with Run Pods ───────────────────────────────────────────────────┐   │
│  │                                                                             │   │
│  │  ┌─ Pod Annotations (Source of Truth) ──────────────────────────────────┐  │   │
│  │  │  fabrik.sh/health: "triaging|healing|failed|healthy"                   │  │   │
│  │  │  fabrik.sh/health-since: "2026-04-12T10:00:00Z"                        │  │   │
│  │  │  fabrik.sh/triage-attempt: "2"                                         │  │   │
│  │  │  fabrik.sh/triage-action: "delete-pod"                                 │  │   │
│  │  │  fabrik.sh/triage-reason: "OOMKilled twice, attempting resume"         │  │   │
│  │  │  fabrik.sh/trace-id: "abc123..."  (for correlation)                   │  │   │
│  │  └──────────────────────────────────────────────────────────────────────────┘  │   │
│  │                                                                                 │   │
│  │  ┌─ Smithers Updates ──────────────────────────────────────────────────────┐  │   │
│  │  │  fabrik.sh/last-progress: "2026-04-12T10:05:00Z" (set by Smithers)       │  │   │
│  │  │  fabrik.sh/phase: "implement"                                          │  │   │
│  │  └──────────────────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## State Machine (Annotations Schema)

All state lives in **Pod/Job annotations**. Controller is stateless; it only reads/writes these annotations.

### Core State Annotation

```yaml
metadata:
  annotations:
    # Current health state
    fabrik.sh/health: "healthy"  # healthy | triaging | healing | failed
    fabrik.sh/health-since: "2026-04-12T10:00:00Z"  # ISO 8601
    
    # Progress timestamp (updated by Smithers, read by controller)
    fabrik.sh/last-progress: "2026-04-12T10:05:00Z"
    
    # Triage details (set during triaging/healing)
    fabrik.sh/triage-attempt: "2"  # Counter, 1-3
    fabrik.sh/triage-action: "delete-pod"  # Last attempted action
    fabrik.sh/triage-reason: "OOMKilled twice, attempting resume"
    
    # Trace correlation (for OTel)
    fabrik.sh/trace-id: "abc123..."
    fabrik.sh/triage-span-id: "xyz789..."
    
    # Final failure details (when health=failed)
    fabrik.sh/failure-category: "code_error"  # transient|code_error|infra|unknown
    fabrik.sh/failure-message: "Repository branch deleted during run"
```

### State Transitions

```
┌──────────┐   Anomaly detected    ┌──────────┐   Forensics OK     ┌──────────┐
│          │ ────────────────────> │          │ ────────────────>  │          │
│  Healthy │  (Crash/Stuck/       │ Triaging │  (Reparable)       │ Healing  │
│          │   No progress)        │          │                    │          │
└──────────┘                     └──────────┘                    └────┬─────┘
      │                                    │                          │
      │                                    │ Irreparable              │ Success
      │                                    │ (Code error,             │
      │                                    │  Repo gone)              ▼
      │                                    ▼                    ┌──────────┐
      │                           ┌──────────┐                  │          │
      └────────────────────────── │  Failed  │ <────────────────│          │
         (Give up: max retries    │  (Final) │                  └──────────┘
          or irreparable)         │          │
                                  └──────────┘
```

**Transition Rules** (implemented by controller):

1. **Healthy → Triaging**
   - Trigger: Pod in `CrashLoopBackOff`, OR
   - Trigger: `(now - last-progress) > stuck-threshold` (default: 30min)
   - Guard: Only if `health` is not already `triaging|healing|failed`
   - Action: Set `health=triaging`, `health-since=now`, increment `triage-attempt`

2. **Triaging → Healing**
   - Guard: Forensics skill returns `reparable=true`
   - Timeout: If forensics takes >2min, transition to `failed` (unknown state)
   - Action: Set `health=healing`, select `triage-action`, execute action

3. **Triaging → Failed**
   - Guard: Forensics returns `reparable=false` (e.g., code error, missing branch)
   - Action: Set `health=failed`, `failure-category`, emit K8s Event

4. **Healing → Healthy**
   - Guard: Pod Running AND `last-progress` updated within last 5min
   - Action: Set `health=healthy`, clear `triage-*` annotations (keep trace-id)

5. **Healing → Failed**
   - Guard: `triage-attempt > max-attempts` (default: 3), OR
   - Guard: `(now - health-since) > healing-timeout` (default: 30min)
   - Action: Set `health=failed`, `failure-category=transient_exhausted`

---

## Forensics Integration

The controller executes the `@.agents/skills/fabrik-smithers-run-forensics` logic for every `triaging` state.

### Forensics Evidence Gathering

```typescript
// Pseudo-code for forensics span
async function runForensics(runId: string, pod: V1Pod): Promise<ForensicsResult> {
  const span = tracer.startSpan('forensics', { parent: triageSpan });
  
  // 1. K8s state
  const podStatus = await kubectl.getPod(pod.name);
  const jobStatus = await kubectl.getJob(runId);
  span.setAttributes({ 'k8s.pod.phase': podStatus.phase, 'k8s.container.restarts': 3 });
  
  // 2. PVC / Smithers DB analysis (if accessible)
  const dbState = await readSQLiteViaKubectlCopy(
    `/workspace/.smithers/state.db`,
    `SELECT * FROM tasks ORDER BY seq DESC LIMIT 5`
  );
  span.setAttributes({ 'smithers.last_task': dbState[0]?.id, 'smithers.progress': 0.75 });
  
  // 3. Git remote check (via API, not pod exec)
  const repoUrl = pod.metadata.annotations['fabrik.sh/repo-url'];
  const bookmark = pod.metadata.annotations['fabrik.sh/bookmark'];
  const gitStatus = await checkRemoteBranch(repoUrl, bookmark);
  span.setAttributes({ 'git.branch.exists': gitStatus.exists });
  
  // 4. Classification
  const category = classify(podStatus, dbState, gitStatus);
  // Categories: 'transient', 'stuck_but_progress', 'code_error', 'infra_issue', 'unknown'
  
  span.setAttributes({ 'forensics.category': category, 'forensics.reparable': isReparable(category) });
  span.end();
  
  return { category, details: { podStatus, dbState, gitStatus } };
}
```

### Classification Categories

| Category | Description | Reparable |
|----------|-------------|-----------|
| `transient` | OOMKilled once, network blip, node pressure | Yes (delete pod/resume) |
| `stuck_but_progress` | Smithers hanging, but DB shows progress timestamp moving slowly | Yes (pod restart) |
| `code_error` | Syntax error in workflow.tsx, missing dependency | No (requires code change) |
| `infra_issue` | Node NotReady, ImagePullBackOff on system image | Yes (reschedule/resume) |
| `unknown` | Cannot determine cause | No (conservative: fail) |

---

## Healing Actions (Idempotent)

All healing actions must be **safe to retry** (idempotent).

### Action A: Delete Pod (Pod Restart)

```yaml
action: "delete-pod"
when: CrashLoopBackOff, OOMKilled, stuck container
idempotent: true  # Deleting non-existent pod = no-op
implementation: kubectl delete pod <pod-name> -n fabrik-runs
result: Job controller creates new pod, PVC reattaches, Smithers resumes from SQLite
```

### Action B: Trigger Resume

```yaml
action: "trigger-resume"
when: Pod repeatedly fails, or stuck with corrupt SQLite state
idempotent: true  # Resume checks image digest equality
implementation: |
  # Controller patches Job annotation to trigger CLI-like resume
  # Or calls internal resume logic (delete pod + ensure same image digest)
  
  # Key: Verify image digest is unchanged before allowing resume
  currentDigest: pod.spec.containers[0].image.split('@')[1]
  originalDigest: job.metadata.annotations['fabrik.sh/original-image-digest']
  
  if currentDigest == originalDigest:
    delete pod  # Job recreates with same spec = resume
  else:
    mark failed (digest mismatch - immutable image rule violated)
```

### Action C: Signal Smithers (Future)

```yaml
action: "signal-smithers"
when: Smithers stuck but responsive to signals
idempotent: true
implementation: kubectl exec <pod> -- kill -USR1 1  # Graceful reload
note: Optional, requires Smithers to handle signals
```

### Action D: Annotation Reset

```yaml
action: "reset-annotations"
when: Smithers running but forgot to update progress (bug)
idempotent: true
implementation: Patch pod to refresh 'fabrik.sh/health-check' timestamp
note: Forces health check cycle without pod disruption
```

### Retry Budget per Run

- Max 3 attempts total across all actions
- Actions can be mixed (e.g., delete-pod → delete-pod → trigger-resume)
- Each attempt increments `fabrik.sh/triage-attempt`
- After 3 attempts: automatic transition to `failed`

---

## Give-up Conditions (Failed State)

The controller **deterministically gives up** when:

1. **Irreparable classification**: Forensics returns `code_error`, `unknown`, or `repo_gone`
2. **Retry budget exhausted**: `triage-attempt > 3`
3. **Healing timeout**: Run in `healing` state for >30min without progress
4. **Age limit**: Run exists for >23h (approaching `activeDeadlineSeconds` of 24h)
5. **Image digest mismatch**: Resume would require different image (violates immutability)

When giving up:
- Set `fabrik.sh/health: failed`
- Set `fabrik.sh/failure-category` and `fabrik.sh/failure-message`
- Emit K8s Event with reason `RunHealthFailed`
- Create OTel span with status `ERROR`
- **Do not delete Job/Pod** (preserve for debugging; cleanup via TTL)

---

## OTel Observability

### Trace Structure

Every triage cycle creates a trace with correlation to Smithers:

```
Trace ID: (generated or continued from Smithers if available)
├── Span: health-controller.trigger [kind: consumer]
│   └── Attributes: trigger.type="watch|sweep", fabrik.run_id, k8s.pod.name
│
├── Span: health-controller.forensics [kind: internal]
│   ├── Events: 
│   │   - "pvc_check_start"
│   │   - "db_read_complete" (duration: 1.2s)
│   │   - "git_remote_check" (branch_exists: true)
│   └── Attributes: forensics.category="transient", forensics.duration_ms=4500
│
├── Span: health-controller.healing [kind: internal]
│   ├── Events:
│   │   - "action_selected" (action: "delete-pod")
│   │   - "kubectl_executed"
│   │   - "pod_recreated"
│   └── Attributes: healing.action, healing.attempt, healing.success=true
│
└── Span: health-controller.state-transition [kind: internal]
    └── Attributes: health.old="triaging", health.new="healing", triage.reason
```

**Correlation**: All spans include `fabrik.run_id` attribute for linking to Smithers traces.

### Metrics (Prometheus)

Exposed on `:8080/metrics`:

```prometheus
# Counters
fabrik_health_triages_total{result="healed|failed|healthy"} 1543
fabrik_health_healing_actions_total{action="delete_pod|resume",status="success|failure"} 892
fabrik_health_failures_total{category="code_error|transient_exhausted|infra|unknown"} 127

# Gauges (current snapshot)
fabrik_health_runs_in_state{state="triaging"} 12
fabrik_health_runs_in_state{state="healing"} 5
fabrik_health_runs_in_state{state="failed"} 3

# Histograms
fabrik_health_triage_duration_seconds_bucket{le="10"} 450
fabrik_health_forensics_duration_seconds_bucket{le="30"} 380
fabrik_health_healing_duration_seconds_bucket{le="60"} 290

# Derived
fabrik_health_time_since_progress_seconds{run_id="01jk..."} 1800  # For alerting
```

### Logs (Structured JSON)

```json
{
  "timestamp": "2026-04-12T10:05:00Z",
  "level": "info",
  "message": "Triage state transition",
  "trace_id": "abc123...",
  "span_id": "def456...",
  "service_name": "fabrik-health-controller",
  "attributes": {
    "fabrik.run_id": "01jk7v8x...",
    "fabrik.project": "myapp",
    "fabrik.health.old": "healthy",
    "fabrik.health.new": "triaging",
    "fabrik.triage.reason": "no_progress_30min",
    "k8s.namespace": "fabrik-runs",
    "k8s.pod.name": "fabrik-01jk...-abcd",
    "k8s.node.name": "worker-3",
    "forensics.category": "transient",
    "healing.action": "delete-pod"
  }
}
```

---

## Configuration

ConfigMap `fabrik-health-controller-config`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fabrik-health-controller-config
  namespace: fabrik-system
data:
  # Trigger sensitivity
  stuck-threshold-minutes: "30"
  crashloop-threshold: "2"
  sweep-interval-minutes: "15"
  
  # Healing limits
  max-triage-attempts: "3"
  healing-timeout-minutes: "30"
  forensics-timeout-seconds: "120"
  
  # Actions enable/disable (for gradual rollout)
  action-delete-pod-enabled: "true"
  action-trigger-resume-enabled: "true"
  action-signal-enabled: "false"
  
  # OTel
  otel-collector-endpoint: "http://otel-collector.fabrik-system.svc:4317"
  otel-protocol: "grpc"
  trace-sampling-rate-healthy: "0.01"  # 1% for healthy checks
  trace-sampling-rate-anomaly: "1.0"   # 100% for issues
  
  # Logging
  log-level: "info"
  log-format: "json"
```

---

## CLI Integration

```bash
# View current health state (reads annotations)
fabrik runs show --id 01jk7v8x...
# Extended output:
# Health: healing (since 2026-04-12T10:00:00Z)
# Triage Attempt: 2/3
# Last Action: delete-pod (success)
# Reason: OOMKilled twice, attempting resume
# Trace ID: abc123... (link to Grafana)

# List runs by health state
fabrik runs list --health=failed
fabrik runs list --health=triaging,healing

# Manual force-triage (admin override)
fabrik health triage --id 01jk7v8x... --reason="manual-check"

# Reset health state (admin cleanup)
fabrik health reset --id 01jk7v8x...  # Clears to healthy, preserves trace-id
```

---

## RBAC (Minimal Permissions)

ServiceAccount: `fabrik-health-controller` in `fabrik-system`

```yaml
# Read access to target resources
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: fabrik-runs
  name: fabrik-health-observer
rules:
- apiGroups: [""]
  resources: ["pods", "events"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "watch"]

# Write access only for healing actions
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: fabrik-runs
  name: fabrik-health-healer
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["delete"]  # Only idempotent delete
- apiGroups: [""]
  resources: ["pods", "jobs"]
  verbs: ["patch"]   # For annotations only
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create"]  # For audit events
```

---

## Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fabrik-health-controller
  namespace: fabrik-system
spec:
  replicas: 2  # Stateless, no leader election needed
  selector:
    matchLabels:
      app: fabrik-health-controller
  template:
    metadata:
      labels:
        app: fabrik-health-controller
      annotations:
        # Force restart on config change
        checksum/config: "{{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}"
    spec:
      serviceAccountName: fabrik-health-controller
      containers:
      - name: controller
        image: ghcr.io/fabrik/health-controller:latest
        env:
        - name: OTEL_COLLECTOR_ENDPOINT
          valueFrom:
            configMapKeyRef:
              name: fabrik-health-controller-config
              key: otel-collector-endpoint
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
```

---

## Interaction with Cron Monitoring

The health controller **extends** cron monitoring rather than replacing all aspects:

| Aspect | Cron-Only (054 legacy) | Health Controller (New) |
|--------|------------------------|-------------------------|
| Missed schedules | Alert only (K8s CronJob missed creating Job) | Alert + annotate reason |
| Duration exceeded | Alert only | Alert + triage + heal if transient |
| Crash/Stuck | Not covered | Full triage + healing |
| Resume logic | Manual CLI only | Automated with forensics |

**CronJobs that never start** (missed schedule) skip the healing flow — the controller only handles Jobs/Pods that exist but are unhealthy.

---

## Acceptance Criteria

- [ ] Controller runs as Deployment with 2 replicas, no leader election needed
- [ ] Watch API receives events within 5s of pod status change
- [ ] Sweep loop runs every 15min and processes all Running pods
- [ ] State transitions follow annotation schema (`fabrik.sh/health`)
- [ ] Forensics skill executes for every triage within 2min timeout
- [ ] Healing actions are idempotent (safe to retry 3x)
- [ ] Give-up after 3 attempts or 30min healing time
- [ ] Failed runs have `failure-category` and `failure-message` annotations
- [ ] OTel traces include all spans (trigger, forensics, healing)
- [ ] Prometheus metrics expose all counters, gauges, histograms
- [ ] Structured JSON logs contain trace_id and span_id
- [ ] CLI `fabrik runs show` displays health state from annotations
- [ ] Image digest immutability enforced (resume only with same digest)
- [ ] RBAC allows only pod delete + patch (no job spec modification)
- [ ] Controller survives restart without data loss (stateless)

---

## Assumptions

1. **K8s API access**: Controller has valid service account token for watch/list/patch/delete
2. **PVC read access**: Can read Smithers SQLite via `kubectl cp` or shared storage class
3. **Git access**: Can reach git remotes (GitHub/GitLab) for branch/bookmark checks
4. **OTel collector**: Running in `fabrik-system` or reachable externally
5. **Smithers progress**: Smithers updates `fabrik.sh/last-progress` annotation regularly (every task)
6. **Idempotency**: `kubectl delete pod` and resume with same digest are truly idempotent
7. **Node resources**: Controller is lightweight (100m CPU, 128Mi memory sufficient)

---

## Glossary

- **Stateless**: Controller holds no persistent state between reconciliations
- **Idempotent**: Action can be executed multiple times with same end result
- **Forensics**: Automated diagnostic analysis of run state (PVC, DB, git)
- **Give-up**: Deterministic decision to stop healing and mark as failed
- **Sweep**: Periodic (15min) full scan of all runs as safety net
- **Trace correlation**: Linking controller spans to Smithers spans via shared trace_id
