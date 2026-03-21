# Fabrik 

Fabrik runs as k3s-native Jobs/CronJobs with k3d for local/CI testing.

## Start Here

- Specs live in `specs/`.
- Active Kubernetes specs start at 05X.
- Local/CI testing is k3d-only (`specs/057-k3s-local-testing.md`).

## Key Specs

- `specs/050-k3s-infrastructure.md`
- `specs/051-k3s-orchestrator.md`
- `specs/052-k3s-orchestrator-dashboard.md`
- `specs/057-k3s-local-testing.md`
- `specs/060-security-hardening.md`
- `specs/061-incluster-optimizer.md`
- `specs/062-fabrik-laos-lint.md`
- `specs/063-benchmark-system.md`

## Notes

- Labels/annotations use the `fabrik.sh` domain (see `specs/051-k3s-orchestrator.md`).

## Getting Started

To test smithers for running workflows like coding a simple hello world page locally see `examples/hello-world-local/README.md`.

For the compiled `fabrik` CLI install path and release artifact names, see [`src/fabrik-cli/docs/getting-started.md`](/Users/samuel/git/local-isolated-ralph/src/fabrik-cli/docs/getting-started.md).

For the published workflow runtime package, see [`src/fabrik-runtime/README.md`](/Users/samuel/git/local-isolated-ralph/src/fabrik-runtime/README.md) and npm package `@dtechvision/fabrik-runtime`.

## Releasing

`fabrik` v0.1.0 is distributed through GitHub Releases.

- Release automation lives in [`.github/workflows/release.yml`](/Users/samuel/git/local-isolated-ralph/.github/workflows/release.yml).
- Trigger a release by pushing a tag in the form `v0.1.0`, or by running the workflow manually and supplying the same tag format in the `tag` input.
- The release workflow publishes the compiled `fabrik-*` binaries plus `fabrik-sha256.txt`.
- `fabrik version` should report the release version embedded from that tag, for example `0.1.0` for the `v0.1.0` release.

## Local Testing

For local testing use [k3d](https://k3d.io).

### Single Node

Create the single node k3s cluster with k3d locally

```bash
scripts/k3d/cluster.sh create single dev-single
scripts/k3d/cluster.sh verify single dev-single
```

### Multi Node

Create the multi-node k3s cluster (1 server + 2 agents)

```bash
scripts/k3d/cluster.sh create multi dev-multi
scripts/k3d/cluster.sh verify multi dev-multi
```

then check it works with 

```
k3d kubeconfig get dev-multi > /tmp/fabrik-dev-multi.kubeconfig
KUBECONFIG=/tmp/fabrik-dev-multi.kubeconfig kubectl cluster-info
KUBECONFIG=/tmp/fabrik-dev-multi.kubeconfig kubectl get nodes
```

To clean up

```
scripts/k3d/cluster.sh delete dev-single
scripts/k3d/cluster.sh delete dev-multi
```

If you omit the cluster name, `single` defaults to `dev-single` and `multi` defaults to `dev-multi`.
The default registry ports are `5111` for `single` and `5112` for `multi`, so both example clusters can run at the same time.
