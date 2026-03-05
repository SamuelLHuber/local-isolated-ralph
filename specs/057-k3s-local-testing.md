# Spec: k3s-local-testing

> Local + CI Kubernetes testing for fabrik using k3d (k3s-in-Docker)

**Status**: draft  
**Version**: 1.0.0  
**Last Updated**: 2026-02-25  
**Provides**: Repeatable local/CI test environments for single-node and multi-node Kubernetes setups

---

## Changelog

- **v1.0.0** (2026-02-25): Initial spec for k3d-based local and CI testing

---

## Identity

**What**: A standardized way to spin up disposable Kubernetes clusters locally and in CI to validate fabrik behavior across:
1. **Single-node** (1 control-plane) for fast iteration
2. **Multi-node** (1 control-plane + N agents) for scheduling, networking, and storage behavior

**Why**:
- k3d matches our k3s production baseline with minimal overhead.
- k3d supports multi-node and local registries without external pushes.

**Not**:
- Replacing production k3s provisioning (see `specs/050-k3s-infrastructure.md`)
- A new dependency policy exception (no new dependencies without explicit approval)

---

## Goals

1. **Fast iteration**: local dev can spin a cluster in < 2 minutes
2. **CI parity**: ephemeral cluster per pipeline job
3. **k3s fidelity**: primary path uses k3d to match production
4. **No remote registry**: local registry for image distribution (required)
5. **Consistent test layers**: lint, install, integration, optional E2E
6. **Cross-platform**: support macOS and Linux (Docker-based)

---

## Design Principles

This spec follows the design principles defined in `specs/051-k3s-orchestrator.md`.

---

## Non-Goals

- Replacing e2e tests against real cloud clusters
- Performance benchmarking at production scale
- Long-lived local clusters (clusters are disposable)

---

## Requirements

### 1. Cluster Shapes

**Single-node (default, fast)**:
- 1 server, 0 agents
- Used for template/helm install tests and smoke tests

**Multi-node (standard)**:
- 1 server, 2 agents (configurable)
- Used for scheduling, taints, PDBs, storage replication, and node affinity

### 2. Tooling Defaults

**Default**: k3d

**k3d rationale**:
- Uses k3s in Docker, fast and light
- Easy local registry integration
- Mirrors production k3s behavior

### 3. Image Flow (Local Registry Required)

**k3d local registry** (required for CI and default for local):
```
k3d cluster create ci \
  --agents 2 \
  --registry-create ci-registry:0.0.0.0:5111 \
  -p "8080:80@loadbalancer"

docker build -t localhost:5111/fabrik-app:${GIT_SHA} .
docker push localhost:5111/fabrik-app:${GIT_SHA}
```

**Helm values for k3d**:
- `image.repository` must point to the local registry (e.g., `localhost:5111/fabrik-app`)
- `image.tag` should be the CI build tag (or digest)
- `imagePullPolicy: IfNotPresent` for local runs to avoid remote pulls

### 4. Test Layers

1. **Static / Template** (no cluster)
   - `helm lint`
   - `ct lint` (chart-testing)
   - Optional: `helm unittest` (template assertions)

2. **Live Chart Install** (cluster)
   - `ct install --config ct.yaml`
   - Validates charts install and reach Ready state

3. **Integration** (cluster)
   - `kubectl wait` on deployments/jobs
   - Health endpoints via port-forward or LoadBalancer
   - Validate logs, database migrations, and required config

4. **Optional E2E**
   - Full system tests, only on merge or nightly

### 5. CI Pipeline Shape (GitHub Actions)

```
1. Spin cluster (k3d)
2. Install platform dependencies (ingress, cert-manager, storage, etc.)
3. Build + push images to local registry
4. helm upgrade --install fabrik charts
5. Run integration tests (HTTP, DB, events, logs)
6. Tear down cluster
```

### 6. Local Developer Workflow

```
# Single-node, fast
scripts/k3d/cluster.sh create single dev
scripts/k3d/cluster.sh verify single dev

# Multi-node
scripts/k3d/cluster.sh create multi dev
scripts/k3d/cluster.sh verify multi dev

# Optional: override local registry port
K3D_REGISTRY_PORT=5112 scripts/k3d/cluster.sh create single dev

# Install platform charts (optional)
helm upgrade --install platform ./charts/platform -f values/dev.yaml

# Install fabrik
helm upgrade --install fabrik ./charts/fabrik -f values/dev.yaml
```

### 7. Linux + macOS Compatibility

- **Linux**: Docker-based k3d
- **macOS**: Docker Desktop + k3d
- No host-specific assumptions in scripts (avoid Linux-only paths)

---

## Acceptance Criteria

1. A developer can run a single command to create a single-node k3d cluster.
2. A developer can run a single command to create a multi-node k3d cluster (1 server + 2 agents).
3. CI can build and load images without pushing to a remote registry.
4. `ct install` works against the ephemeral cluster.
5. Integration tests can reach the service endpoints.
6. Both macOS and Linux paths are documented and tested.

---

## Assumptions

- Docker is available on developer machines and CI runners
- Helm charts exist for platform + fabrik workloads
- Chart testing configuration (`ct.yaml`) is maintained

---

## Glossary

- **k3d**: k3s running inside Docker, used for fast local clusters
- **ct**: Helm chart-testing tool
