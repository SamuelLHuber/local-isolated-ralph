# Command skeletons

Replace placeholders:
- `<KUBECONFIG>`
- `<NS>`
- `<RUN_ID_OR_PREFIX>`
- `<JOB>`
- `<PVC>`

## Discover runs

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> get jobs,pods,pvc
kubectl --kubeconfig <KUBECONFIG> -n <NS> get job <JOB> -o yaml
kubectl --kubeconfig <KUBECONFIG> -n <NS> describe job <JOB>
```

## Logs

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> logs job/<JOB> -c fabrik --tail=300
kubectl --kubeconfig <KUBECONFIG> -n <NS> logs pod/<POD> -c fabrik --tail=300
```

## Create temporary PVC inspector pod

Python image (good for SQLite querying):

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> run pvc-inspect-<ID> \
  --image=python:3.12-alpine --restart=Never \
  --overrides='{"apiVersion":"v1","spec":{"volumes":[{"name":"ws","persistentVolumeClaim":{"claimName":"<PVC>"}}],"containers":[{"name":"inspect","image":"python:3.12-alpine","command":["sleep","3600"],"volumeMounts":[{"name":"ws","mountPath":"/workspace"}]}]}}'

kubectl --kubeconfig <KUBECONFIG> -n <NS> wait --for=condition=Ready pod/pvc-inspect-<ID> --timeout=120s
```

Runtime image (good for jj/git parity):

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> run pvc-inspect-runtime-<ID> \
  --image=<RUN_IMAGE_DIGEST> --restart=Never \
  --overrides='{"apiVersion":"v1","spec":{"volumes":[{"name":"ws","persistentVolumeClaim":{"claimName":"<PVC>"}}],"containers":[{"name":"inspect","image":"<RUN_IMAGE_DIGEST>","command":["sleep","3600"],"volumeMounts":[{"name":"ws","mountPath":"/workspace"}]}]}}'
```

## Workspace inspection

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> exec pvc-inspect-<ID> -- sh -lc 'ls -la /workspace'
kubectl --kubeconfig <KUBECONFIG> -n <NS> exec pvc-inspect-<ID> -- sh -lc 'find /workspace/.smithers -maxdepth 4 -type f | head -n 100'
kubectl --kubeconfig <KUBECONFIG> -n <NS> exec pvc-inspect-<ID> -- sh -lc 'tail -n 80 /workspace/.smithers/executions/<RUN_ID>/logs/stream.ndjson'
```

## Cleanup

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> delete pod pvc-inspect-<ID> pvc-inspect-runtime-<ID> --ignore-not-found
```
