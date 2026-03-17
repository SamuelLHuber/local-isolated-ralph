# Spec: k3s-orchestrator

> Kubernetes-native fabrik execution — Jobs, CronJobs, and resource management

**Status**: draft  
**Version**: 1.2.0  
**Last Updated**: 2026-02-16  
**Supersedes**: All VM-based approaches

---

## Changelog

- **v1.2.0** (2026-02-16): Added resilience (resume without progress loss), K8s native cleanup, alerting thresholds
- **v1.1.0** (2026-02-16): Initial k3s-native spec (Jobs, PVCs, Secrets, annotations)

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
5. **Multi-cluster support**: Dev, staging, prod clusters with unified tooling (e.g. LAOS stack)
6. **Observability**: LAOS (in-cluster or external) receives all metrics/logs

---

## Design Principles

- **K8s is the source of truth**: Runtime state comes from K8s Jobs/CronJobs, not a separate scheduler.
- **One execution model**: All runs are Jobs or CronJobs, no alternative orchestrators.
- **Direct K8s API**: CLI/TUI/Web talk to the K8s API, no daemon or extra API server.
- **Minimal persistence**: Only derived data (analytics, cron health history, cost cache) is stored outside K8s.
- **Single local DB**: If local persistence is required, use a single SQLite DB file with multiple tables.
- **No cache unless required**: Avoid optional caches unless they materially improve performance.
- **Single metadata schema**: Labels and annotations are the canonical run metadata for all tools.
- **Explicit health contracts**: Healthy/degraded/unhealthy states are defined once and reused everywhere.
- **No custom schedulers**: Scheduling is exclusively K8s Jobs/CronJobs.
- **Immutable images**: Jobs must use image digests or pinned tags to avoid drift.
- **Resume consistency**: Resume must use the same image digest as the original run.

---

## Shared Metadata Schema

All fabrik Jobs/CronJobs must include these labels/annotations. Other specs and tools must read from these keys.

**Required labels**:
- `fabrik.sh/run-id`
- `fabrik.sh/spec`
- `fabrik.sh/project`
- `fabrik.sh/phase` (e.g., `plan`, `run`, `review`, `complete`)

**Required annotations**:
- `fabrik.sh/status` (JSON: phase, current_task, attempt, progress)
- `fabrik.sh/started-at` (ISO 8601)
- `fabrik.sh/finished-at` (ISO 8601, when complete)
- `fabrik.sh/outcome` (`succeeded`, `failed`, `cancelled`)

**Optional annotations**:
- `fabrik.sh/model`
- `fabrik.sh/cost-usd`
- `fabrik.sh/tokens-input`
- `fabrik.sh/tokens-output`
- `fabrik.sh/progress` (JSON summary if not embedded in status)

---

## Image Pinning

- Jobs must use immutable image references (digest or pinned tag).
- Resume uses the exact same image digest as the original run.
- Image updates require a new run (do not mutate existing Jobs).

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
- Implementation: PVCs are owner-referenced to their Job so Job TTL GC removes them.
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
    fabrik.sh/run-id: "01jk7v8x..."
    fabrik.sh/spec-id: "feature-x"
    fabrik.sh/project: "myapp"
    fabrik.sh/phase: "implement"  # Updated by Smithers
    fabrik.sh/status: "running"     # Updated by Smithers
    fabrik.sh/task: "16:impl"       # Updated by Smithers
  annotations:
    fabrik.sh/progress: '{"finished":150,"total":192}'  # JSON
    fabrik.sh/started: "2026-02-16T20:00:00Z"
    fabrik.sh/spec-url: "https://github.com/.../specs/feature-x.json"
spec:
  ttlSecondsAfterFinished: 604800  # 7 days
  activeDeadlineSeconds: 86400     # 24 hour max
  backoffLimit: 1                   # Allow one controller recreation so resume can delete the active pod
  template:
    metadata:
      labels:
        fabrik.sh/run-id: "01jk7v8x..."
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
            'fabrik.sh/phase': phase,
            'fabrik.sh/status': this.getStatusFromPhase(phase),
            'fabrik.sh/task': currentTask,
          },
          annotations: {
            'fabrik.sh/progress': JSON.stringify(progress),
            'fabrik.sh/updated': new Date().toISOString(),
            'fabrik.sh/attempt': String(attempt),
            'fabrik.sh/iteration': String(iteration),
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
fabrik env set --project myapp --env dev DATABASE_URL=postgres://...
fabrik env ls --project myapp --env dev
fabrik env pull --project myapp --env dev .env.local
fabrik env run --project myapp --env dev -- npm test
fabrik env diff --project myapp --from dev --to prod
fabrik env promote --project myapp --from dev --to staging
fabrik env validate --project myapp --env dev

# Admin
fabrik doctor                           # Check cluster health
fabrik doctor --fix                     # Auto-fix common issues
```

### Environment Management Model

Environment handling is Kubernetes-native, but the developer experience should feel similar to Vercel:

- `fabrik env set` writes cluster state
- `fabrik env pull` gives developers a local file view
- `fabrik run --env <name>` selects a named environment for execution

Kubernetes is the source of truth for runtime configuration. Local `.env` files are an import/export format, not the canonical store.

#### Design inspiration

The intended mental model is a deliberate combination of a few existing systems that already work well:

- Vercel-style developer experience:
  - named environments are first-class (`dev`, `preview`, `staging`, `prod`)
  - `env pull` exists for local developer workflows
  - local files are a convenience view of remote state, not the source of truth
  - `env run -- <command>` is a useful local compatibility path
- Doppler-style hierarchy and access model:
  - project-scoped configuration is distinct from shared machine credentials
  - runtime read access should be narrower than human mutation access
  - missing or divergent keys across environments should be visible and explicit
- GitHub Environments-style protection model:
  - production-like environments are more protected than development ones
  - approval or elevated permissions for production mutation is expected
  - environment boundaries are part of the product model, not just naming convention
- Kubernetes-native storage and runtime wiring:
  - Secrets are the canonical backing store
  - Jobs and CronJobs consume env through Secret mounts and, where needed, env projection
  - Fabrik should not invent a separate secret database or scheduler-local configuration source

This means Fabrik is not trying to copy Vercel exactly. Vercel is deployment-platform-first, while Fabrik is cluster/job-first. The inspiration we keep is the operator experience around named environments and local pull. The parts we intentionally keep Kubernetes-native are storage, runtime injection, and access boundaries.

#### Goals

- Named environments such as `dev`, `preview`, `staging`, and `prod`
- Per-project environment isolation
- Clear separation between shared platform credentials and project env
- Local developer pull flow without making local files the source of truth
- Environment promotion between stages with explicit diff visibility
- Protected production writes

#### Secret classes

Two distinct secret classes are required:

1. Shared credential bundles
   - Canonical cluster-wide runtime credentials stored as Kubernetes Secrets in `fabrik-system`
   - Examples: Codex auth bundle, Claude auth bundle, Pi auth bundle, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`
   - Managed by operators, not normal project workflows
   - This is a secret class, not a requirement that all shared credentials live in one giant Secret object

2. `fabrik-env-<project>-<env>`
   - Project-scoped runtime configuration
   - Examples: `DATABASE_URL`, `API_BASE_URL`, `LAOS_*`, app-level secrets
   - Selected by `fabrik run --project <p> --env <e>`

#### Shared credential bundle model

Shared credentials should be modeled as named Secrets rather than a single polymorphic payload.

Recommended naming:

- `fabrik-credential-codex-default`
- `fabrik-credential-claude-default`
- `fabrik-credential-pi-default`
- `fabrik-credential-openai-default`
- `fabrik-credential-anthropic-default`

Each named Secret represents one bundle for one harness, provider, or runtime use case.

This keeps Fabrik standalone and workflow-implementation-independent because Fabrik only needs to know:

- which bundle is selected for a run
- where that bundle should be mounted
- whether a run-scoped override suppresses the cluster default

Fabrik should not need to understand the internal auth schema of Codex, Claude Code, Pi, or other tools.

#### Runtime injection rules

At runtime, jobs may consume:

- zero or more shared credential bundles mounted read-only under `/var/run/fabrik/credentials/<bundle>/`
- `fabrik-env-<project>-<env>` mounted read-only at `/etc/fabrik/env/`
- selected env-style shared credentials projected into the environment where ecosystem compatibility requires it

Security preference:

- secrets should be mounted as files where practical
- env var projection exists for ecosystem compatibility and simple tools
- sensitive values should not be echoed in logs or surfaced in command output
- credential bundles that need refresh visibility must be mounted as directories, not via `subPath`

#### Shared credential bundle selection and overrides

The selection model must be explicit:

1. A run may select a cluster-shared default bundle by logical name.
2. A run may instead provide an explicit run-scoped override bundle.
3. If a run-scoped override bundle is present, Fabrik mounts only that override for the selected target and must not also mount the cluster default for that same target.
4. Adjacent runtime configuration that is not itself credential material, such as Pi `models.json`, is not part of the shared credential bundle core and should be modeled separately.

Run-scoped overrides may come from:

- a local file or directory imported into a run-only Secret
- an explicit existing cluster Secret reference

In both cases, override semantics remain the same: explicit run selection suppresses the default for that target.

#### Refreshable mount contract

Credential refresh must remain Kubernetes-native.

The contract is:

- Kubernetes Secrets in `fabrik-system` are the canonical source of truth for cluster-shared credentials.
- Fabrik mirrors the selected shared bundle into the run namespace before dispatch.
- Cluster-backed bundles are mounted as read-only directories.
- Running jobs using cluster-backed bundles must be able to observe updated credential contents when the underlying Secret is replaced and the helper re-reads the mounted directory.
- Fabrik does not guarantee live refresh for fixed local imports unless those imports are represented as refreshable cluster Secrets.

This distinction matters:

- new jobs using cluster-shared bundles must always see the latest cluster state
- running jobs using cluster-shared bundles must also be able to observe updates
- run-scoped local imports are intentionally fixed for the life of that run unless explicitly modeled otherwise

`subPath` mounts are therefore not acceptable for credential bundles that are expected to refresh during a run.

#### Separation of responsibilities

Fabrik core owns:

- secret selection
- namespace mirroring
- read-only mount layout
- precedence
- non-secret Kubernetes-native event emission

Harness-specific helper code owns:

- parsing provider-native auth payloads
- choosing between multiple credentials in a pool
- classifying provider-specific auth failures
- retry and fallback behavior
- copying mounted credentials into the tool-native writable runtime location when required

Examples:

- Codex helper logic may rotate through multiple `*.auth.json` files
- Claude helper logic may rotate through provider-native auth files
- Pi helper logic may consume `~/.pi/agent/auth.json` while treating `models.json` as adjacent config

Fabrik should not implement provider-specific token refresh logic.

#### Precedence rules

The precedence model must be deterministic:

1. platform runtime metadata injected by Fabrik (`SMITHERS_*`)
2. explicit run-scoped credential overrides for the selected target
3. selected cluster-shared credential bundles for the selected target
4. project env secret (`fabrik-env-<project>-<env>`) for project runtime configuration

#### CLI semantics

`fabrik env set` supports two write modes:

- whole-file import:
  - `fabrik env set --project myapp --env dev --from-file .env`
- explicit key writes:
  - `fabrik env set --project myapp --env dev KEY=value`

Write behavior is merge-by-default:

- keys provided in the command are updated or inserted
- unspecified existing keys are preserved
- `--replace` replaces the entire secret payload
- `--unset KEY` removes a key

`fabrik env pull` is the local read path:

- `fabrik env pull --project myapp --env dev .env.local`
- writes a dotenv-style file for local tooling
- should redact output from terminal logs unless explicitly requested

`fabrik env run` is the no-file local execution path:

- `fabrik env run --project myapp --env dev -- npm test`
- materializes env values only for the child process

`fabrik env diff` and `fabrik env promote` support stage movement:

- `env diff` shows missing, changed, and extra keys between two environments
- `env promote` copies values from one environment to another
- `env promote` requires explicit target selection and should default to previewing the diff first

#### Environment naming

Environment names are first-class identifiers, inspired by Vercel-style developer experience:

- `dev`
- `preview`
- `staging`
- `prod`
- additional custom names are allowed if DNS-safe

Secret names remain:

- `fabrik-env-<project>-<env>`

#### Permission model

The v1 permission model should be simple and explicit:

- Developers may read/write non-production environments for their project
- Production environment mutation is restricted to elevated maintainers/operators
- Runtime jobs get read-only access only to the selected environment
- Shared `fabrik-credentials` mutation is restricted to cluster operators

Protected environment rules:

- `prod` writes should require explicit confirmation at minimum
- cluster or API-backed implementations may add required-reviewer gates later
- `env pull` for production may be restricted or audited more tightly than non-production pulls

This mirrors the best parts of Vercel, GitHub Environments, and Doppler:

- Vercel-style `env pull` / named environments / local developer flow
- GitHub-style protected production environments
- Doppler-style separation between human write access and runtime read access

#### Kubernetes-native notification model

Fabrik core should keep notification behavior minimal and Kubernetes-native.

Default behavior:

- Jobs and Pods emit Kubernetes Events when credential wiring is missing, exhausted, or explicitly reported as invalid by a helper
- structured stderr/log output remains available for operators and log pipelines
- external webhook forwarding, chat integrations, or paging integrations remain helper- or platform-level concerns rather than Fabrik core concerns

This keeps the default behavior aligned with normal cluster tooling while still allowing higher-level automation to react.

#### Audit and validation

Environment changes must be auditable:

- who changed it
- when it changed
- which keys changed
- whether the operation was merge or replace

Validation requirements:

- invalid dotenv lines are rejected clearly
- duplicate keys in the same import are rejected
- reserved `SMITHERS_*` keys cannot be written through project env
- secret names and project/env identifiers must remain DNS-safe

#### Operational guidance

The easiest model to reason about and maintain is:

- Kubernetes Secret is the runtime source of truth
- local `.env` files are import/export helpers
- explicit environment selection at run time
- explicit promotion between stages
- protected writes for production

This avoids ambiguous local-vs-cluster drift and keeps runtime behavior aligned with Kubernetes-native execution.

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
        `fabrik.sh/run-id=${runId}`  // labelSelector
      );
      
      if (jobs.body.items.length > 0) {
        const job = jobs.body.items[0];
        const pod = await this.getPodForJob(job);
        
        return {
          id: runId,
          status: this.extractStatus(pod),
          phase: pod.metadata?.labels?.['fabrik.sh/phase'] || 'unknown',
          task: pod.metadata?.labels?.['fabrik.sh/task'] || 'unknown',
          progress: JSON.parse(pod.metadata?.annotations?.['fabrik.sh/progress'] || '{}'),
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
      { labelSelector: 'fabrik.sh/managed-by=fabrik' },
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

## Resilience: Resume Without Losing Progress

When Smithers crashes, times out, or the pod dies, we resume without losing progress.

**Mechanism:**

```
┌─ Resilience Flow ──────────────────────────────────────────────────────┐
│                                                                         │
│  1. Smithers runs in pod with PVC mounted at /workspace/.smithers     │
│     └─ SQLite DB persists across pod restarts                         │
│                                                                         │
│  2. Pod dies (OOM, node failure, spot termination)                    │
│     └─ Job controller sees pod failed                                │
│                                                                         │
│  3. Job creates new pod (same PVC reattached)                        │
│     └─ Smithers starts, reads SQLite state                            │
│                                                                         │
│  4. Smithers resumes from last completed task                         │
│     └─ No progress lost, continues execution                           │
│                                                                         │
│  5. Fabrik detects prolonged failure (>30min stuck)                  │
│     └─ Alert fired (webhook/email)                                   │
│     └─ Optional: Auto-deploy "fixer" pod with diagnostic tools       │
│         to investigate and potentially repair                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Resume Detection:**

```typescript
// Smithers startup checks SQLite
const db = new Database('/workspace/.smithers/state.db');
const lastTask = db.query("SELECT * FROM tasks WHERE status = 'completed' ORDER BY seq DESC LIMIT 1");

if (lastTask) {
  console.log(`Resuming from task ${lastTask.id}`);
  // Continue from next task
} else {
  console.log("Fresh start");
  // Start from beginning
}
```

**Auto-Healing (Optional):**

```bash
# When alert fires (via AlertManager in LAOS), deploy fixer
fabrik run fix --target 01jk7v8x... --spec specs/diagnose-and-repair.json

# Fixer pod has:
# - kubectl access to target namespace
# - Access to fabrik repo (this repo) for docs
# - LLM agent prompted to diagnose and suggest fixes
```

**Alerting Thresholds:**
- Pod stuck in `ContainerCreating` > 5 min → Alert
- Pod running but no annotation updates > 30 min → Alert  
- Job failed > 3 resume attempts → Alert + manual intervention

---

## Cleanup: K8s Native TTL

We use K8s native mechanisms for cleanup - no custom controller needed.

**Job Cleanup:**

```yaml
spec:
  ttlSecondsAfterFinished: 604800  # 7 days
  activeDeadlineSeconds: 86400     # 24 hour max runtime
```

**PVC Cleanup:**

```yaml
# RetainPolicy on StorageClass
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-fabrik
reclaimPolicy: Delete  # PVC deleted when Job deleted
# OR: reclaimPolicy: Retain for manual cleanup
```

**CLI Enforcement + Fallback:**
- CLI must set PVC ownerReferences to the Job and fail loudly if it cannot (ensures TTL GC deletes PVCs).
- Provide a CronJob fallback that deletes stale PVCs (e.g., by label and age) in case ownerRefs or TTL GC fail.

**Namespace-Level Cleanup:**

```bash
# Manual cleanup commands
fabrik runs cleanup --older-than 7d --status finished
fabrik runs cleanup --older-than 30d --status failed
fabrik volumes cleanup --unused  # Delete unbound PVCs
```

**Resource Quotas (Prevent Cluster Exhaustion):**

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: fabrik-runs-quota
  namespace: fabrik-runs
spec:
  hard:
    jobs: "100"
    pods: "100"
    requests.cpu: "100"
    requests.memory: 200Gi
    limits.cpu: "200"
    limits.memory: 400Gi
    persistentvolumeclaims: "50"
```

---

## Acceptance Criteria

- [ ] `fabrik cluster init` creates working k3s cluster with fabrik-system and fabrik-runs namespaces
- [ ] `fabrik run --spec x.json` creates Job that completes successfully
- [ ] Job pods show correct labels: `fabrik.sh/phase`, `fabrik.sh/task`, `fabrik.sh/status`
- [ ] Job pods show correct annotations: `fabrik.sh/progress` as JSON
- [ ] Smithers updates pod labels/annotations in real-time (every task transition)
- [ ] `fabrik runs list` queries K8s directly, returns all runs across configured clusters
- [ ] `fabrik runs show --id <run-id>` returns current phase, task, progress from pod labels
- [ ] `fabrik run cancel --id <run-id>` deletes Job, cascading to pod
- [ ] `fabrik run resume --id <run-id>` deletes stuck pod, Job recreates it (Smithers resume)
- [ ] PVC persists across pod restarts (Job deletes pod, keeps PVC)
- [ ] `fabrik env set --project myapp --env dev` creates Secret `fabrik-env-myapp-dev`
- [ ] `fabrik env pull --project myapp --env dev` writes dotenv-compatible output for local tooling
- [ ] `fabrik env run --project myapp --env dev -- <cmd>` runs a local child process with project env injected
- [ ] `fabrik env diff --project myapp --from dev --to staging` shows key-level differences
- [ ] `fabrik env promote --project myapp --from dev --to staging` copies values with explicit preview/confirmation
- [ ] Secrets are mounted as files in `/etc/fabrik/env/` and injected as env vars
- [ ] `fabrik-credentials` and `fabrik-env-<project>-<env>` remain separate secret classes
- [ ] Project env overrides shared credentials for conflicting keys
- [ ] Reserved `SMITHERS_*` keys are rejected from project env writes
- [ ] Production env mutation is protected more strongly than non-production env mutation
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
- [ ] Smithers resumes from last completed task after pod restart (no progress loss)
- [ ] Job `ttlSecondsAfterFinished` cleans up completed jobs after 7 days
- [ ] ResourceQuota limits prevent cluster exhaustion (100 jobs, 200Gi memory max)
- [ ] Alert fired when pod stuck > 30 min without annotation updates
- [ ] `fabrik run resume` deletes stuck pod, Job recreates with same PVC
- [ ] SQLite state in PVC survives pod restarts and node failures

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
  # Project/application configuration
  DATABASE_URL: "postgres://..."
  API_BASE_URL: "https://api.example.com"

  # Optional observability config
  LAOS_PROMETHEUS_URL: "http://prometheus:9090"
  LAOS_LOKI_URL: "http://loki:3100"
```

```yaml
# fabrik-credentials
apiVersion: v1
kind: Secret
metadata:
  name: fabrik-credentials
  namespace: fabrik-system
type: Opaque
stringData:
  OPENAI_API_KEY: "sk-..."
  ANTHROPIC_API_KEY: "sk-ant-..."
  GITHUB_TOKEN: "ghp-..."
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
