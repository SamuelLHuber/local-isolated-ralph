# Spec: k3s-local-testing

> Local + CI Kubernetes testing for fabrik using k3d (k3s-in-Docker)

**Status**: draft  
**Version**: 1.1.0  
**Last Updated**: 2026-03-17  
**Provides**: Repeatable local/CI test environments for single-node and multi-node Kubernetes setups

---

## Changelog

- **v1.0.0** (2026-02-25): Initial spec for k3d-based local and CI testing
- **v1.1.0** (2026-03-17): Added shared-credential bundle and rotation verification requirements

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

### 5. Shared Credential Verification Requirements

Credential behavior is part of the local cluster contract and must be verified explicitly.

At minimum, k3d verification must cover:

1. **Cluster-shared env-style credentials**
   - a job consumes a cluster-default shared key
   - a replaced cluster Secret changes the effective key for the next job
   - an explicit run-scoped override suppresses the cluster default for that target

2. **Cluster-shared file bundles**
   - a job consumes a mounted directory bundle for a harness such as Codex, Claude Code, or Pi
   - the bundle is mounted as a directory, not `subPath`
   - replacing the underlying cluster Secret changes the visible bundle contents

3. **Running-job refresh visibility**
   - a long-running job that re-reads the mounted directory can observe updated cluster-backed credentials without pod recreation
   - this proof applies only to cluster-backed bundles, not fixed local imports

4. **Harness/helper separation**
   - Fabrik verifies mount layout, mirroring, override suppression, and update visibility
   - helper-level tests verify provider-specific pool rotation and failure classification

5. **Adjacent config**
   - non-credential adjacent config such as Pi `models.json` is tested separately from shared credential bundles
   - tests must prove that adjacent config can coexist with the mounted auth bundle without collapsing the separation of concerns

### 6. CI Pipeline Shape (GitHub Actions)

```
1. Spin cluster (k3d)
2. Install platform dependencies (ingress, cert-manager, storage, etc.)
3. Build + push images to local registry
4. helm upgrade --install fabrik charts
5. Run integration tests (HTTP, DB, events, logs)
6. Tear down cluster
```

### 7. Local Developer Workflow

```
# Single-node, fast
scripts/k3d/cluster.sh create single dev-single
scripts/k3d/cluster.sh verify single dev-single

# Multi-node
scripts/k3d/cluster.sh create multi dev-multi
scripts/k3d/cluster.sh verify multi dev-multi

# Optional: override local registry port
K3D_REGISTRY_PORT=5112 scripts/k3d/cluster.sh create single dev-single

# Install platform charts (optional)
helm upgrade --install platform ./charts/platform -f values/dev.yaml

# Install fabrik
helm upgrade --install fabrik ./charts/fabrik -f values/dev.yaml
```

If the name is omitted, `single` uses `dev-single` with registry port `5111`, and `multi` uses `dev-multi` with registry port `5112`.

### 8. Linux + macOS Compatibility

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
7. k3d verification proves cluster-shared credential replacement for both new jobs and running jobs using directory-mounted bundles.
8. k3d verification proves explicit run-scoped credential overrides suppress cluster defaults for the same target.
9. k3d verification covers both env-style shared credentials and file-bundle shared credentials.

---

## Assumptions

- Docker is available on developer machines and CI runners
- Helm charts exist for platform + fabrik workloads
- Chart testing configuration (`ct.yaml`) is maintained

---

## Glossary

- **k3d**: k3s running inside Docker, used for fast local clusters
- **ct**: Helm chart-testing tool
