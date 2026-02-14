# Spec: k3s-orchestrator

> Enable Kubernetes-native job orchestration for remote spec dispatch

**Status**: draft
**Version**: 1.0.0
**Last Updated**: 2026-02-14
**Supersedes**: VM-based dispatch (`--vm`). K8s is the final orchestration target.

---

## Identity

- **ID**: `050-k3s-orchestrator`
- **Filename**: `specs/050-k3s-orchestrator.json`
- **Branch prefix**: `k3s-orchestrator-`
- **Commit trailer**: `spec: k3s-orchestrator`

---

## Title

**Enable Kubernetes-native job orchestration for remote spec dispatch**

---

## Goals

1. **Enable dispatching Smithers spec/todo runs as Kubernetes Jobs** via `fabrik run --kubeconfig`
2. **Enable scheduled recurring runs as Kubernetes CronJobs** via `fabrik schedule --kubeconfig`
3. **Provide extensible NixOS pod templates** for different task types with three reference templates (coding, report, marketing) and support for user-defined custom templates
4. **Persist job results in-cluster** via persistent storage (PVC) with backup to S3-compatible or WebDAV (Nextcloud) storage, retrievable by fabrik CLI
5. **Enable live state visibility** via `fabrik runs list/show/watch` when pointed at a kubeconfig, mirroring cluster state into local host DB
6. **Leverage Kubernetes self-healing** (Job retries, pod restarts) combined with Smithers SQLite resume for failed tasks
7. **Support single-node (on-device k3s), single-server, and multi-node clusters** transparently
8. **Provide cluster bootstrap tooling** via k3sup + NixOS root images + Pulumi configs for provisioning nodes on Hetzner (and other hosters), joining clusters, and scaling up/down
9. **Enable credential rotation** of API keys with automatic fallback across multiple auth sets per provider; rotation triggers graceful pod restart with Smithers SQLite resume

---

## Non-Goals

- **Rewriting Smithers workflows** — existing workflows run unchanged inside pods
- **Managed Kubernetes (EKS/GKE/AKS) support** — future consideration, k3s/self-hosted first
- **GPU workloads** — not needed for current task types
- **Custom CNI / service mesh** — vanilla k3s networking sufficient

---

## Requirements: API

### CLI Commands

```
# On-demand dispatch
fabrik run --spec <path> --kubeconfig <path> [--template coding|report|marketing|<custom>] [--todo <path>]
    [--repo <url>] [--project <dir>] [--include-git]
    [--resources-cpu <n>] [--resources-memory <n>Gi]

# Scheduled dispatch (CronJobs)
fabrik schedule --spec <path> --kubeconfig <path> --cron "<schedule>"
    [--template coding|report|marketing|<custom>]
    [--concurrency forbid|allow|replace]
fabrik schedule list --kubeconfig <path>
fabrik schedule delete --id <schedule-id> --kubeconfig <path>

# Monitoring (unified: works with --vm or --kubeconfig)
fabrik runs list --kubeconfig <path>
fabrik runs show --id <run-id> --kubeconfig <path>
fabrik runs watch --kubeconfig <path>

# Cancel
fabrik runs cancel --id <run-id> --kubeconfig <path> [--force]

# Feedback (unified)
fabrik feedback --kubeconfig <path> --spec <path> --decision approve|reject --notes "..."

# Credential management
fabrik credentials sync --kubeconfig <path>         # push host creds → cluster Secret
fabrik credentials rotate --kubeconfig <path>        # rotate/add API keys
fabrik credentials list --kubeconfig <path>          # show available key sets

# Image management
fabrik images build [--template <name>]              # nix build container images
fabrik images push --kubeconfig <path> --registry <url> [--template <name>]
fabrik images import --kubeconfig <path> [--template <name>]   # single-node: k3s ctr import

# Cluster bootstrap
fabrik cluster init --provider hetzner|local [--nodes <n>] [--ssh-key <path>]
fabrik cluster join --kubeconfig <path> --node <ip>
fabrik cluster scale --kubeconfig <path> --nodes <n>
fabrik cluster status --kubeconfig <path>

# Health check
fabrik doctor --kubeconfig <path>

# Environment variable management
fabrik env list --kubeconfig <path>                                   # List all env sets
fabrik env show --project <id> --env <name> --kubeconfig <path>       # View env as .env format
fabrik env set --project <id> --env <name> --file <path> --kubeconfig <path>  # Set from .env file
fabrik env set --project <id> --env <name> --key <k> --value <v> --kubeconfig <path>  # Set single key
fabrik env pull --project <id> --env <name> --file <path> --kubeconfig <path>  # Pull to local .env
fabrik env delete --project <id> --env <name> --kubeconfig <path>     # Delete env set
fabrik env delete --project <id> --env <name> --key <key> --kubeconfig <path>  # Delete single key
fabrik env validate --project <id> --env <name> --kubeconfig <path>    # Validate env exists and has required keys
```

### Pod Templates (NixOS-based container images)

Three reference templates ship by default. Users can define additional templates by creating `nix/hosts/container-<name>.nix` files.

| Template | Base | Additional Packages | Use Case |
|----------|------|---------------------|----------|
| `ralph-coding` | `ralph.nix` | agents + dev tools + jj (current) | Code implementation, refactoring, bug fixes |
| `ralph-report` | `ralph.nix` | agents + texlive/latex + pandoc + typst | Report writing, documentation, PDF generation |
| `ralph-marketing` | `ralph.nix` | agents + social-media CLIs (gh, etc.) | Content creation, social media posting |
| `ralph-<custom>` | `ralph.nix` | user-defined in `container-<custom>.nix` | Any task type |

Each template is a NixOS container image built via `nix build .#docker-<template>`.

### Kubernetes Resources Generated

- **Namespace**: `fabrik-system` (control plane: secrets, config, storage classes, env vars)
- **Namespace**: `fabrik-runs` (job execution: Jobs, CronJobs, pods, PVCs)
- **Job**: Created from spec.json + todo.json + template type for on-demand runs
- **CronJob**: Created from spec.json + todo.json + template type + cron schedule
- **ConfigMap**: per-run spec content, todo content, workflow script, prompt files (named `run-<id>-config`)
- **ConfigMap**: `fabrik-config` — cluster defaults (LAOS endpoints, global settings)
- **Secret**: `fabrik-credentials` — multi-key credential sets with fallback rotation
- **Secret**: `fabrik-env-<project>-<env>` — per-project environment variables (e.g., `fabrik-env-myapp-dev`)
- **Secret**: `fabrik-env-run-<ulid>` — temporary per-run env overrides (optional, auto-deleted)
- **PVC**: per-run persistent workspace for Smithers DB + reports (named `run-<id>-workspace`)
- **StorageClass**: cluster file storage layer (Longhorn, local-path, or external)

### Internal API

```typescript
// Dispatch a one-off K8s Job
k8sDispatchRun(options: K8sDispatchOptions): Promise<DispatchResult>

// Create a CronJob for recurring dispatch
k8sScheduleRun(options: K8sScheduleOptions): Promise<ScheduleResult>

// Query run status from cluster
k8sGetRunStatus(kubeconfig: string, runId: string): Promise<RunStatus>

// Retrieve results from cluster persistent storage → mirror to host
k8sGetResults(kubeconfig: string, runId: string): Promise<{ db: Buffer; reports: Record<string, string> }>

// Reconcile host DB with cluster state
k8sReconcile(kubeconfig: string): Promise<void>

// Rotate credentials in cluster Secret, optionally live-patch running pods
k8sRotateCredentials(kubeconfig: string, keySet: CredentialSet): Promise<void>

// Cancel a running Job (graceful shutdown + DB checkpoint)
k8sCancel(kubeconfig: string, runId: string, force?: boolean): Promise<void>

// Backup results to external storage
k8sBackupResults(kubeconfig: string, target: BackupTarget): Promise<void>
```

---

## Requirements: Run Identity

### ULID Format

All run IDs use **ULID** (Universally Unique Lexicographically Sortable Identifier):
- 26 characters, lowercase: `01jk7v8x9m3qn5r2t4w6y8z0ab`
- Crockford Base32, DNS-1123 compliant (lowercase alphanumeric only)
- Sortable by creation time
- Collision-resistant (48-bit timestamp + 80-bit random)

### Naming Convention

The run ID is the canonical identifier across all systems:

| System | Format | Example |
|--------|--------|---------|
| K8s Job name | `fabrik-<ulid>` | `fabrik-01jk7v8x9m3qn5r2t4w6y8z0ab` |
| K8s PVC name | `fabrik-<ulid>-ws` | `fabrik-01jk7v8x9m3qn5r2t4w6y8z0ab-ws` |
| K8s ConfigMap | `fabrik-<ulid>-cfg` | `fabrik-01jk7v8x9m3qn5r2t4w6y8z0ab-cfg` |
| Smithers DB | `<ulid>.db` | `01jk7v8x9m3qn5r2t4w6y8z0ab.db` |
| Host mirror path | `~/.cache/fabrik/runs/<ulid>/` | |
| Dashboard route | `/runs/<ulid>` | |
| VCS branch | `fabrik/<spec-id>/<ulid>` | `fabrik/feature-auth/01jk7v8x9m...` |

### K8s Labels (on all resources for a run)

```yaml
labels:
  app.kubernetes.io/managed-by: fabrik
  fabrik.dev/run-id: "<ulid>"
  fabrik.dev/spec-id: "<spec-id>"
  fabrik.dev/template: "<template-name>"
```

### CronJob Branch Naming

CronJob runs use per-run unique branches to avoid collisions:
```
fabrik/<spec-id>/<ulid>
```
Each scheduled run gets its own ULID, so branches never collide.

### Enforcement

- fabrik CLI and API server MUST generate ULIDs for all new runs
- K8s resource names MUST follow the `fabrik-<ulid>[-suffix]` pattern
- Smithers DB file MUST be named `<ulid>.db`
- All queries (list, show, watch) MUST accept ULID as the run identifier

---

## Requirements: Environment Variable Management

Environment variables provide runtime configuration to Smithers workflows and repos. All env vars are treated as sensitive and stored in Kubernetes Secrets.

### Storage Model

**Secret Naming Convention:**
- `fabrik-env-<project-id>-<environment>` — Per-project, per-environment (e.g., `fabrik-env-myapp-dev`)
- `fabrik-env-run-<ulid>` — Per-run overrides (temporary, cleaned up after run)

**Secret Structure:**
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: fabrik-env-myapp-dev
  namespace: fabrik-system
  labels:
    fabrik.dev/managed-by: fabrik
    fabrik.dev/project-id: "myapp"
    fabrik.dev/environment: "dev"
    fabrik.dev/scope: "project"
type: Opaque
stringData:  # Plaintext values for easier editing
  ANTHROPIC_API_KEY: "sk-ant-..."
  LAOS_LOKI_URL: "http://loki.fabrik-monitoring.svc:3100"
  DATABASE_URL: "postgres://..."
  DEBUG: "true"
```

**Storage Rules:**
- Secrets stored in `fabrik-system` namespace (centralized, survives run deletion)
- Use `stringData` field (not `data`) for human-readable YAML
- No history/versioning (non-goal; future spec may add this)
- No size limit concerns expected (if >1MB, split into multiple Secrets)

### Precedence (Highest to Lowest)

1. **Per-run env** (`fabrik-env-run-<ulid>`) — One-off overrides via `--env-var KEY=VALUE`
2. **Project env** (`fabrik-env-<project>-<env>`) — Standard dispatch via `--env <env-name>`
3. **Cluster defaults** (`fabrik-config` ConfigMap) — LAOS endpoints, global settings
4. **Pod defaults** — Hardcoded in container image

### Input Methods

All three methods supported via CLI and dashboard:

**Option A: Paste .env format**
```
ANTHROPIC_API_KEY=sk-ant-...
LAOS_LOKI_URL=http://loki.fabrik-monitoring.svc:3100
DEBUG=true
```

**Option B: Upload .env file** — Direct file upload, parsed server-side

**Option C: Key-value UI** — Individual key/value editing like Vercel

### Bidirectional Sync

**Push (Host → Cluster):**
```bash
fabrik env set --project myapp --env dev --file .env
```
- Parses `.env` (handles quotes, comments, newlines)
- Shows diff before apply
- Creates/updates Secret via API server

**Pull (Cluster → Host):**
```bash
fabrik env pull --project myapp --env dev --file .env
```
- Writes Secret to local `.env` file
- Adds header: `# Generated by fabrik from project=myapp env=dev`
- Overwrites only with `--force` or if file has fabrik header

### Dispatch Integration (Fail-Fast)

```
Given: User runs fabrik run --repo github.com/org/myapp --env dev --kubeconfig <path>
When:  CLI prepares dispatch
Then:  CLI validates that Secret fabrik-env-myapp-dev exists
And:   If Secret missing: Error immediately with actionable message:
       "Error: Environment 'dev' not found for project 'myapp'.
        Create it: fabrik env set --project myapp --env dev --file .env"
And:   If Secret exists but missing required keys (ANTHROPIC_API_KEY, LAOS_LOKI_URL):
       Error with list of missing keys
And:   Only then creates the Job with env vars injected
```

**Pod Injection:**
```yaml
spec:
  template:
    spec:
      containers:
      - name: smithers
        envFrom:
        - secretRef:
            name: fabrik-env-myapp-dev
        - secretRef:
            name: fabrik-credentials
        env:
        - name: FABRIK_RUN_ID
          value: "01jk7v8x9m3qn5r2t4w6y8z0ab"
        - name: FABRIK_PROJECT_ID
          value: "myapp"
        - name: FABRIK_ENV
          value: "dev"
```

### Per-Run Overrides

One-off variable changes without modifying the project env:

```bash
fabrik run --repo github.com/org/myapp --env dev \
  --env-var DEBUG=false \
  --env-var MODEL=gpt-4o
```

Creates temporary Secret `fabrik-env-run-<ulid>` with only the overrides. Cleaned up after run completion.

### Validation

**Basic format validation:**
- URL format check for `*_URL` keys
- API key prefix validation (e.g., `sk-ant-*` for Anthropic)
- Required keys check: `ANTHROPIC_API_KEY`, `LAOS_LOKI_URL`

**Pre-dispatch validation:**
```bash
fabrik env validate --project myapp --env dev
# Checks: Secret exists, required keys present, values non-empty
```

**Dashboard validation:**
- Visual indicators for malformed values
- "Test Connection" button for LAOS endpoints (optional v1.1)

### Repo Integration

If a repo strictly requires a `.env` file (not just environment variables):

```bash
# In fabrik-agent-runner entrypoint, after git clone
if [ "$FABRIK_GENERATE_DOTENV" = "true" ] || [ -f .env.example ]; then
  printenv | grep -E '^(ANTHROPIC|LAOS|DATABASE|DEBUG)' > .env
  echo "# Generated by fabrik from runtime env" >> .env
fi
```

Standard recommendation: Repos should read `process.env.X` directly. The pod exports all env vars from Secrets.

---

## Requirements: Behavior

### Job Dispatch

```
Given: User has a valid kubeconfig pointing to a k3s cluster
When:  fabrik run --kubeconfig <path> --spec specs/feature.json --template coding
Then:  A Kubernetes Job is created in namespace "fabrik-runs"
And:   The pod uses the ralph-coding NixOS image
And:   spec.json + todo.json are mounted via ConfigMap
And:   A PVC is created for the run workspace (.smithers DB + reports)
And:   Credentials are mounted from fabrik-credentials Secret
And:   Environment variables are injected from fabrik-config ConfigMap (cluster defaults)
And:   Smithers runs the workflow inside the pod
And:   Pod writes smithers.pid + heartbeat.json every 30s (per AGENTS.md)
And:   On completion, results persist in the PVC
And:   fabrik CLI can retrieve results from PVC to host at any time
And:   fabrik API server updates run status (source of truth)
```

### Job Dispatch with Environment

```
Given: User runs fabrik run --kubeconfig <path> --spec specs/feature.json --template coding --project myapp --env dev
When:  CLI validates that fabrik-env-myapp-dev Secret exists
And:   Validates required keys (ANTHROPIC_API_KEY, LAOS_LOKI_URL) are present
Then:  Creates Kubernetes Job with:
And:   Pod envFrom includes fabrik-env-myapp-dev Secret (project env)
And:   Pod envFrom includes fabrik-credentials Secret (API keys)
And:   FABRIK_PROJECT_ID=myapp and FABRIK_ENV=dev set as pod env vars
And:   All env vars from fabrik-env-myapp-dev available to Smithers and repo
```

### Job Dispatch with Per-Run Env Overrides

```
Given: User runs fabrik run --kubeconfig <path> --repo github.com/org/myapp --env dev --env-var DEBUG=false --env-var MODEL=gpt-4o
When:  CLI validates base env fabrik-env-myapp-dev exists
Then:  Creates temporary Secret fabrik-env-run-<ulid> with DEBUG=false and MODEL=gpt-4o
And:   Creates Job with both Secrets in envFrom (run env takes precedence via naming)
And:   Run env Secret is deleted after Job completion (success or failure)
```

### Job Dispatch with Repo / Project Sync

```
Given: User dispatches with --repo <url>
Then:  Pod clones the repo on startup using credentials from Secret
And:   Pod works on a jj branch matching existing convention
And:   Pod pushes changes via jj git push before task completion (per AGENTS.md)

Given: User dispatches with --project <dir> [--include-git]
Then:  Local directory is synced to the pod workspace via kubectl cp or tar pipe
And:   If --include-git, .git is included and jj is initialized
And:   Pod pushes changes via jj git push before task completion
```

### CronJob Scheduling

```
Given: User has a valid kubeconfig pointing to a k3s cluster
When:  fabrik schedule --kubeconfig <path> --spec specs/weekly-report.json --template report --cron "0 9 * * 1"
Then:  A Kubernetes CronJob is created in namespace "fabrik-runs"
And:   concurrencyPolicy defaults to Forbid (no overlapping runs for same spec)
And:   Every Monday at 09:00, a Job is spawned from the CronJob
And:   Each spawned Job gets its own PVC for workspace persistence
And:   Each spawned Job follows the same lifecycle as on-demand Jobs
And:   fabrik schedule list --kubeconfig shows the CronJob with next run time
And:   Results from each CronJob run are retrievable via fabrik runs show

Given: A CronJob run completes
Then:  A collector Smithers flow pushes results to permanent storage (S3/WebDAV)
And:   VCS output (jj push to GitHub) acts as the primary output artifact
And:   The PVC is retained per retention policy (configurable, default: keep last 10 runs)
```

### Self-Healing / Resume

```
Given: A running Smithers job fails mid-task (OOM, node drain, pod eviction)
When:  Kubernetes restarts the pod (Job backoffLimit)
Then:  Pod remounts the same PVC (Smithers DB persists across restarts)
And:   Smithers resumes from SQLite state (existing resume logic)
And:   The restarted pod detects stale PID and marks previous execution failed
And:   VCS push is required before task completion (per AGENTS.md)
```

### Credential Rotation and Rate-Limit Fallback

```
Given: A pod hits a rate limit on an API provider (e.g. Anthropic, OpenAI)
When:  The agent returns a rate-limit error
Then:  The pod entrypoint's credential wrapper detects the error
And:   Re-reads credential files from /etc/fabrik/credentials/
And:   Sets the next available API key for that provider
And:   Retries the agent command with the new key
And:   Logs the rotation event

Given: All keys for a provider are exhausted (all rate-limited)
Then:  The pod logs the exhaustion event
And:   An alert is fired (P1) via LAOS
And:   The Smithers task is marked as blocked with reason "rate_limit_exhausted"

Given: User runs fabrik credentials rotate --kubeconfig <path>
Then:  The fabrik-credentials Secret is updated in the cluster
And:   Running pods are gracefully restarted via annotation patch (kubectl rollout restart)
And:   Smithers resumes from SQLite state on the same PVC (no work lost)
And:   New credential files are available in restarted pods
```

#### Credential Wrapper Script

The pod entrypoint is NOT the raw agent CLI. It is a wrapper script (`/usr/local/bin/fabrik-agent-runner`) that:

1. Reads all credential files from `/etc/fabrik/credentials/`
2. Builds an ordered list of keys per provider
3. Sets the primary key as env var (e.g. `ANTHROPIC_API_KEY`)
4. Launches the agent (Smithers workflow)
5. On rate-limit exit code, rotates to next key and re-launches
6. Smithers resumes from SQLite on re-launch (same PVC, same DB)

This script is baked into the NixOS container image.

### Human Gate in K8s

```
Given: A Smithers workflow reaches the human gate
When:  The pod writes human_gate status "blocked" to the Smithers DB
Then:  The pod stays running and waits for feedback
And:   An alert is fired via the Grafana/LAOS alerting stack (PagerDuty, Zulip, email)
And:   fabrik runs watch --kubeconfig detects the blocked state and fires desktop notification
And:   The Job has no activeDeadlineSeconds (waits indefinitely for human input)

Given: User runs fabrik feedback --kubeconfig <path> --spec <path> --decision approve
Then:  Feedback is written to the Smithers DB in the pod's PVC
And:   The pod detects the feedback and continues or stops accordingly
```

### Monitoring / Reconciliation

```
Given: User runs fabrik runs list --kubeconfig <path>
When:  The CLI queries the fabrik API server
Then:  It shows all fabrik Jobs/CronJobs in fabrik-runs namespace
And:   Status is derived from K8s Job status + Smithers DB heartbeat
And:   Status is authoritative from the fabrik API server

Given: User runs fabrik runs show --id <id> --kubeconfig <path>
Then:  CLI reads Smithers DB from the run's PVC
And:   Mirrors it to local host (e.g. ~/.cache/ralph/k8s/<run-id>.db)
And:   Displays task/review reports from the mirrored DB
```

### Superseding VM Dispatch

The k3s orchestrator is the final incarnation of fabrik's execution layer. The `--vm` path is deprecated:

```
Given: User runs fabrik run --spec specs/feature.json (no --vm, no --kubeconfig)
Then:  fabrik checks for FABRIK_KUBECONFIG env var or ~/.kube/fabrik.yaml
And:   If found, dispatches to k3s cluster
And:   If not found, prints error with setup instructions

Given: User runs fabrik run --vm ralph-1 --spec specs/feature.json
Then:  Deprecated VM dispatch path is used with a deprecation warning
And:   Output suggests migrating to --kubeconfig
```

---

## Requirements: Persistence & Storage

### In-Cluster Storage Layer

The cluster requires a persistent storage solution. Options (in order of preference):

1. **Longhorn** — distributed block storage, multi-node replication, built for k3s
2. **local-path-provisioner** — k3s default, single-node only, good for dev
3. **NFS** — simple shared storage, works multi-node
4. **External CSI** — for cloud-attached storage

Each run gets a PVC (`run-<id>-workspace`) that persists:
- `.smithers/*.db` — Smithers SQLite database (source of truth)
- `reports/` — run-context.json, smithers.log, reviewer outputs
- Workspace files (code, generated artifacts)

### External Backup

Results can be backed up to external storage for long-term retention:

```
fabrik backup --kubeconfig <path> --target s3://bucket/prefix
fabrik backup --kubeconfig <path> --target webdav://nextcloud.example.com/fabrik
fabrik backup --kubeconfig <path> --run-id <id>   # backup specific run
fabrik backup --kubeconfig <path> --all            # backup all completed runs
```

Backup targets:
- **S3-compatible**: MinIO (in-cluster or external), AWS S3, Backblaze B2
- **WebDAV**: Nextcloud, ownCloud, any WebDAV server

### Result Retrieval Flow

```
Pod workspace (PVC)
    │
    ├──► fabrik runs show (kubectl cp from PVC → host ~/.cache/ralph/k8s/<run-id>/)
    │
    ├──► Collector Smithers flow (optional, runs as final task)
    │    └── pushes to S3/WebDAV/GitHub
    │
    └──► VCS output (jj git push → GitHub branch/PR)
```

### Retention Policy

- PVCs for completed runs: configurable retention (default: keep last 10 per spec)
- CronJob history: `successfulJobsHistoryLimit` / `failedJobsHistoryLimit` (K8s native)
- External backups: governed by target storage policy (S3 lifecycle, Nextcloud versioning)

---

## Requirements: Storage Constraints

### SQLite on Longhorn

Smithers uses SQLite as its primary database. SQLite on network-attached storage requires specific configuration:

#### Required PVC Settings

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fabrik-<ulid>-ws
  namespace: fabrik-runs
spec:
  accessModes: ["ReadWriteOnce"]      # CRITICAL: single-writer only
  storageClassName: longhorn           # or local-path for dev
  resources:
    requests:
      storage: 10Gi                    # default, configurable via CLI
```

#### SQLite PRAGMA Requirements

The `fabrik-agent-runner` entrypoint MUST set these PRAGMAs before any Smithers DB access:

```sql
PRAGMA journal_mode=WAL;          -- Write-Ahead Logging for crash safety
PRAGMA synchronous=NORMAL;        -- Good balance of safety vs performance on Longhorn
PRAGMA busy_timeout=5000;         -- Wait up to 5s on lock contention
PRAGMA wal_autocheckpoint=1000;   -- Checkpoint every 1000 pages
```

#### Storage Provider Compatibility

| Provider | Supported | Notes |
|----------|-----------|-------|
| Longhorn | ✅ Primary | Block storage, RWO, good SQLite compat |
| local-path | ✅ Dev only | Single-node, no replication |
| NFS | ❌ Prohibited | SQLite locking broken on NFS |
| CephFS | ⚠️ Untested | May work with POSIX locks |
| EBS/PD (cloud CSI) | ✅ | Block storage, RWO |

#### Single-Writer Enforcement

- PVC access mode is `ReadWriteOnce` — only one pod can mount it at a time
- K8s Job `parallelism: 1` ensures only one pod runs per Job
- If a pod is evicted and rescheduled, the old pod must fully terminate before the new pod mounts the PVC
- `backoffLimit` delays ensure no two pods attempt concurrent access

---

## Requirements: Credential Management

### Multi-Key Credential Sets

The `fabrik-credentials` Secret holds multiple API keys per provider to support fallback on rate limits:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: fabrik-credentials
  namespace: fabrik-system
type: Opaque
data:
  # Primary keys
  ANTHROPIC_API_KEY_1: <base64>
  ANTHROPIC_API_KEY_2: <base64>
  OPENAI_API_KEY_1: <base64>
  OPENAI_API_KEY_2: <base64>
  GITHUB_TOKEN: <base64>
  # Agent auth files (JSON, base64-encoded)
  PI_AUTH_JSON_1: <base64>
  PI_AUTH_JSON_2: <base64>
  CLAUDE_AUTH_JSON_1: <base64>
  CODEX_AUTH_JSON_1: <base64>
```

### Pod Credential Mounting

Credentials are mounted as files in predictable paths:

```
/etc/fabrik/credentials/
├── anthropic-key-1
├── anthropic-key-2
├── openai-key-1
├── openai-key-2
├── github-token
├── pi-auth-1.json
├── pi-auth-2.json
├── claude-auth-1.json
└── codex-auth-1.json
```

The pod entrypoint is `fabrik-agent-runner` (see Credential Wrapper Script above), NOT a raw agent CLI or systemd service.

### Live Rotation

```
Given: User adds a new API key via fabrik credentials rotate
When:  The fabrik-credentials Secret is updated
Then:  Running pods are gracefully restarted via annotation patch
And:   Smithers resumes from SQLite state on the same PVC
And:   New keys are available in restarted pods
And:   No work is lost (PVC persists across pod restarts)
```

### Credential Sync from Host

```
fabrik credentials sync --kubeconfig <path>
```

Reads from host locations:
- `~/.pi/agent/auth.json`
- `~/.claude/` or `~/.claude.json`
- `~/.codex/auth.json`
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN` from env or `~/.config/ralph/ralph.env`

Creates/updates the `fabrik-credentials` Secret in the cluster by adding new ones, leaving existing oens that are the same / replacing outdated ones.

---

## Requirements: Container Runtime Model

### Single-Process Entrypoint (Not systemd)

Pod containers use a **direct entrypoint** — NOT systemd. This is the optimal model for K8s:

```
ENTRYPOINT ["/usr/local/bin/fabrik-agent-runner"]
```

The `fabrik-agent-runner` script:
1. Sources credentials from `/etc/fabrik/credentials/`
2. Sets up jj/git identity and auth
3. Clones repo or waits for project sync (if applicable)
4. Writes `smithers.pid` and starts heartbeat loop
5. Launches `smithers run <workflow>` with all env vars
6. On rate-limit exit, rotates credentials and re-launches
7. On completion, writes exit code to PVC

### Existing container.nix Superseded

The current `nix/hosts/container.nix` uses systemd + `ralph-agent` service. For k3s:
- `container.nix` is replaced by per-template variants (`container-coding.nix`, etc.)
- systemd is removed; entrypoint is `fabrik-agent-runner`
- The `ralph-install-agents` systemd service becomes a Nix build-time step (agents baked into image)

### Security Context

All agent pods run with:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000        # ralph user
  runAsGroup: 1000
  readOnlyRootFilesystem: false   # agents need to write to HOME, install deps
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

### Network Policies

Agent pods in `fabrik-runs` namespace have restricted egress:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: fabrik-runs-egress
  namespace: fabrik-runs
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/managed-by: fabrik
  policyTypes: ["Egress"]
  egress:
    # GitHub (git push, API)
    - to:
        - ipBlock: { cidr: 0.0.0.0/0 }
      ports:
        - port: 443
          protocol: TCP
        - port: 22
          protocol: TCP
    # DNS
    - to:
        - namespaceSelector: {}
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # LAOS telemetry (in-cluster)
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: fabrik-monitoring
      ports:
        - port: 4317    # OTLP
          protocol: TCP
        - port: 3100    # Loki
          protocol: TCP
```

Note: Egress allows HTTPS (443) and SSH (22) broadly because agent pods need to reach GitHub, npm registries, and API providers (Anthropic, OpenAI, etc.) whose IPs are dynamic. The key restriction is **no privilege escalation** and **no access to cluster-internal services** outside fabrik-monitoring.

---

## Requirements: Project Sync

### Sync Mechanism

Project sync follows the existing pattern from `dispatch.ts` (tar-based transfer), adapted for K8s:

#### With --repo (preferred)

```
Given: User dispatches with --repo <url> [--ref <branch>]
Then:  The fabrik-agent-runner entrypoint clones the repo inside the pod
And:   Uses credentials from /etc/fabrik/credentials/github-token
And:   Initializes jj: jj git init
And:   Creates branch: fabrik/<spec-id>/<ulid>
```

No external sync needed — the pod handles everything.

#### With --project <dir>

```
Given: User dispatches with --project <dir> [--include-git]
Then:  fabrik CLI creates the Job
And:   Waits for pod to reach Running state
And:   Tars the project directory (excluding node_modules, .git unless --include-git)
And:   Pipes tar into pod: kubectl exec <pod> -- tar -xf - -C /workspace
And:   Writes a marker file: /workspace/.sync-complete
And:   fabrik-agent-runner waits for .sync-complete before starting Smithers

Exclusions (default):
  - node_modules/
  - .git/ (unless --include-git)
  - dist/, build/, .output/
  - *.log

Maximum project size: 1GB (configurable via --max-sync-size)
```

#### Sync Completion Protocol

The pod entrypoint (`fabrik-agent-runner`) checks for sync state:

```bash
if [ -n "$FABRIK_PROJECT_SYNC" ]; then
  echo "Waiting for project sync..."
  while [ ! -f /workspace/.sync-complete ]; do sleep 1; done
  echo "Project sync complete."
fi
```

The `FABRIK_PROJECT_SYNC=1` env var is set by fabrik when `--project` is used.

---

## Requirements: Cancellation

### Clean Exit on Cancel

```
Given: User runs fabrik runs cancel --id <ulid> --kubeconfig <path>
Then:  fabrik writes status "cancelled" to the Smithers DB in the pod's PVC
And:   Sends SIGTERM to the pod (kubectl delete pod --grace-period=30)
And:   Pod entrypoint traps SIGTERM and allows Smithers to checkpoint
And:   After grace period, pod is killed
And:   Job is deleted
And:   PVC is retained (results are still accessible)
And:   Host DB is updated with status "cancelled"

Given: User cancels via dashboard (/runs/:id → Cancel button)
Then:  Same flow via API server
```

### CLI Command

```
fabrik runs cancel --id <ulid> --kubeconfig <path> [--force]
  --force: skip graceful shutdown, delete immediately
```

---

## Requirements: Observability

### Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `fabrik.k8s.jobs.dispatched` | counter | template, spec_id |
| `fabrik.k8s.jobs.completed` | counter | template, status |
| `fabrik.k8s.jobs.duration` | histogram | template |
| `fabrik.k8s.cronjobs.triggered` | counter | spec_id, template |
| `fabrik.k8s.cronjobs.missed` | counter | spec_id |
| `fabrik.k8s.credentials.rotated` | counter | provider |
| `fabrik.k8s.credentials.rate_limited` | counter | provider, key_index |

### Logs

- Job creation events with spec_id, template, namespace
- Pod phase transitions (Pending → Running → Succeeded / Failed)
- CronJob trigger events with last/next schedule times
- Result retrieval and backup success/failure
- Heartbeat staleness warnings
- Credential rotation events
- Rate-limit fallback events

### Alerts & Paging

| Condition | Severity | Channel | Action |
|-----------|----------|---------|--------|
| Job pending >10min | P2 | Grafana alert | Check image pull, resource constraints |
| Job failed after all retries | P1 | PagerDuty/Zulip | Inspect pod logs, check Smithers DB |
| Heartbeat stale >60s in running pod | P2 | Grafana alert | Investigate pod health |
| CronJob missed schedule | P2 | Grafana alert | Check cluster capacity |
| Human gate blocked | P1 | PagerDuty/Zulip/Desktop | Human must provide feedback |
| All API keys rate-limited for a provider | P1 | PagerDuty/Zulip | Add keys or wait for reset |

LAOS (Grafana/Loki/Tempo/Prometheus) runs either:
- **In-cluster**: deployed as part of `fabrik cluster init` in a `fabrik-monitoring` namespace
- **External**: pods configured via `OTEL_EXPORTER_OTLP_ENDPOINT` and `LOKI_URL` env vars pointing to external URLs

### Health Checks

`fabrik doctor --kubeconfig <path>` verifies:
- Cluster reachable and API server healthy
- Namespaces exist (`fabrik-system`, `fabrik-runs`)
- Container images pullable from configured registry
- `fabrik-credentials` Secret exists and has required keys
- Storage provisioner available and can create PVCs
- LAOS endpoints reachable (if configured)
- Sufficient cluster resources for at least one job pod
- `kubectl` available on host (if missing: print install instructions)

---

## Requirements: Cluster Bootstrap

### Goal

Provide a repeatable path from bare metal / cloud provider to a working k3s cluster with fabrik pre-configured.

### NixOS Root Image

A NixOS image that includes:
- k3s pre-installed and configured
- `fabrik-system` and `fabrik-runs` namespaces pre-created on first boot
- Storage provisioner (Longhorn or local-path) pre-installed
- SSH access for management
- Firewall rules for k3s (6443, 8472 UDP for Flannel, 10250)

```nix
# nix/hosts/k3s-node.nix
# NixOS module for a k3s cluster node
# Configurable as server (control plane) or agent (worker)
```

Built via:
```bash
nix build .#packages.<system>.k3s-server   # control plane node image
nix build .#packages.<system>.k3s-agent    # worker node image
```

### Pulumi Infrastructure-as-Code

Pulumi configs for provisioning on Hetzner (primary) and extensible to other providers:

```
infra/
├── pulumi/
│   ├── Pulumi.yaml
│   ├── Pulumi.dev.yaml         # single-node dev cluster
│   ├── Pulumi.prod.yaml        # multi-node production
│   ├── index.ts                # main Pulumi program
│   ├── hetzner.ts              # Hetzner Cloud provider
│   ├── nixos-image.ts          # upload/register NixOS image
│   ├── k3s-cluster.ts          # provision nodes, init cluster
│   └── fabrik-bootstrap.ts     # post-provision: namespaces, secrets, storage
```

Workflow:
```bash
# 1. Build NixOS k3s image
nix build .#packages.x86_64-linux.k3s-server

# 2. Provision infrastructure
cd infra/pulumi
pulumi up -s dev     # single control-plane node
pulumi up -s prod    # 3 nodes (1 server + 2 agents)

# 3. Get kubeconfig
pulumi stack output kubeconfig > ~/.kube/fabrik.yaml

# 4. Verify
fabrik doctor --kubeconfig ~/.kube/fabrik.yaml
```

### k3sup Integration

For manual / existing-machine setups:

```bash
# Init first server node
fabrik cluster init --provider local --node <ip> --ssh-key ~/.ssh/id_rsa

# Join additional nodes
fabrik cluster join --kubeconfig <path> --node <ip2>
fabrik cluster join --kubeconfig <path> --node <ip3>

# Scale (Pulumi-managed)
fabrik cluster scale --kubeconfig <path> --nodes 5
```

### Local Development (single-node)

```bash
# macOS: k3d (k3s in Docker)
fabrik cluster init --provider local

# Linux: native k3s
curl -sfL https://get.k3s.io | sh -
fabrik doctor --kubeconfig /etc/rancher/k3s/k3s.yaml
```

---

## Requirements: Disaster Recovery

### What Must Be Recoverable

| Data | Location | Backup Method |
|------|----------|---------------|
| Smithers DBs + reports | PVCs in fabrik-runs | Longhorn snapshots + S3/WebDAV backup |
| Spec/todo JSON | ConfigMaps in fabrik-runs | `fabrik backup` to S3/WebDAV |
| Credentials | Secret in fabrik-system | Manual re-sync via `fabrik credentials sync` |
| Cluster state (etcd) | k3s server node | k3s built-in etcd snapshots |
| LAOS data (metrics, logs) | fabrik-monitoring PVCs | Longhorn snapshots |

### Longhorn Snapshots

Longhorn provides built-in volume snapshots and backup to S3:

```bash
# Configure Longhorn backup target (one-time)
kubectl -n longhorn-system edit settings backup-target
# Set to: s3://fabrik-backups@us-east-1/

# Longhorn automatically creates periodic snapshots
# Configurable per StorageClass or per PVC
```

### Cluster Recovery

```bash
# Restore k3s from etcd snapshot
k3s server --cluster-reset --cluster-reset-restore-path=/path/to/snapshot

# Re-apply fabrik namespaces and secrets
fabrik cluster init --provider local --restore
fabrik credentials sync --kubeconfig <path>

# Restore PVCs from Longhorn backup
# (Longhorn UI or kubectl apply restored PVC manifests)

# Verify
fabrik doctor --kubeconfig <path>
```

### Backup Schedule

```
fabrik backup --kubeconfig <path> --schedule "0 */6 * * *" --target s3://fabrik-backups/
```

Creates a K8s CronJob in fabrik-system that periodically backs up all completed run PVCs.

---

## Requirements: Namespace Strategy

### Namespace Layout

| Namespace | Purpose | Contents |
|-----------|---------|----------|
| `fabrik-system` | Control plane | Secrets, global ConfigMaps, RBAC |
| `fabrik-runs` | Job execution | Jobs, CronJobs, run PVCs, run ConfigMaps |
| `fabrik-monitoring` | Observability (optional) | LAOS stack if in-cluster |
| `fabrik-registry` | Image registry (optional) | Harbor or local registry |

### Multi-Tenancy Consideration (Future)

The namespace split is designed to extend:
- `fabrik-runs-<tenant>` per tenant namespace
- `fabrik-system` remains shared
- NetworkPolicies isolate tenant run namespaces
- ResourceQuotas per tenant namespace
- RBAC: tenant kubeconfig scoped to their run namespace

v1 uses a single user/team — multi-tenancy is a future spec.

### Migration from ralph-system

Existing `ralph-fleet.yaml` and `container.nix` reference `ralph-system`. These are superseded:
- `ralph-system` → `fabrik-system`
- `ralph-fleet.yaml` → replaced by dynamic per-run Job manifests
- `container.nix` telemetry endpoint → `telemetry.fabrik-monitoring.svc.cluster.local`

---

## Requirements: Image Registry

Support flexible image registries:

| Scenario | Registry | How |
|----------|----------|-----|
| Single-node dev | None (direct import) | `k3s ctr images import <tarball>` |
| In-cluster registry | Harbor / distribution | Deploy in `fabrik-registry` namespace |
| External registry | GHCR, Docker Hub, ECR | Configure `imagePullSecrets` |

```bash
# Single-node: direct import (no registry needed)
fabrik images import --kubeconfig <path>

# Push to registry
fabrik images push --registry ghcr.io/myorg --template coding
fabrik images push --registry harbor.internal:5000 --template report

# Configure pull secrets for private registries
fabrik images auth --kubeconfig <path> --registry ghcr.io --username <user> --password <token>
```

---

## Requirements: LAOS Dependency

### Hard Dependency

LAOS (Grafana/Loki/Tempo/Prometheus) is a **hard dependency** for fabrik k3s operations. It is NOT optional.

```
Given: User runs any fabrik command with --kubeconfig
When:  fabrik checks LAOS reachability as part of pre-flight
Then:  If LAOS is unreachable, the command fails with:
       "Error: LAOS telemetry stack is not reachable at <endpoint>.
        Fabrik requires LAOS for observability and alerting.
        Run 'fabrik doctor --kubeconfig <path>' for details."

Exception: fabrik doctor itself does not require LAOS to run (it reports LAOS status).
Exception: fabrik cluster init does not require LAOS (it may be installing it).
```

### LAOS Deployment

LAOS can be deployed:
- **In-cluster**: `fabrik cluster init` includes LAOS in `fabrik-monitoring` namespace
- **External**: user provides endpoints via `fabrik-config` ConfigMap

### Service Discovery

Pods discover LAOS via environment variables set from `fabrik-config` ConfigMap:

```yaml
OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo.fabrik-monitoring.svc.cluster.local:4317"
LOKI_URL: "http://loki.fabrik-monitoring.svc.cluster.local:3100"
PROMETHEUS_URL: "http://prometheus.fabrik-monitoring.svc.cluster.local:9090"
```

---

## Acceptance Criteria

- [ ] `fabrik run --kubeconfig <path> --spec specs/000-base.json --template coding` creates a K8s Job that runs to completion with results persisted in PVC
- [ ] `fabrik schedule --kubeconfig <path> --spec specs/report.json --template report --cron "0 9 * * 1"` creates a CronJob; spawned Jobs produce retrievable results
- [ ] `fabrik runs list --kubeconfig <path>` shows dispatched Jobs and CronJob runs with correct status
- [ ] `fabrik runs show --id <id> --kubeconfig <path>` retrieves Smithers DB from PVC and displays task/review reports
- [ ] Three reference NixOS container images build via `nix build`: `docker-coding`, `docker-report`, `docker-marketing`
- [ ] Custom template `container-<name>.nix` builds and deploys as a usable template
- [ ] A pod that gets killed resumes the workflow on restart via Smithers SQLite on the same PVC
- [ ] Credential rotation via `fabrik credentials rotate` propagates to running pods without restart
- [ ] Rate-limit fallback: pod automatically switches to alternate API key when rate-limited
- [ ] `fabrik runs watch --kubeconfig <path>` sends desktop notification on blocked task
- [ ] Human gate fires alert via Grafana/LAOS paging; `fabrik feedback --kubeconfig` unblocks the pod
- [ ] Results backed up via `fabrik backup --target s3://...` or `webdav://...`
- [ ] Works on single-node k3s (local k3d, Linux native) and multi-node clusters
- [ ] `fabrik cluster init --provider hetzner` provisions a k3s cluster via Pulumi with NixOS image
- [ ] `fabrik cluster join` adds worker nodes to existing cluster
- [ ] `--vm` dispatch shows deprecation warning and suggests --kubeconfig
- [ ] `fabrik runs cancel --id <ulid>` gracefully stops a running Job
- [ ] Longhorn PVCs with SQLite WAL mode survive pod restarts without corruption
- [ ] NetworkPolicy restricts pod egress to HTTPS/SSH/DNS/LAOS only
- [ ] Agent pods run as non-root with no privilege escalation
- [ ] Multi-arch images build for x86_64 and aarch64
- [ ] Disaster recovery: cluster + PVC restore from Longhorn/etcd snapshots works
- [ ] `fabrik doctor` fails with actionable message when LAOS is unreachable
- [ ] `fabrik doctor --kubeconfig <path>` reports cluster readiness including storage, secrets, and images
- [ ] Namespaces `fabrik-system` and `fabrik-runs` are properly separated
- [ ] `fabrik env set --project myapp --env dev --file .env` creates Secret `fabrik-env-myapp-dev` in cluster
- [ ] `fabrik env pull --project myapp --env dev --file .env` downloads cluster env to local file
- [ ] `fabrik run --repo <url> --env dev` validates env exists before dispatch; fails fast with actionable error if missing
- [ ] Environment variables from `fabrik-env-<project>-<env>` are injected into Job pods and available to workflows
- [ ] `fabrik env validate --project myapp --env dev` checks required keys (ANTHROPIC_API_KEY, LAOS_LOKI_URL) are present
- [ ] Per-run env overrides via `--env-var KEY=VALUE` create temporary Secret that is cleaned up after run

---

## Assumptions

- k3s is the target Kubernetes distribution; standard K8s API compatibility means other distros may work but are untested
- NixOS container images can be built with `nix build` on the host (requires Nix with flakes enabled)
- Cluster has sufficient resources (4GB RAM, 2 CPU per job pod — configurable via CLI)
- Network egress from pods to GitHub (for git push) and API providers (Anthropic/OpenAI) is allowed
- `kubectl` is available on the host; if missing, fabrik prints install instructions
- LAOS must be running and reachable; if LAOS health check fails, fabrik commands that need it will fail with an actionable error message rather than silently degrading
- NFS is NOT supported as a storage backend for Smithers SQLite DBs (locking incompatibility)
- CronJob `concurrencyPolicy` defaults to `Forbid` (configurable to `Allow` or `Replace`)
- Smithers SQLite DB on PVC is the source of truth for execution state; host is eventually consistent via reconciliation (per AGENTS.md)
- A persistent storage provisioner is available in the cluster (Longhorn, local-path, or external CSI)
- For Hetzner provisioning: user has a Hetzner Cloud API token and Pulumi installed
- External backup targets (S3/WebDAV) are pre-existing; fabrik does not provision them
- LAOS can run in-cluster or externally; pods are configured to reach whichever is available
- Multiple API keys per provider may be available; the system gracefully degrades through them
- Environment variables for a project/environment are stored as a single Kubernetes Secret (`fabrik-env-<project>-<env>`)
- Required environment variables (`ANTHROPIC_API_KEY`, `LAOS_LOKI_URL`) must be present for successful dispatch
- Projects identify themselves via `--project <id>` or repo URL (which maps to a project ID)
- Environment variables are injected at pod startup; changes require new Job to take effect

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Host Machine                                                               │
│  ├── fabrik CLI (--kubeconfig <path>)                                       │
│  │   ├── fabrik run         → creates K8s Job + PVC in fabrik-runs          │
│  │   ├── fabrik schedule    → creates K8s CronJob in fabrik-runs            │
│  │   ├── fabrik runs        → queries cluster + mirrors DB to host          │
│  │   ├── fabrik feedback    → writes to Smithers DB in pod PVC              │
│  │   ├── fabrik credentials → manages fabrik-credentials Secret             │
│  │   ├── fabrik backup      → copies PVC data to S3/WebDAV                  │
│  │   ├── fabrik images      → build/push/import NixOS container images      │
│  │   ├── fabrik cluster     → provision/join/scale k3s nodes                │
│  │   └── fabrik doctor      → cluster health check                          │
│  │                                                                           │
│  ├── ~/.cache/fabrik/runs/<ulid>/    (mirrored results from cluster)         │
│  └── ~/.cache/fabrik/fabrik.db      (host-side, eventually consistent)      │
├─────────────────────────────────────────────────────────────────────────────┤
│  k3s Cluster (single-node or multi-node)                                    │
│                                                                              │
│  ┌─ fabrik-system ─────────────────────────────────────────────────────┐    │
│  │  Secret: fabrik-credentials (multi-key, rotatable)                  │    │
│  │  ConfigMap: fabrik-config (global settings)                         │    │
│  │  fabrik-api-server (dispatch, cancel, reconcile)                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─ fabrik-runs ───────────────────────────────────────────────────────┐    │
│  │  Job: feature-abc-1707900000                                        │    │
│  │  │  └─ Pod: ralph-coding image                                      │    │
│  │  │     ├── Smithers workflow                                        │    │
│  │  │     ├── PVC: run-<id>-workspace                                  │    │
│  │  │     │   ├── .smithers/*.db (source of truth)                     │    │
│  │  │     │   ├── reports/                                             │    │
│  │  │     │   └── workspace files                                      │    │
│  │  │     ├── heartbeat.json (every 30s)                               │    │
│  │  │     └── /etc/fabrik/credentials/ (mounted Secret, auto-updates)  │    │
│  │  │                                                                   │    │
│  │  CronJob: weekly-report (0 9 * * 1)                                 │    │
│  │  │  └─ spawns Job + PVC per schedule                                │    │
│  │  │                                                                   │    │
│  │  ConfigMap: run-<id>-config (spec.json + todo.json)                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─ fabrik-monitoring (optional) ──────────────────────────────────────┐    │
│  │  LAOS: Grafana / Loki / Tempo / Prometheus                         │    │
│  │  AlertManager → PagerDuty / Zulip (human gate paging)               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─ fabrik-registry (optional) ────────────────────────────────────────┐    │
│  │  Harbor / distribution (in-cluster image registry)                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Pod templates (NixOS container images):                                    │
│  ├── ralph-coding    (agents + dev tools + jj)                              │
│  ├── ralph-report    (+ texlive + pandoc + typst)                           │
│  ├── ralph-marketing (+ social-media CLIs)                                  │
│  └── ralph-<custom>  (user-defined)                                         │
│                                                                              │
│  Storage: Longhorn (primary) / local-path (dev only) — NFS prohibited       │
│  Backup:  S3-compatible / WebDAV (Nextcloud)                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  Infrastructure (Hetzner / bare metal / other)                              │
│                                                                              │
│  Provisioned via: Pulumi + NixOS k3s images                                 │
│  ├── k3s server node (NixOS, control plane)                                 │
│  ├── k3s agent node 1 (NixOS, worker)                                       │
│  ├── k3s agent node 2 (NixOS, worker)                                       │
│  └── ... (scale via fabrik cluster scale / pulumi up)                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Nix Module Extension

### Per-Template Container Variants

```nix
# nix/hosts/container-coding.nix    → imports ralph.nix as-is (current container.nix)
# nix/hosts/container-report.nix    → imports ralph.nix + texlive, pandoc, typst
# nix/hosts/container-marketing.nix → imports ralph.nix + social-media CLIs
# nix/hosts/container-<custom>.nix  → user-defined, imports ralph.nix + custom pkgs
```

### k3s Node Images

```nix
# nix/hosts/k3s-node.nix → NixOS with k3s pre-installed
# Configurable: server vs agent role, join token, cluster CIDR
```

### Flake Output Extension

```nix
packages.<system> = {
  # Container images (existing docker target split into templates)
  docker-coding    = nixos-generators ... container-coding.nix;
  docker-report    = nixos-generators ... container-report.nix;
  docker-marketing = nixos-generators ... container-marketing.nix;

  # k3s node images
  k3s-server = nixos-generators ... k3s-node.nix { role = "server"; };
  k3s-agent  = nixos-generators ... k3s-node.nix { role = "agent"; };

  # Cloud images for k3s nodes
  k3s-hetzner = nixos-generators ... k3s-node.nix { format = "raw"; };
};
```

### Multi-Architecture Images

All container images MUST be built for both architectures:

```bash
# Build for both architectures
nix build .#packages.x86_64-linux.docker-coding
nix build .#packages.aarch64-linux.docker-coding

# Push multi-arch manifest
fabrik images push --registry ghcr.io/myorg --template coding --multi-arch
```

The `fabrik images push --multi-arch` flag:
1. Builds for both `x86_64-linux` and `aarch64-linux`
2. Pushes both images with architecture-specific tags
3. Creates a multi-arch manifest list pointing to both
4. Tags the manifest as `<registry>/<image>:<tag>`

This ensures clusters with mixed node architectures can schedule pods on any node.

---

## Relation to Existing Code

| Existing | K8s Equivalent | Notes |
|----------|----------------|-------|
| `dispatch.ts` (SSH/limactl) | `k8s-dispatch.ts` (kubectl) | Supersedes VM dispatch |
| `orchestrate.ts` (poll VMs) | `k8s-reconcile.ts` (kubectl get) | K8s status is authoritative |
| `reconcile.ts` (stale PID) | K8s Job status + heartbeat | K8s does most of this natively |
| `vm-utils.ts` (VM IP) | Not needed | K8s handles networking |
| `credentials.ts` (SSH copy) | `k8s-credentials.ts` (Secret CRUD) | kubectl create/patch secret |
| `fleet.ts` (multi-VM) | Multiple Jobs in fabrik-runs | K8s scheduler handles placement |
| `nix/k8s/ralph-fleet.yaml` | Generated per-run manifests | Dynamic, not static |
| `nix/hosts/container.nix` | Split into per-template variants | Template-specific packages |
| `Cli.ts` (--vm flags) | `--kubeconfig` flags + API server client | --vm deprecated |
| (new) | `infra/pulumi/` | Cluster provisioning |
| (new) | `nix/hosts/k3s-node.nix` | k3s node NixOS image |
