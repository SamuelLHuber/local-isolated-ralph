# Telemetry Setup

This directory contains the telemetry stack for observing your Ralph agents and applications under test.

## Prerequisites

**Docker must be installed on your host machine** to run the telemetry stack:

```bash
# Verify Docker is installed and running
docker --version
docker ps

# If not installed:
# macOS: brew install docker && brew install --cask docker
# Linux: sudo apt-get install docker.io docker-compose
```

## Port Conflicts

The telemetry stack uses these ports. Check they're free before starting:

```bash
# Check for port conflicts
for port in 3000 3100 3200 4317 4318 9090; do
  lsof -i :$port && echo "WARNING: Port $port in use"
done
```

| Port | Service | Common Conflicts |
|------|---------|------------------|
| 3000 | Grafana | React dev server, other dashboards |
| 3100 | Loki | - |
| 3200 | Tempo | - |
| 4317 | OTLP gRPC | Other OTEL collectors |
| 4318 | OTLP HTTP | Other OTEL collectors |
| 9090 | Prometheus | Other Prometheus instances |

To use different ports, edit `docker-compose.yml` and update the port mappings.

---

## Telemetry Options

| Option | Best For | VM Resources | Setup Complexity |
|--------|----------|--------------|------------------|
| **Host cluster** (recommended) | Most users | Lightweight | Medium |
| Full in-VM | Air-gapped / paranoid isolation | Heavy (~8GB+) | Medium |
| All cloud | Minimal local resources | Minimal | Easy |

---

## Option 1: Host Cluster (Recommended)

Run the telemetry stack on your host machine. VMs connect to it via network.

### Start the stack

```bash
cd /path/to/wisp/telemetry
docker-compose up -d
```

### Verify it's running

```bash
# Check containers
docker ps | grep wisp

# Test endpoints
curl http://localhost:3000/api/health    # Grafana
curl http://localhost:9090/-/healthy     # Prometheus
curl http://localhost:3100/ready         # Loki
curl http://localhost:3200/ready         # Tempo
```

### Access Grafana

Open http://localhost:3000 (login: admin/admin)

---

## Networking: VM to Host Connection

This is the critical part. Your agent running inside the VM needs to send telemetry to the host.

### macOS (Colima)

Inside Colima VMs, use different addresses depending on context:

```bash
# When SSH'd directly into the Lima VM:
HOST_IP="host.lima.internal"

# When inside a Docker container running in Colima:
HOST_IP="host.docker.internal"

# Test connectivity (from SSH)
curl http://host.lima.internal:3000/api/health
```

**Environment variables for your app:**

```bash
# For apps running directly in VM (not in container)
export OTEL_EXPORTER_OTLP_ENDPOINT="http://host.lima.internal:4317"
export LOKI_URL="http://host.lima.internal:3100"

# For apps running in Docker containers inside VM
export OTEL_EXPORTER_OTLP_ENDPOINT="http://host.docker.internal:4317"
export LOKI_URL="http://host.docker.internal:3100"
```

### Linux (libvirt/QEMU)

The host IP depends on your network setup:

```bash
# Default libvirt NAT network (virbr0)
# Host is typically at 192.168.122.1
HOST_IP="192.168.122.1"

# Find your host IP from inside VM:
ip route | grep default | awk '{print $3}'

# Or check the gateway
cat /etc/resolv.conf  # Sometimes points to host
```

**To make it reliable, add to VM's /etc/hosts:**

```bash
# Inside VM, as root:
echo "192.168.122.1 host.docker.internal" >> /etc/hosts
```

**Environment variables:**

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://192.168.122.1:4317"
export LOKI_URL="http://192.168.122.1:3100"
```

### Verify from VM

Run these inside your VM to confirm connectivity:

```bash
# Test Grafana
curl -s http://${HOST_IP}:3000/api/health | jq .

# Test Loki (push a test log)
curl -X POST "http://${HOST_IP}:3100/loki/api/v1/push" \
  -H "Content-Type: application/json" \
  -d '{"streams":[{"stream":{"job":"test"},"values":[["'$(date +%s)000000000'","hello from VM"]]}]}'

# Test Tempo (check ready)
curl http://${HOST_IP}:3200/ready
```

---

## Sending Telemetry from Your App

### OpenTelemetry (traces + metrics)

Most languages have OTEL SDKs. Example for Node.js:

```javascript
// tracing.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://host.docker.internal:4317',
  }),
});
sdk.start();
```

### Logs to Loki

Using promtail, or direct HTTP push:

```bash
# Simple log push from shell
send_log() {
  local msg="$1"
  local ts=$(date +%s)000000000
  curl -s -X POST "${LOKI_URL:-http://host.docker.internal:3100}/loki/api/v1/push" \
    -H "Content-Type: application/json" \
    -d "{\"streams\":[{\"stream\":{\"job\":\"ralph\",\"vm\":\"$(hostname)\"},\"values\":[[\"$ts\",\"$msg\"]]}]}"
}

send_log "Agent starting iteration 42"
```

### Sentry (errors)

```bash
export SENTRY_DSN="https://xxx@xxx.ingest.sentry.io/xxx"
```

Or self-hosted Sentry (heavy, ~4GB RAM):
```bash
# See https://develop.sentry.dev/self-hosted/
```

### PostHog (product analytics)

```bash
export POSTHOG_API_KEY="phc_xxx"
export POSTHOG_HOST="https://app.posthog.com"  # or self-hosted
```

---

## Option 2: Full In-VM Setup

Run everything inside the VM. Useful for fully air-gapped setups.

```bash
# Inside VM
cd /path/to/wisp/telemetry
docker-compose up -d

# Now use localhost instead of host.docker.internal
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export LOKI_URL="http://localhost:3100"
```

**Pros:** Complete isolation, no host dependencies
**Cons:** Heavy (~4GB+ RAM for stack), lost when VM is deleted

---

## Option 3: All Cloud

Use managed services. Lightest VM footprint.

### Grafana Cloud (free tier)

1. Sign up at https://grafana.com/products/cloud/
2. Get your endpoints from the portal:
   - Prometheus remote write URL
   - Loki push URL
   - Tempo OTLP endpoint

```bash
export GRAFANA_CLOUD_PROMETHEUS_URL="https://prometheus-xxx.grafana.net/api/prom/push"
export GRAFANA_CLOUD_LOKI_URL="https://logs-xxx.grafana.net/loki/api/v1/push"
export GRAFANA_CLOUD_TEMPO_URL="https://tempo-xxx.grafana.net:443"
export GRAFANA_CLOUD_API_KEY="xxx"
```

### Sentry Cloud

1. Sign up at https://sentry.io
2. Create a project, get DSN

```bash
export SENTRY_DSN="https://xxx@xxx.ingest.sentry.io/xxx"
```

### PostHog Cloud

1. Sign up at https://posthog.com
2. Get API key from project settings

```bash
export POSTHOG_API_KEY="phc_xxx"
export POSTHOG_HOST="https://app.posthog.com"
```

---

## Ports Reference

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| Grafana | 3000 | HTTP | Dashboards |
| Prometheus | 9090 | HTTP | Metrics query |
| Loki | 3100 | HTTP | Log ingestion & query |
| Tempo | 3200 | HTTP | Trace query API |
| Tempo | 4317 | gRPC | OTLP trace ingestion |
| Tempo | 4318 | HTTP | OTLP trace ingestion |

---

## Troubleshooting

### Can't connect from VM to host

```bash
# 1. Check host firewall isn't blocking
# macOS: System Preferences > Security > Firewall
# Linux: sudo ufw status / sudo iptables -L

# 2. Verify the stack is listening on 0.0.0.0, not 127.0.0.1
docker ps
netstat -tlnp | grep 3000

# 3. Test with nc
nc -zv ${HOST_IP} 3000
```

### Logs not appearing in Grafana

```bash
# Check Loki is receiving
curl "http://${HOST_IP}:3100/loki/api/v1/labels"

# Check your log stream exists
curl "http://${HOST_IP}:3100/loki/api/v1/query?query={job=\"ralph\"}"
```

### Traces not appearing

```bash
# Check Tempo is healthy
curl http://${HOST_IP}:3200/ready

# Verify OTLP endpoint
curl -X POST http://${HOST_IP}:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[]}'
# Should return {} on success
```
