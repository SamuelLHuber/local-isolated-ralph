# Spec: k3s-orchestrator

> Kubernetes-native fabrik execution — Jobs, CronJobs, and resource management

**Status**: draft  
**Version**: 1.1.0  
**Last Updated**: 2026-02-16  
**Supersedes**: All VM-based approaches

---

## Identity

**What**: Native Kubernetes execution using k3s (lightweight K8s distribution). Fabrik runs as Jobs/CronJobs with proper resource management, secrets, and observability.

**Why k3s**: 
- Simpler than full K8s (single binary, SQLite etcd, lower resource overhead)
- Production-grade (CNCF certified, Rancher-backed)
- Single-node or multi-node
- Built-in storage (Longhorn available), ingress (Traefik), service mesh

**Not**: VM orchestration, Docker Compose, or Nomad. Pure K8s native.

---

## Goals

1. **K8s-native execution**: Fabrik workloads run as Kubernetes Jobs with proper lifecycle management
2. **Resource governance**: CPU/memory limits, quotas, priority classes prevent runaway jobs
3. **Secret management**: Per-project environment via K8s Secrets, rotated automatically
4. **Persistent storage**: Smithers SQLite state in PVCs, backed up via Longhorn
5. **Multi-cluster support**: Dev, staging, prod clusters with unified tooling
6. **Observability**: LAOS (in-cluster or external) receives all metrics/logs

---

## Non-Goals

- VM lifecycle management (sunset)
- Docker Swarm / Nomad / other orchestrators
- Serverless (Knative, AWS Lambda) - may add later
- Multi-tenancy at cluster level (v1 assumes single org per cluster)

---

## Requirements

### 1. Cluster Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                               k3s Cluster                                    │
│                                                                             │
│  ┌─ Namespace: fabrik-system ────────────────────────────────────────────┐   │
│  │  ┌─ fabrik-api-server (Deployment) ────────────────────────────────┐   │   │
│  │  │  ┌─ Pod ────────────────────────────────────────────────────┐ │   │   │
│  │  │  │  ├─ Container: api-server (Bun + Effect)                │ │   │   │
│  │  │  │  └─ Port: 8080 (gRPC + HTTP)                             │ │   │   │
│  │  │  └────────────────────────────────────────────────────────────┘ │   │   │
│  │  └─────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                          │   │
│  │  ┌─ fabrik-credentials (Secret) ───────────────────────────────────┐   │   │
│  │  │  ANTHROPIC_API_KEY_1, _2, _3...                                    │   │   │
│  │  │  OPENAI_API_KEY_1, _2...                                           │   │   │
│  │  │  GITHUB_TOKEN                                                      │   │   │
│  │  │  (Rotated automatically, consumed by Jobs)                        │   │   │
│  │  └─────────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                          │   │
│  │  ┌─ fabrik-env-<project>-<env> (Secrets, multiple) ──────────────────┐   │   │
│  │  │  Project-specific environment variables                            │   │   │
│  │  │  LAOS_LOKI_URL, SENTRY_DSN, CUSTOM_API_KEYS...                    │   │   │
│  │  └─────────────────────────────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ┌─ Namespace: fabrik-runs ────────────────────────────────────────────────┐   │
│  │                                                                          │   │
│  │  ┌─ Job: fabrik-<run-id> ──────────────────────────────────────────────┐   │   │
│  │  │  ┌─ Pod ──────────────────────────────────────────────────────────┐ │   │   │
│  │  │  │  ├─ init-container: git-clone (get smithers + code)             │ │   │   │
│  │  │  │  ├─ init-container: smithers-init (setup DB)                   │ │   │   │
│  │  │  │  └─ container: smithers (main execution)                       │ │   │   │
│  │  │  │     ├─ PVC mount: /workspace/.smithers (SQLite state)         │ │   │   │
│  │  │  │     ├─ PVC mount: /workspace/project (git repo)               │ │   │   │
│  │  │  │     ├─ Secret mount: /etc/fabrik/credentials (API keys)       │ │   │   │
│  │  │  │     ├─ Secret mount: /etc/fabrik/env (project env)            │ │   │   │
│  │  │  │     └─ Container: sidecar (optional - status reporter)        │ │   │   │
│  │  │  └─────────────────────────────────────────────────────────────────┘ │   │   │
│  │  │                                                                      │   │   │
│  │  │  ┌─ PVC: data-fabrik-<run-id> ────────────────────────────────────┐ │   │   │
│  │  │  │  ReadWriteOnce, 10GB default                                   │ │   │   │
│  │  │  │  Retained for 7 days post-completion                            │ │   │   │
│  │  │  └─────────────────────────────────────────────────────────────────┘ │   │   │
│  │  └──────────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                              │   │
│  │  ┌─ CronJob: fabrik-schedule-<id> ───────────────────────────────────────┐   │   │
│  │  │  Spec: Same as Job, triggered by schedule                             │   │   │
│  │  │  Creates Job on trigger, labeled with schedule-id                    │   │   │
│  │  └───────────────────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌─ LAOS (in-cluster or external) ───────────────────────────────────────────┐   │
│  │  ├─ Prometheus (metrics)                                                  │   │
│  │  ├─ Loki (logs)                                                           │   │
│  │  └─ Grafana (dashboards)                                                  │   │
│  └───────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 2. Resource Model

**Namespaces**:
- `fabrik-system`: Control plane, credentials, API server
- `fabrik-runs`: Job execution, isolated from control plane

**Project ID Rules** (DNS-1123 label strict):
- Max 63 characters
- Lowercase alphanumeric + hyphens only (`[a-z0-9-]`)
- Must start/end with alphanumeric
- Regex: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
- **Enforced**: API server rejects invalid IDs with HTTP 400 + clear error

**Storage**:
- PVC per run: `data-fabrik-<run-id>` (10GB default)
- StorageClass: `local-path` (k3s default) or `longhorn` (HA)
- Retention: 7 days after completion, then deleted
- Manual `fabrik run retain --id <run-id> --days 30` extends

**Resource Limits**:
- Default: 2 CPU, 4Gi memory per job
- Templates can override: `--template high-cpu` → 8 CPU, 16Gi
- ResourceQuota on fabrik-runs: 100 CPU, 200Gi (prevents cluster exhaustion)

### 3. Pod Specification (Simplified)

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: fabrik-01jk7v8x...
  namespace: fabrik-runs
  labels:
    fabrik.dev/run-id: "01jk7v8x..."
    fabrik.dev/spec-id: "feature-x"
    fabrik.dev/project: "myapp"
    fabrik.dev/phase: "implement"  # Updated by Smithers
    fabrik.dev/status: "running"     # Updated by Smithers
    fabrik.dev/task: "16:impl"       # Updated by Smithers
  annotations:
    fabrik.dev/progress: '{"finished":150,"total":192}'  # JSON
    fabrik.dev/started: "2026-02-16T20:00:00Z"
    fabrik.dev/spec-url: "https://github.com/.../specs/feature-x.json"
spec:
  ttlSecondsAfterFinished: 604800  # 7 days
  activeDeadlineSeconds: 86400     # 24 hour max
  backoffLimit: 0                   # Don't retry (Smithers handles)
  template:
    metadata:
      labels:
        fabrik.dev/run-id: "01jk7v8x..."
    spec:
      restartPolicy: Never
      initContainers:
        - name: git-clone
          image: alpine/git
          command: ['sh', '-c', 'git clone --depth 1 $REPO_URL /workspace/project && cp -r /opt/smithers /workspace/']
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: smithers-base
              mountPath: /opt/smithers  # Pre-built Nix image layer
          env:
            - name: REPO_URL
              valueFrom:
                configMapKeyRef:
                  name: fabrik-run-config
                  key: repo-url
        - name: smithers-init
          image: fabrik-smithers:latest  # Nix-built base
          command: ['bun', 'run', '/workspace/smithers/scripts/init.ts']
          volumeMounts:
            - name: smithers-data
              mountPath: /workspace/.smithers
            - name: workspace
              mountPath: /workspace/project
      containers:
        - name: smithers
          image: fabrik-smithers:latest
          command: ['bun', 'run', '/workspace/smithers/src/smithers.ts']
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
          envFrom:
            - secretRef:
                name: fabrik-credentials  # API keys
            - secretRef:
                name: fabrik-env-myapp-dev  # Project env
          volumeMounts:
            - name: smithers-data
              mountPath: /workspace/.smithers  # PVC - survives restarts
            - name: workspace
              mountPath: /workspace/project      # EmptyDir + git repo
          # Status reporting via annotations
          env:
            - name: KUBERNETES_POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: KUBERNETES_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: FABRIK_RUN_ID
              value: "01jk7v8x..."
      volumes:
        - name: smithers-data
          persistentVolumeClaim:
            claimName: data-fabrik-01jk7v8x...
        - name: workspace
          emptyDir:
            sizeLimit: 5Gi
        - name: smithers-base
          csi:  # Or pre-built into image
            driver: image.csi.k8s.io
```

### 4. Smithers Status Reporting

**Method: Direct Annotation Updates** (K8s-native, no sidecar needed)

Smithers uses the Downward API to get pod name/namespace, then calls K8s API directly:

```typescript
// Inside Smithers (already has K8s service account token)
class K8sStatusReporter {
  async updateStatus(
    phase: 'interview' | 'implement' | 'review' | 'gate' | 'done',
    currentTask: string,
    progress: { finished: number; total: number },
    attempt: number,
    iteration: number
  ) {
    const podName = process.env.KUBERNETES_POD_NAME!;
    const namespace = process.env.KUBERNETES_NAMESPACE!;
    
    await this.k8sApi.patchNamespacedPod(
      podName,
      namespace,
      {
        metadata: {
          labels: {
            'fabrik.dev/phase': phase,
            'fabrik.dev/status': this.getStatusFromPhase(phase),
            'fabrik.dev/task': currentTask,
          },
          annotations: {
            'fabrik.dev/progress': JSON.stringify(progress),
            'fabrik.dev/updated': new Date().toISOString(),
            'fabrik.dev/attempt': String(attempt),
            'fabrik.dev/iteration': String(iteration),
          },
        },
      },
      undefined,  // pretty
      undefined,  // dryRun
      undefined,  // fieldManager
      undefined,  // fieldValidation
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  }
  
  private getStatusFromPhase(phase: string): string {
    if (phase === 'done') return 'finished';
    if (phase === 'gate') return 'blocked';
    return 'running';
  }
}
```

**Benefits**:
- No sidecar container (simpler pod spec)
- No HTTP endpoints to expose
- Standard K8s API, works with any tooling
- Annotations visible in `kubectl get pods -o yaml`

### 5. Image Distribution Strategy

**Two-tier approach**:

```
┌─ Base Image (fabrik-smithers:latest) ──────────────────────────────┐
│  Built via Nix, distributed via GHCR                                │
│  ├─ Bun runtime                                                     │
│  ├─ Smithers core (typescript, dependencies)                       │
│  ├─ Common tools: git, jq, sqlite3, curl                            │
│  └─ Templates (coding, report, marketing base files)                │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─ Project Layer (init container) ──────────────────────────────────┐
│  Fetched at runtime via git clone                                   │
│  ├─ User repository code                                            │
│  ├─ Project-specific spec files                                     │
│  └─ Custom templates (override base)                                │
└─────────────────────────────────────────────────────────────────────┘
```

**Build process**:
```bash
# Build base image (CI)
nix build .#fabrik-smithers-container
docker load < result
docker tag fabrik-smithers:latest ghcr.io/fabrik/smithers:1.2.3
docker push ghcr.io/fabrik/smithers:1.2.3

# At runtime, init container:
git clone --depth 1 https://github.com/user/repo.git /workspace/project
```

**Versioning**:
- Base image: `ghcr.io/fabrik/smithers:v1.2.3` and `:latest`
- Templates: Versioned with smithers (coding@1.2.3)
- CLI can pin: `--smithers-version 1.2.3` or use `:latest`

### 6. LAOS Integration (Flexible)

**Configuration** (via env vars from Secret):

```yaml
# fabrik-env-<project>-<env> Secret
data:
  LAOS_PROMETHEUS_URL: "http://prometheus.monitoring.svc:9090"  # in-cluster
  LAOS_LOKI_URL: "http://loki.monitoring.svc:3100"               # in-cluster
  # OR external:
  # LAOS_PROMETHEUS_URL: "https://prometheus.company.com"
  # LOKI_API_KEY: "..."  # If external requires auth
```

**Multi-cluster, single LAOS**:
```
┌─ Cluster A (dev) ──┐    ┌─ Cluster B (prod) ──┐
│ Fabrik Jobs ──────┼────┼─► External LAOS     │
│                   │    │  (shared)            │
│ LAOS agents (opt) │    │                      │
└───────────────────┘    └──────────────────────┘
         │                        │
         └──────────┬─────────────┘
                    ▼
           ┌─ External LAOS ───┐
           │ Grafana Cloud     │
           │ Datadog           │
           │ Self-hosted stack │
           └───────────────────┘
```

**Default**: In-cluster LAOS in `monitoring` namespace (deployed by `fabrik cluster init`)

---

## CLI Commands

```bash
# Cluster lifecycle
fabrik cluster init [name]              # Create local k3d/k3s cluster
fabrik cluster init --provider eks      # AWS EKS
fabrik cluster init --provider gke      # GCP GKE
fabrik cluster init --existing        # Use existing kubeconfig
fabrik cluster list                     # Show configured clusters
fabrik cluster use <name>               # Set default context
fabrik cluster delete <name>            # Tear down

# Execution
fabrik run --spec specs/feature.json \
           --project myapp \
           --env dev \
           --cluster dev-k3s            # Dispatch to specific cluster

fabrik run resume --id 01jk7v8x...      # Resume (deletes stuck pod, Job recreates)

# Status (direct K8s queries)
fabrik runs list                        # All runs across clusters
fabrik runs list --cluster dev-k3s      # Specific cluster
fabrik runs show --id 01jk7v8x...       # Detailed status

# Cancellation
fabrik run cancel --id 01jk7v8x...      # kubectl delete job

# Scheduling
fabrik schedule create --spec specs/nightly.json --cron "0 2 * * *"

# Environment
fabrik env set --project myapp --env dev --from-file .env
fabrik env validate --project myapp --env dev

# Admin
fabrik doctor                           # Check cluster health
fabrik doctor --fix                     # Auto-fix common issues
```

---

## Direct K8s Access (Like kubectl)

No daemon. CLI uses `@kubernetes/client-node` directly:

```typescript
// CLI/TUI queries K8s API like kubectl
class FabrikK8sClient {
  private k8sApi: CoreV1Api;
  private batchApi: BatchV1Api;
  
  async getRunStatus(runId: string): Promise<RunStatus> {
    // Query all clusters in parallel
    const clusters = this.getConfiguredClusters();
    
    for (const cluster of clusters) {
      const jobs = await this.batchApi.listNamespacedJob(
        'fabrik-runs',
        undefined,  // pretty
        undefined,  // allowWatchBookmarks
        undefined,  // continue
        undefined,  // fieldSelector
        `fabrik.dev/run-id=${runId}`  // labelSelector
      );
      
      if (jobs.body.items.length > 0) {
        const job = jobs.body.items[0];
        const pod = await this.getPodForJob(job);
        
        return {
          id: runId,
          status: this.extractStatus(pod),
          phase: pod.metadata?.labels?.['fabrik.dev/phase'] || 'unknown',
          task: pod.metadata?.labels?.['fabrik.dev/task'] || 'unknown',
          progress: JSON.parse(pod.metadata?.annotations?.['fabrik.dev/progress'] || '{}'),
          cluster: cluster.name,
        };
      }
    }
    
    throw new Error(`Run ${runId} not found in any cluster`);
  }
  
  async *watchRuns(cluster: Cluster): AsyncGenerator<RunEvent> {
    // K8s watch API - efficient streaming
    const watch = new Watch(this.k8sConfig);
    
    yield* watch.watch(
      '/apis/batch/v1/namespaces/fabrik-runs/jobs',
      { labelSelector: 'fabrik.dev/managed-by=fabrik' },
      (type, obj) => ({ type, job: obj })
    );
  }
}
```

**Caching layer** (optional, for TUI performance):
```typescript
// Host-side SQLite for fast repeat queries
// Populated on-demand, not a daemon - just a cache
class RunCache {
  private db: Database;
  
  async getStatus(runId: string): Promise<RunStatus | null> {
    // Check cache first (<10ms)
    const cached = this.db.query("SELECT * FROM runs WHERE id = ?", [runId]);
    if (cached && !this.isStale(cached.updated_at)) {
      return cached;
    }
    
    // Cache miss or stale - query K8s
    const fresh = await k8sClient.getRunStatus(runId);
    this.db.upsert(fresh);
    return fresh;
  }
}
```

---

## Acceptance Criteria

- [ ] `fabrik cluster init` creates working k3s cluster with fabrik-system and fabrik-runs namespaces
- [ ] `fabrik run --spec x.json` creates Job that completes successfully
- [ ] Job pods show correct labels: `fabrik.dev/phase`, `fabrik.dev/task`, `fabrik.dev/status`
- [ ] Job pods show correct annotations: `fabrik.dev/progress` as JSON
- [ ] Smithers updates pod labels/annotations in real-time (every task transition)
- [ ] `fabrik runs list` queries K8s directly, returns all runs across configured clusters
- [ ] `fabrik runs show --id <run-id>` returns current phase, task, progress from pod labels
- [ ] `fabrik run cancel --id <run-id>` deletes Job, cascading to pod
- [ ] `fabrik run resume --id <run-id>` deletes stuck pod, Job recreates it (Smithers resume)
- [ ] PVC persists across pod restarts (Job deletes pod, keeps PVC)
- [ ] `fabrik env set --project myapp --env dev` creates Secret `fabrik-env-myapp-dev`
- [ ] Secrets are mounted as files in `/etc/fabrik/env/` and injected as env vars
- [ ] `--project` IDs validated against DNS-1123 (max 63 chars, lowercase alphanumeric + hyphens)
- [ ] Invalid project IDs rejected with clear error: "Project ID must be DNS-1123 compliant: lowercase alphanumeric + hyphens, max 63 chars"
- [ ] Base image `ghcr.io/fabrik/smithers:latest` pulls successfully
- [ ] Git clone init container retrieves user code
- [ ] LAOS receives metrics/logs when configured (in-cluster or external)
- [ ] Multiple clusters can report to same external LAOS
- [ ] `fabrik doctor` reports cluster health: nodes, storage, secrets, LAOS connectivity
- [ ] CronJob creates Jobs on schedule
- [ ] Resource limits enforced (jobs killed if memory > limit)
- [ ] 24-hour activeDeadlineSeconds enforced (long-running jobs killed)
- [ ] PVCs deleted 7 days after Job completion (configurable)

---

## Assumptions

1. **k3s installed**: `k3s`, `k3d`, or cloud K8s access available
2. **kubeconfig**: `~/.kube/config` exists and points to valid cluster
3. **kubectl**: Available in PATH (used by CLI as fallback)
4. **GitHub access**: Can clone repos (token in fabrik-credentials)
5. **Smithers version**: Base image version pinned or `latest`
6. **Storage**: Cluster has StorageClass (local-path or Longhorn)
7. **Networking**: Pods can reach GitHub, LAOS endpoints, LLM APIs
8. **Permissions**: User has cluster-admin or fabrik-system/fabrik-runs RBAC
9. **Multi-cluster**: kubeconfig contexts for dev/prod, switched via `fabrik cluster use`
10. **Project IDs**: User provides valid DNS-1123 IDs (enforced by API)

---

## Schema

### Project ID Validation

```typescript
// Strict DNS-1123 label validation
const PROJECT_ID_REGEX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_PROJECT_ID_LENGTH = 63;

function validateProjectId(id: string): void {
  if (id.length > MAX_PROJECT_ID_LENGTH) {
    throw new Error(
      `Project ID "${id}" too long: ${id.length} chars, max ${MAX_PROJECT_ID_LENGTH}`
    );
  }
  if (!PROJECT_ID_REGEX.test(id)) {
    throw new Error(
      `Project ID "${id}" invalid. Must match DNS-1123: ` +
      `lowercase alphanumeric + hyphens, start/end with alphanumeric. ` +
      `Examples: "myapp", "my-app-123", "fabrik-ci"`
    );
  }
}
```

### Run ID Format

- ULID (Universally Unique Lexicographically Sortable Identifier)
- 26 characters: `01JK7V8X...`
- Used in: Job name (`fabrik-${runId}`), PVC name (`data-fabrik-${runId}`), labels

### Environment Secret Schema

```yaml
# fabrik-env-<project>-<env>
apiVersion: v1
kind: Secret
metadata:
  name: fabrik-env-myapp-dev
  namespace: fabrik-system
type: Opaque
stringData:
  # Required
  ANTHROPIC_API_KEY: "sk-ant-..."
  
  # Optional - LAOS
  LAOS_PROMETHEUS_URL: "http://prometheus:9090"
  LAOS_LOKI_URL: "http://loki:3100"
  
  # Project-specific
  DATABASE_URL: "postgres://..."
  API_BASE_URL: "https://api.example.com"
```

---

## Glossary

- **Job**: K8s batch/v1 Job - runs pod to completion
- **CronJob**: Scheduled Job creation
- **PVC**: PersistentVolumeClaim - survives pod restarts
- **Secret**: K8s secret for credentials/env vars
- **Annotation**: K8s metadata (not selector-friendly, arbitrary data)
- **Label**: K8s metadata (selector-friendly, constrained values)
- **Namespace**: Resource isolation boundary
- **ULID**: Run ID format, sortable unique ID
- **LAOS**: Observability stack (Prometheus/Loki/Grafana)
- **Init Container**: Runs before main container (git clone, setup)
- **Sidecar**: Additional container in pod (not used - prefer annotations)

---

## Changelog

- **v1.1.0** (2026-02-16): 
  - Removed VM references entirely
  - Simplified to direct K8s API (no daemon)
  - Added strict Project ID validation rules
  - Documented annotation-based status reporting
  - Clarified image distribution (Nix base + git clone)
  - Made LAOS flexible (in-cluster or external)
