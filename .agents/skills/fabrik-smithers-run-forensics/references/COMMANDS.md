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

## Pod restart/replacement triage

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> get pods -o wide
kubectl --kubeconfig <KUBECONFIG> -n <NS> describe pod <POD>
kubectl --kubeconfig <KUBECONFIG> -n <NS> describe pod <POD> | grep -A8 -E 'Last State|Reason|Events:'
```

If restarts replaced earlier pods/logs, pivot to PVC + Smithers DB + remote branch checks.

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

## Agent config debugging (discover/init failures)

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> exec <POD> -c fabrik -- sh -lc 'env | grep -E "AGENT_TYPE|PI_|CODEX_"'
kubectl --kubeconfig <KUBECONFIG> -n <NS> exec <POD> -c fabrik -- sh -lc 'test -n "$PI_CODING_AGENT_DIR" && ls -la "$PI_CODING_AGENT_DIR" && ls -la "$PI_CODING_AGENT_DIR/models.json"'
```

## Optional mergeability precheck (repo in workspace)

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> exec pvc-inspect-<ID> -- sh -lc 'cd /workspace/repo && git fetch origin main && git merge-tree $(git merge-base HEAD origin/main) origin/main HEAD'
```

## Cleanup

```bash
kubectl --kubeconfig <KUBECONFIG> -n <NS> delete pod pvc-inspect-<ID> pvc-inspect-runtime-<ID> --ignore-not-found
```
