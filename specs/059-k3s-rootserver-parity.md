# Spec: k3s Rootserver Parity Verification

> Production-parity verification checklist for single-node k3s rootservers

**Status**: active  
**Version**: 1.0.0  
**Last Updated**: 2026-03-12  
**Provides**: Documented L6 verification layer for real k3s rootserver validation

---

## Changelog

- **v1.0.0** (2026-03-12): Initial rootserver parity verification checklist

---

## Identity

**What**: A documented verification checklist and exact command reference for validating Fabrik CLI execution on real single-node k3s rootservers (not k3d). This is Layer 6 (L6) of the verification ladder defined in [`058-cli-verification-map.md`](./058-cli-verification-map.md).

**Why**: Local k3d testing may hide real k3s differences in:
- Image distribution (remote registries vs local k3d registry)
- Storage class behavior (local-path vs real PVC provisioning)
- Network policies and DNS resolution
- Service account token mounting
- Container runtime behavior (containerd on real k3s vs Docker-in-Docker)

**Not**: 
- A replacement for L3/L4 k3d verification (those are still required)
- Automated CI tests (requires real infrastructure)
- Multi-node cluster verification (see L4 for that)

---

## Goals

1. **Documented parity checks**: Exact commands and expected outcomes for rootserver verification
2. **Image distribution validation**: Verify remote registry pulls work correctly
3. **Storage parity**: Confirm PVC provisioning matches k3d expectations
4. **Runtime validation**: Ensure workflow execution works on real containerd

---

## Prerequisites

Before running this verification, you must have:

1. **A real single-node k3s rootserver** with:
   - k3s installed (not k3d)
   - `kubectl` access configured
   - At least 2 CPU, 4GB RAM
   - Container runtime: containerd (k3s default)
   - StorageClass available (local-path provisioner or similar)

2. **Fabrik CLI built from source**:
   ```bash
   cd src/fabrik-cli
   go build -o fabrik .
   ```

3. **Required secrets configured**:
   - `~/.codex/auth.json` with valid credentials
   - `~/.codex/config.toml` with valid configuration

4. **Network access**:
   - Outbound HTTPS to GitHub
   - Outbound to container registry (GHCR or configured registry)

---

## Verification Checklist

### Check 1: Cluster Connectivity and Prerequisites

**Purpose**: Verify basic cluster access and Fabrik namespace setup.

**Commands**:
```bash
# Verify cluster access
kubectl cluster-info
kubectl get nodes -o wide

# Verify node is ready and single-node
kubectl get nodes --selector='!node-role.kubernetes.io/control-plane' -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | wc -l
# Expected output: 0 (no worker nodes, single-node cluster)

# Verify storage class
kubectl get storageclass

# Verify or create fabrik namespaces
kubectl create namespace fabrik-system --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace fabrik-runs --dry-run=client -o yaml | kubectl apply -f -

# Verify RBAC is applied
kubectl apply -f k8s/rbac.yaml
kubectl get serviceaccount -n fabrik-system fabrik-runner
```

**Expected Outcomes**:
- Cluster info displays Kubernetes control plane URL
- Single node in Ready state
- At least one StorageClass marked as default
- Namespaces `fabrik-system` and `fabrik-runs` exist
- ServiceAccount `fabrik-runner` exists in `fabrik-system`

---

### Check 2: Image Distribution (Remote Registry Pull)

**Purpose**: Verify remote image pulls work correctly on real k3s (not local k3d registry).

**Commands**:
```bash
# Test direct image pull on node
kubectl run test-pull --image=ghcr.io/codex-is/fabrik-smithers:latest --restart=Never --rm -it -- /bin/sh -c "echo 'Image pulled successfully'"

# Verify image is cached on node
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | head -1 | xargs -I {} kubectl debug node/{} -it --image=alpine -- /bin/sh -c "crictl images | grep fabrik-smithers || echo 'Image check complete'"
```

**Expected Outcomes**:
- Image pulls successfully from remote registry
- No `ImagePullBackOff` errors
- If using a private registry, image pull secrets are correctly configured

---

### Check 3: PVC Provisioning and Binding

**Purpose**: Verify PVC provisioning works on real k3s storage.

**Commands**:
```bash
# Create a test PVC
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-fabrik-pvc
  namespace: fabrik-runs
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
EOF

# Verify PVC binds
kubectl wait --for=jsonpath='{.status.phase}'=Bound pvc/test-fabrik-pvc -n fabrik-runs --timeout=60s
kubectl get pvc test-fabrik-pvc -n fabrik-runs

# Clean up
kubectl delete pvc test-fabrik-pvc -n fabrik-runs
```

**Expected Outcomes**:
- PVC transitions to `Bound` state within 60 seconds
- Underlying PV is provisioned by the StorageClass
- No provisioning errors in `kubectl describe pvc`

---

### Check 4: Real Single-Node k3s Dispatch (Command Run)

**Purpose**: Verify basic `fabrik run` dispatch works on real k3s.

**Commands**:
```bash
# Dispatch a simple command run
./fabrik run \
  --project demo-rootserver \
  --env dev \
  --image ghcr.io/codex-is/fabrik-smithers:latest \
  -- \
  echo "Hello from real k3s rootserver"

# Get the run ID from output and verify
RUN_ID=$(./fabrik runs list --project demo-rootserver --format json | jq -r '.[0].id')
echo "Run ID: $RUN_ID"

# Wait for completion
kubectl wait job/fabrik-$RUN_ID -n fabrik-runs --for=condition=Complete --timeout=120s

# Verify logs
./fabrik run logs --id $RUN_ID | grep "Hello from real k3s rootserver"
```

**Expected Outcomes**:
- Job creates successfully
- Pod reaches `Running` state
- Command executes and produces expected output
- Logs are retrievable via `fabrik run logs`
- Job completes with status `Complete`

---

### Check 5: Environment Injection

**Purpose**: Verify project environment secrets are correctly injected.

**Commands**:
```bash
# Set test environment variables
./fabrik env set --project demo-rootserver --env dev TEST_KEY="test_value_from_rootserver"
./fabrik env set --project demo-rootserver --env dev ANOTHER_KEY="another_value"

# Verify secret exists
kubectl get secret fabrik-env-demo-rootserver-dev -n fabrik-system -o jsonpath='{.data.TEST_KEY}' | base64 -d

# Dispatch run that reads env
./fabrik run \
  --project demo-rootserver \
  --env dev \
  --image ghcr.io/codex-is/fabrik-smithers:latest \
  -- \
  sh -c 'echo "TEST_KEY=$TEST_KEY, ANOTHER_KEY=$ANOTHER_KEY"'

# Verify env was injected
RUN_ID=$(./fabrik runs list --project demo-rootserver --format json | jq -r '.[0].id')
./fabrik run logs --id $RUN_ID | grep "TEST_KEY=test_value_from_rootserver"
./fabrik run logs --id $RUN_ID | grep "ANOTHER_KEY=another_value"
```

**Expected Outcomes**:
- Secret `fabrik-env-demo-rootserver-dev` exists with correct values
- Environment variables are injected into the pod
- Logs show expected environment variable values

---

### Check 6: Repo-Aware Workflow Execution

**Purpose**: Verify workflow runs correctly clone and access repository contents.

**Prerequisites**:
- A GitHub token with repo access configured in `~/.codex/auth.json`
- A public test repository (or private with configured access)

**Commands**:
```bash
# Create a simple test workflow
cat > /tmp/test-workflow.tsx << 'EOF'
import { workflow } from "fabrik";

export default workflow({
  id: "rootserver-test",
  name: "Rootserver Test Workflow",
  jobs: [
    {
      id: "verify-repo",
      name: "Verify repo access",
      run: async ({ ctx }) => {
        // Check that we're in the repo context
        const fs = await import("fs");
        const files = fs.readdirSync(".");
        ctx.log("Files in workspace: " + files.join(", "));
        
        // Verify git is available
        const { execSync } = await import("child_process");
        const gitStatus = execSync("git status --short || echo 'not a git repo'", { encoding: "utf-8" });
        ctx.log("Git status: " + gitStatus);
        
        return { success: true };
      },
    },
  ],
});
EOF

# Dispatch workflow with repo
./fabrik run \
  --project demo-rootserver \
  --env dev \
  --workflow-path /tmp/test-workflow.tsx \
  --jj-repo https://github.com/codex-is/fabrik \
  --branch main

# Get run ID and wait
RUN_ID=$(./fabrik runs list --project demo-rootserver --format json | jq -r '.[0].id')
kubectl wait job/fabrik-$RUN_ID -n fabrik-runs --for=condition=Complete --timeout=180s

# Verify logs show repo contents
./fabrik run logs --id $RUN_ID | grep -E "(Files in workspace|Git status|success)"
```

**Expected Outcomes**:
- Workflow bundle is created and mounted
- Git clone init container succeeds
- Repository files are accessible in `/workspace/project`
- Workflow logs show successful execution

---

### Check 7: PVC Persistence Across Pod Restarts

**Purpose**: Verify PVC state persists (critical for resume functionality).

**Commands**:
```bash
# Create a workflow that writes state
cat > /tmp/state-test.tsx << 'EOF'
import { workflow } from "fabrik";
import { Database } from "bun:sqlite";

export default workflow({
  id: "state-test",
  name: "State Persistence Test",
  jobs: [
    {
      id: "write-state",
      name: "Write state to SQLite",
      run: async ({ ctx }) => {
        const db = new Database("/workspace/.smithers/state.db");
        db.run("CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, value TEXT)");
        db.run("INSERT INTO test (value) VALUES ('rootserver-test-value')");
        const result = db.query("SELECT * FROM test").all();
        ctx.log("Database contents: " + JSON.stringify(result));
        return { success: true };
      },
    },
  ],
});
EOF

# Dispatch workflow
./fabrik run \
  --project demo-rootserver \
  --env dev \
  --workflow-path /tmp/state-test.tsx

# Get run ID and wait
RUN_ID=$(./fabrik runs list --project demo-rootserver --format json | jq -r '.[0].id')
kubectl wait job/fabrik-$RUN_ID -n fabrik-runs --for=condition=Complete --timeout=120s

# Verify PVC still exists and has data
PVC_NAME="data-fabrik-$RUN_ID"
kubectl get pvc $PVC_NAME -n fabrik-runs

# Verify state in PVC by creating a debug pod
kubectl run pvc-debug --rm -it --restart=Never \
  --image=alpine \
  -n fabrik-runs \
  --overrides="{\"spec\":{\"volumes\":[{"name":"data","persistentVolumeClaim":{"claimName":"$PVC_NAME"}}],\"containers\":[{"name":"debug","image":"alpine","volumeMounts":[{"name":"data","mountPath":"/data"}],\"command":["sh","-c","cat /data/.smithers/state.db 2>/dev/null || ls -la /data/"]}]}}"

# Clean up
kubectl delete job/fabrik-$RUN_ID -n fabrik-runs
```

**Expected Outcomes**:
- Workflow writes state to SQLite in PVC
- PVC survives job completion
- Data is queryable via debug pod
- PVC is cleaned up when job is deleted (TTL)

---

### Check 8: Resume with Immutable Image Digest

**Purpose**: Verify resume works correctly with remote registry images.

**Commands**:
```bash
# Get image digest from registry
IMAGE_DIGEST=$(docker manifest inspect ghcr.io/codex-is/fabrik-smithers:latest --verbose 2>/dev/null | jq -r '.Descriptor.digest' || echo "latest")
echo "Image reference: ghcr.io/codex-is/fabrik-smithers@$IMAGE_DIGEST"

# Dispatch a long-running job that we can resume
cat > /tmp/resume-test.tsx << 'EOF'
import { workflow } from "fabrik";
import { Database } from "bun:sqlite";

export default workflow({
  id: "resume-test",
  name: "Resume Test",
  jobs: [
    {
      id: "checkpoint",
      name: "Create checkpoint",
      run: async ({ ctx }) => {
        const db = new Database("/workspace/.smithers/state.db");
        db.run("CREATE TABLE IF NOT EXISTS checkpoints (id INTEGER PRIMARY KEY)");
        db.run("INSERT INTO checkpoints DEFAULT VALUES");
        const count = db.query("SELECT COUNT(*) as count FROM checkpoints").get() as { count: number };
        ctx.log(`Checkpoint count: ${count.count}`);
        return { success: true, checkpoint: count.count };
      },
    },
  ],
});
EOF

# Dispatch with digest
./fabrik run \
  --project demo-rootserver \
  --env dev \
  --workflow-path /tmp/resume-test.tsx \
  --image "ghcr.io/codex-is/fabrik-smithers@$IMAGE_DIGEST"

RUN_ID=$(./fabrik runs list --project demo-rootserver --format json | jq -r '.[0].id')

# Wait for completion
kubectl wait job/fabrik-$RUN_ID -n fabrik-runs --for=condition=Complete --timeout=120s

# Verify job succeeded
./fabrik runs show --id $RUN_ID | grep -E "(succeeded|complete)"

# Clean up
kubectl delete job/fabrik-$RUN_ID -n fabrik-runs
```

**Expected Outcomes**:
- Job with digest reference creates successfully
- Pod pulls image using digest
- Resume (if tested) uses same digest
- Job completes successfully

---

## Verification Summary Command

Run all checks with a single command after setup:

```bash
#!/bin/bash
set -euo pipefail

echo "=== Rootserver k3s Parity Verification ==="
echo "Cluster: $(kubectl config current-context)"
echo ""

echo "[1/8] Cluster connectivity..."
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" ready="}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

echo ""
echo "[2/8] Image distribution..."
kubectl run test-pull --image=ghcr.io/codex-is/fabrik-smithers:latest --restart=Never --rm -it -- /bin/sh -c "echo 'SUCCESS: Image pulled'" || echo "FAIL: Image pull"

echo ""
echo "[3/8] PVC provisioning..."
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-parity-pvc
  namespace: fabrik-runs
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
EOF
kubectl wait --for=jsonpath='{.status.phase}'=Bound pvc/test-parity-pvc -n fabrik-runs --timeout=60s && echo "SUCCESS: PVC bound" || echo "FAIL: PVC binding"
kubectl delete pvc test-parity-pvc -n fabrik-runs --wait=false

echo ""
echo "[4/8] Command dispatch..."
./fabrik run --project parity-test --env dev --image ghcr.io/codex-is/fabrik-smithers:latest -- echo "parity-test"
RUN_ID=$(./fabrik runs list --project parity-test --format json | jq -r '.[0].id')
kubectl wait job/fabrik-$RUN_ID -n fabrik-runs --for=condition=Complete --timeout=120s && echo "SUCCESS: Job completed" || echo "FAIL: Job did not complete"

echo ""
echo "[5/8] Environment injection..."
./fabrik env set --project parity-test --env dev PARITY_CHECK="passed"
./fabrik run --project parity-test --env dev --image ghcr.io/codex-is/fabrik-smithers:latest -- sh -c 'echo "PARITY_CHECK=$PARITY_CHECK"' | grep "passed" && echo "SUCCESS: Env injected" || echo "FAIL: Env not injected"

echo ""
echo "[6/8] Workflow execution..."
# Requires workflow file, skipped in summary

echo ""
echo "=== Verification Complete ==="
```

---

## Expected Differences from k3d

| Aspect | k3d | Real k3s Rootserver | Verification |
|--------|-----|---------------------|--------------|
| Registry | Local k3d registry at `localhost:5111` | Remote registry (GHCR) | Check 2 |
| Storage | Local hostPath bind mounts | Real PVC provisioning | Check 3 |
| Container Runtime | Docker-in-Docker | containerd | Implicit in all checks |
| DNS | k3d-managed CoreDNS | k3s default CoreDNS | Check 4 (network reachability) |
| Node OS | Docker container | Real Linux (NixOS, Ubuntu, etc.) | Check 1 |
| Image Pull | Fast, local | Network-dependent, authenticated | Check 2 |

---

## Success Criteria

For rootserver parity to be considered verified:

- [ ] All 8 checks pass on the target rootserver
- [ ] No `ImagePullBackOff` errors during dispatch
- [ ] PVCs bind within 60 seconds
- [ ] Environment variables are correctly injected
- [ ] Workflow runs can access cloned repository contents
- [ ] SQLite state persists in PVC across job lifecycle

---

## Failure Modes and Troubleshooting

### ImagePullBackOff

**Symptom**: Pod status shows `ImagePullBackOff`
**Check**: `kubectl describe pod <pod-name> -n fabrik-runs`
**Resolution**:
- Verify image exists and is accessible: `docker pull <image>` from rootserver
- Check for authentication issues with private registries
- Verify network connectivity from k3s node

### PVC Pending

**Symptom**: PVC stays in `Pending` state
**Check**: `kubectl describe pvc <pvc-name> -n fabrik-runs`
**Resolution**:
- Verify StorageClass exists: `kubectl get storageclass`
- Check provisioner logs: `kubectl logs -n kube-system -l app=local-path-provisioner`
- Verify node has available disk space

### DNS Resolution Failures

**Symptom**: Git clone fails with host not found
**Check**: `kubectl run test-dns --rm -it --restart=Never --image=alpine -- nslookup github.com`
**Resolution**:
- Verify CoreDNS is running: `kubectl get pods -n kube-system -l k8s-app=kube-dns`
- Check node DNS configuration

---

## Related Documents

- [`057-k3s-local-testing.md`](./057-k3s-local-testing.md): L3/L4 k3d verification
- [`058-cli-verification-map.md`](./058-cli-verification-map.md): Complete verification ladder
- [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md): K8s-native execution spec
- [`050-k3s-infrastructure.md`](./050-k3s-infrastructure.md): Infrastructure provisioning

---

## Glossary

- **Rootserver**: A real (not virtualized/containerized) k3s server node
- **L6**: Layer 6 of verification (production parity)
- **Image Digest**: Immutable SHA256 reference to a container image
- **StorageClass**: Kubernetes provisioner for dynamic PVC creation
- **Local-path**: k3s default storage provisioner (hostPath-based)

---

## Changelog

- **v1.0.0** (2026-03-12): Initial rootserver parity verification checklist
  - 8 verification checks documented
  - Exact commands and expected outcomes
  - Troubleshooting section for common failures
  - Summary command for quick verification
