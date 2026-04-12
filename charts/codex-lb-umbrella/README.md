# codex-lb umbrella chart (canonical Fabrik source)

This chart is the canonical codex-lb deployment config for this repo.

It wraps the upstream chart and pins the version:
- Upstream chart: `oci://ghcr.io/soju06/charts/codex-lb`
- Upstream project: https://github.com/Soju06/codex-lb

## Why umbrella

- Keep cluster-specific values in this repo.
- Pin upstream chart version for reproducibility.
- Avoid git submodule maintenance overhead.

## Files

- `Chart.yaml`: pinned upstream dependency
- `values.yaml`: canonical non-secret defaults
- `values-cluster.yaml`: example cluster non-secret overrides

## Secret handling (required)

Do **not** commit secrets to this repo.

Create a local untracked file, for example:
`charts/codex-lb-umbrella/values-cluster.secrets.yaml`

Example:

```yaml
codex-lb:
  postgresql:
    auth:
      password: "<set-me>"
  auth:
    dashboardBootstrapToken: "<set-me>"
```

If you manage `auth.existingSecret` / external secrets, use that instead and keep secrets fully out of values files.

To migrate an existing cluster without committing secrets, read current live values and copy only secret fields into your local secrets file:

```bash
helm --kubeconfig ~/.kube/<cluster> get values codex-lb -n codex-lb -o yaml
```

## Sync dependencies

```bash
helm dependency update charts/codex-lb-umbrella
```

## Deploy to a cluster

```bash
helm dependency build charts/codex-lb-umbrella

helm upgrade --install codex-lb charts/codex-lb-umbrella \
  --namespace codex-lb \
  --create-namespace \
  -f charts/codex-lb-umbrella/values.yaml \
  -f charts/codex-lb-umbrella/values-cluster.yaml \
  -f charts/codex-lb-umbrella/values-cluster.secrets.yaml \
  --kubeconfig ~/.kube/<cluster> \
  --atomic
```

## Verify

```bash
helm --kubeconfig ~/.kube/<cluster> -n codex-lb list
kubectl --kubeconfig ~/.kube/<cluster> -n codex-lb get deploy,sts,svc
```
