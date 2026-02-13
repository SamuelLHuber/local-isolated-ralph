# Observability & Analytics for Coding Agents

Ralph uses **LAOS** (Local Analytics and Observability Stack) as the shared telemetry backend. This guide covers setup, querying, and troubleshooting.

**LAOS Repository:** https://github.com/dtechvision/laos

## Quick Start

### 1. Start LAOS on the Host

```bash
mkdir -p ~/git
if [[ -d ~/git/laos/.git ]]; then
  (cd ~/git/laos && git pull)
else
  git clone https://github.com/dtechvision/laos.git ~/git/laos
fi
cd ~/git/laos && ./scripts/laos-up.sh
```

### 2. Configure Ralph Environment

```bash
cd /path/to/local-isolated-ralph
./scripts/create-ralph-env.sh
```

Edit `~/.config/ralph/ralph.env`:

```bash
# macOS (Lima): export LAOS_HOST="host.lima.internal"
# Linux (libvirt): export LAOS_HOST="192.168.122.1"
export LAOS_HOST="<your-host>"

# Telemetry endpoints
export OTEL_EXPORTER_OTLP_ENDPOINT="http://${LAOS_HOST}:4317"
export LOKI_URL="http://${LAOS_HOST}:3100"
export SENTRY_DSN="http://<key>@${LAOS_HOST}:9000/1"
export POSTHOG_HOST="http://${LAOS_HOST}:8001"
export POSTHOG_API_KEY="phc_xxx"
export PYROSCOPE_SERVER_ADDRESS="http://${LAOS_HOST}:4040"
```

> **Platform Selection:** Set `LAOS_PLATFORM=linux/arm64` for Apple Silicon or ARM64 Linux. Default is `linux/amd64`.

### 3. Sync to VMs

```bash
./scripts/sync-credentials.sh ralph-1
# or: fabrik credentials sync --vm ralph-1
```

### 4. Access Dashboards

| Service | URL | Credentials |
|---------|-----|-------------|
| Grafana | http://localhost:3010 | admin/admin |
| Sentry | http://localhost:9000 | Create on first run |
| PostHog | http://localhost:8001 | Setup wizard |
| Pyroscope | http://localhost:4040 | None |
| Prometheus | http://localhost:9090 | None |

## Query Reference

### Health Checks

```bash
curl http://$LAOS_HOST:3100/ready  # Loki
curl http://$LAOS_HOST:3200/ready  # Tempo
curl http://$LAOS_HOST:9090/-/ready  # Prometheus
curl http://$LAOS_HOST:4040/ready  # Pyroscope
curl -I http://localhost:8001  # PostHog (expect 302/200)
```

### Query Patterns by Tool

| Tool | URL/Endpoint | Example Query | Filters/Labels |
|------|-------------|---------------|----------------|
| **Loki** | `:3100` | `{service_name="smithers"} \|= "ERROR"` | `vm`, `trace_id`, `level` |
| **Tempo** | `:4318` | Search by trace ID or `vm=ralph-1` | `service.name`, `task` |
| **Prometheus** | `:9090` | `rate(http_requests_total[5m])` | `job`, `status`, `vm` |
| **Pyroscope** | `:4040` | Flame graph: `process_cpu` | `spec_id`, `vm`, `agent_type` |
| **Sentry** | `:9000` | Issues → Stack trace + breadcrumbs | `trace_id` → links to Tempo |
| **PostHog** | `:8001` | Events → Real-time stream | `distinct_id`, `source` |

### Detailed Query Examples

**Loki (Logs):**
```logql
# All Smithers logs
{service_name="smithers"}

# Errors only
{service_name="smithers"} |= "ERROR"

# Specific VM
{service_name="smithers", vm="ralph-1"}

# Parse JSON
{service_name="smithers"} | json | line_format "{{.level}}: {{.message}}"
```

**Prometheus (Metrics):**
```promql
# Service health
up{job="agent-metrics"}

# Request rate
rate(http_requests_total{job="smithers"}[5m])

# Error rate
rate(http_requests_total{status=~"5.."}[5m])

# P95 latency
histogram_quantile(0.95, rate(task_duration_seconds_bucket[5m]))
```

**Pyroscope (Profiles):**
1. **View:** Select app → profile type (`process_cpu`, `memory`, `wall`)
2. **Compare:** Select two time ranges → "Compare" → diff flame graph
3. **Correlate:** In Tempo trace, click span → "View Profile"

**Sentry (Headless verification):**
```bash
EVENT_ID=$(uuidgen | tr -d '-' | tr 'A-Z' 'a-z')
DSN="http://YOUR_KEY@localhost:9000/2"
printf '{"event_id":"%s"}\n{"type":"event"}\n{"message":"test","level":"error"}\n' \
  "$EVENT_ID" > /tmp/envelope.txt
curl -X POST "http://localhost:9000/api/2/envelope/" \
  -H "Content-Type: application/x-sentry-envelope" \
  --data-binary @/tmp/envelope.txt
```

## Smithers Integration

### Effect-TS Observability Layer

```typescript
import * as Otlp from "@effect/opentelemetry/Otlp"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"

export const OtlpLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const otlpEndpoint = yield* Config.string("OTLP_ENDPOINT").pipe(
      Config.orElse(() => Config.succeed("http://localhost:4318")),
    )
    const serviceName = yield* Config.string("SERVICE_NAME").pipe(
      Config.orElse(() => Config.succeed("ralph-agent")),
    )
    return Otlp.layer({
      baseUrl: otlpEndpoint,
      resource: { serviceName, attributes: { "deployment.environment": "development" } },
    }).pipe(Layer.provide(NodeHttpClient.layerUndici))
  }),
)
```

### Task Instrumentation

```typescript
const instrumentedTask = Effect.gen(function* () {
  yield* Effect.logInfo("Starting task")
  const result = yield* processTask()
  yield* Metric.counter("tasks_completed").pipe(Metric.increment)
  return result
}).pipe(Effect.withSpan("task-execution", { attributes: { task_id: "001", vm: "ralph-1" } }))
```

### Profiling with Labels

```typescript
export const handleSpecRun = (spec: string) =>
  Effect.gen(function* () {
    const profiling = yield* Profiling
    return yield* profiling.withLabels(
      { spec_id: spec, vm: process.env.VM_NAME || "unknown" },
      Effect.promise(() => runSmithersWorkflow(spec)),
    )
  })
```

## Troubleshooting

### No Telemetry Appearing

```bash
# 1. Verify LAOS is running
cd ~/git/laos && docker compose ps

# 2. Check service health
curl http://$LAOS_HOST:3100/ready  # Loki, etc.

# 3. Check LAOS_HOST (macOS: host.lima.internal, Linux: 192.168.122.1)

# 4. Sync credentials
./scripts/sync-credentials.sh ralph-1

# 5. Test from inside VM
limactl shell ralph-1
curl http://$LAOS_HOST:3100/ready
```

### Root Cause Analysis Flow

```
Grafana Dashboard → "Error rate spike"
       ↓
Sentry → "NullReferenceException in auth.ts:42"
       ↓
Tempo Trace → DB call span = 5s
       ↓
Loki Logs → "Connection timeout to postgres"
       ↓
Pyroscope → CPU saturated on connection pool
```

All signals linked by `trace_id` and `span_id`.

### Common Issues

| Issue | Solution |
|-------|----------|
| macOS ARM64 platform errors | `softwareupdate --install-rosetta --agree-to-license` |
| Port conflicts | `lsof -i :3010 :9000 :8001` |
| PostHog slow startup | Normal, wait for `curl -I localhost:8001` to return 302 |
| Reset everything | `docker compose down -v && docker compose up -d` |

## Further Reading

- **LAOS Repository:** https://github.com/dtechvision/laos
- **LAOS Setup Guide:** `~/git/laos/SETUP-LAOS.md`
- **Effect + Telemetry:** `~/git/laos/examples/observability-layer.ts`
- **Profiling:** `~/git/laos/PYROSCOPE.md`
