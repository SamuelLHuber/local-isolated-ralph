# Spec: Security Hardening & Isolation

> Isolate Fabrik workloads to prevent escape or lateral movement from compromised runs

**Status**: draft  
**Version**: 1.0.0  
**Last Updated**: 2026-02-16  
**Depends On**: `050-k3s-infrastructure`, `051-k3s-orchestrator`  
**Provides**: Defense in depth for multi-tenant k3s clusters

---

## Changelog

- **v1.0.0** (2026-02-16): Initial specification

---

## Identity

**What**: Security controls to:
1. **Contain workloads**: Prevent compromised run from escaping
2. **Prevent lateral movement**: Stop compromised pod from accessing others
3. **Protect control plane**: Isolate fabrik-system from fabrik-runs
4. **Audit everything**: Log all security-relevant events

**Why**: We run untrusted code (LLM-generated code). Agents can't be fully controlled, so the platform must be indestructible from inside.

**Not**: 
- ABAC/RBAC for multi-user (single org per cluster for v1)
- Compliance certifications (SOC2, ISO27001 - business process)
- Kernel-level security (we use standard K8s security features)

---

## Goals

1. **Network isolation**: Runs can't talk to control plane or each other
2. **Pod Security Standards**: Enforce restricted profile
3. **Resource limits**: Prevent DoS via resource exhaustion
4. **Audit logging**: All API calls logged for forensics
5. **Read-only root**: Containers run with immutable filesystem where possible
6. **No privilege escalation**: Runs can't become root

---

## Non-Goals

- Multi-tenant ABAC (single org per cluster)
- Pod Security Admission policy customization per run
- Runtime security (Falco, etc.)
- Secrets encryption at rest (K8s handles this)

---

## Threat Model

**Attacker we defend against:**
- Compromised Smithers process (LLM tricked into malicious code)
- Malicious code in repository (supply chain attack)
- Insider threat (developer with cluster access)

**Attacker we don't defend against (v1):**
- Kernel zero-day (use latest stable k3s)
- Physical host compromise
- Control plane compromise (assume we protect this)

---

## Architecture

```
┌─ Security Layers ─────────────────────────────────────────────────────────┐
│                                                                            │
│  L1: Network Policies (Namespace isolation)                               │
│  ├─ fabrik-runs → Block ingress from other namespaces                   │
│  ├─ fabrik-runs → Block egress to fabrik-system                         │
│  ├─ fabrik-runs → Block pod-to-pod communication (except required)       │
│  └─ fabrik-system → Allow only 6443 from fabrik-runs (k3s API)          │
│                                                                            │
│  L2: Pod Security Standards (Restricted profile)                          │
│  ├─ Non-root user required (runAsNonRoot: true)                         │
│  ├─ No privilege escalation (allowPrivilegeEscalation: false)           │
│  ├─ Read-only root filesystem (readOnlyRootFilesystem: true)            │
│  ├─ Drop all capabilities, add only NET_BIND_SERVICE                    │
│  └─ Seccomp profile: RuntimeDefault                                       │
│                                                                            │
│  L3: Resource Quotas (DoS prevention)                                     │
│  ├─ Max 100 jobs in fabrik-runs                                         │
│  ├─ Max 200Gi memory total                                              │
│  ├─ Max 100 CPU cores total                                             │
│  └─ Max 50 PVCs                                                         │
│                                                                            │
│  L4: Audit Logging (Forensics)                                            │
│  ├─ All K8s API calls logged to LAOS/Loki                               │
│  ├─ Pod exec, port-forward, delete operations flagged                   │
│  └─ 90-day retention for security events                                │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Network Policies

```yaml
# Deny all ingress to fabrik-runs by default
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: fabrik-runs
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
# Allow ingress only from within fabrik-runs (for inter-pod communication if needed)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: fabrik-runs
spec:
  podSelector: {}
  ingress:
    - from:
        - podSelector: {}
  policyTypes:
    - Ingress
---
# Block egress to fabrik-system (control plane isolation)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: block-control-plane
  namespace: fabrik-runs
spec:
  podSelector: {}
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              name: fabrik-runs  # Only same namespace
    - to:
        - namespaceSelector: {}  # Allow internet (for GitHub, LLM APIs)
          except:
            - namespaceSelector:
                matchLabels:
                  name: fabrik-system
    - to:
        - ipBlock:
            cidr: 10.43.0.0/16  # Allow cluster DNS
        - ipBlock:
            cidr: 10.43.0.10/32  # coredns
  policyTypes:
    - Egress
---
# Allow fabrik-system to receive egress from fabrik-runs only on k3s API
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-server
  namespace: fabrik-system
spec:
  podSelector:
    matchLabels:
      app: k3s-server
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: fabrik-runs
      ports:
        - protocol: TCP
          port: 6443
  policyTypes:
    - Ingress
```

---

## Pod Security Standards

```yaml
# Pod Security Standard: Restricted
apiVersion: v1
kind: Pod
metadata:
  name: fabrik-01jk7v8x...
  namespace: fabrik-runs
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  
  containers:
    - name: smithers
      image: ghcr.io/fabrik/smithers:v1.2.3
      
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
        # If needed for low ports, add back:
        # add:
        #   - NET_BIND_SERVICE
      
      resources:
        limits:
          cpu: "2"
          memory: "4Gi"
        requests:
          cpu: "500m"
          memory: "1Gi"
      
      volumeMounts:
        # Writable volumes for SQLite state
        - name: smithers-data
          mountPath: /workspace/.smithers
        # EmptyDir for temporary files
        - name: tmp
          mountPath: /tmp
  
  volumes:
    - name: smithers-data
      persistentVolumeClaim:
        claimName: data-fabrik-01jk7v8x...
    - name: tmp
      emptyDir:
        sizeLimit: 1Gi
```

---

## Resource Quotas (DoS Prevention)

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: fabrik-runs-quota
  namespace: fabrik-runs
spec:
  hard:
    # Limit number of concurrent runs
    count/jobs.batch: "100"
    count/pods: "100"
    
    # Compute resources
    requests.cpu: "100"
    requests.memory: 200Gi
    limits.cpu: "200"
    limits.memory: 400Gi
    
    # Storage
    persistentvolumeclaims: "50"
    requests.storage: 500Gi
    
    # Network (Hetzner has unlimited, but good practice)
    services.loadbalancers: "0"  # No LB in fabrik-runs
    services.nodeports: "0"
---
# LimitRange for default resource constraints
apiVersion: v1
kind: LimitRange
metadata:
  name: fabrik-runs-limits
  namespace: fabrik-runs
spec:
  limits:
    - default:
        cpu: "2"
        memory: "4Gi"
      defaultRequest:
        cpu: "500m"
        memory: "1Gi"
      max:
        cpu: "8"
        memory: "16Gi"
      min:
        cpu: "100m"
        memory: "128Mi"
      type: Container
```

---

## Audit Logging

**K8s Audit Policy:**

```yaml
# /etc/rancher/k3s/audit.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all authn/authz failures
  - level: Metadata
    verbs: ["create", "update", "patch", "delete"]
    resources:
      - group: ""
        resources: ["pods", "pods/exec", "pods/portforward"]
      - group: "batch"
        resources: ["jobs"]
    omitStages:
      - RequestReceived
  
  # Log privileged operations
  - level: RequestResponse
    verbs: ["create"]
    resources:
      - group: ""
        resources: ["pods/exec"]
  
  # Log everything else at Metadata level
  - level: Metadata
    omitStages:
      - RequestReceived
```

**Audit output to LAOS/Loki:**

```yaml
# k3s server flag: --kube-apiserver-arg=audit-log-path=/var/log/k3s/audit.log
# Ship to Loki via Promtail
```

---

## CLI Commands

```bash
# Verify security configuration
fabrik security verify
# Output:
# ✓ Network policies active
# ✓ Pod Security Standards enforced
# ✓ Resource quotas configured
# ✓ Audit logging enabled
# ✓ Non-root containers enforced

# Check network isolation
fabrik security check-network
# Tests:
# - fabrik-runs pod cannot reach fabrik-system
# - fabrik-runs pods cannot talk to each other (unless same job)
# - External egress works (GitHub, LLM APIs)

# Review audit logs
fabrik security audit --since 1h
# Shows: pod exec, job deletions, privilege escalations

# Generate security report
fabrik security report > security-report-$(date +%Y%m%d).md
```

---

## Security Checklist

**Infrastructure Setup:**
- [ ] NetworkPolicy default-deny in fabrik-runs
- [ ] NetworkPolicy block fabrik-runs → fabrik-system
- [ ] Pod Security Standard: restricted enforced
- [ ] ResourceQuota configured (100 jobs, 200Gi memory max)
- [ ] LimitRange for default resource limits
- [ ] Audit logging enabled, shipping to LAOS
- [ ] Container images run as non-root (UID 1000)
- [ ] Read-only root filesystem where possible
- [ ] No privileged containers

**Per-Run Security:**
- [ ] Jobs created with securityContext (runAsNonRoot, noNewPrivileges)
- [ ] PVC mounts only to /workspace/.smithers (not system paths)
- [ ] No hostPath volumes
- [ ] No service account with cluster-admin
- [ ] Secrets mounted as files (not env vars where possible)

---

## Incident Response

**Scenario: Compromised Run Detected**

```bash
# 1. Isolate the run
fabrik run isolate --id 01jk7v8x...
# Applies additional NetworkPolicy blocking all egress

# 2. Capture forensic snapshot
fabrik run snapshot --id 01jk7v8x... --to /forensics/01jk7v8x-$(date +%s)
# Saves: pod spec, logs, SQLite DB, network connections

# 3. Analyze
fabrik run analyze --id 01jk7v8x...
# Checks: network connections, file modifications, processes

# 4. Clean up
fabrik run destroy --id 01jk7v8x... --force
# Deletes job, pods, PVC, network policies

# 5. Review audit logs
fabrik security audit --run-id 01jk7v8x... --full
# Shows all API calls from this run
```

---

## Acceptance Criteria

- [ ] NetworkPolicy blocks fabrik-runs → fabrik-system communication
- [ ] Pod Security Standard "restricted" enforced on fabrik-runs
- [ ] All containers run as non-root (UID 1000)
- [ ] No privileged containers can be created in fabrik-runs
- [ ] ResourceQuota prevents >100 concurrent jobs
- [ ] Audit logs capture pod exec, job delete, privilege escalation
- [ ] `fabrik security verify` confirms all protections active
- [ ] `fabrik security check-network` passes isolation tests
- [ ] Compromised run cannot access control plane or other runs
- [ ] Secrets not exposed in env vars (mounted as files)

---

## Assumptions

1. **Latest k3s**: Running recent stable version with patches
2. **CNI support**: Network plugin supports NetworkPolicy (Flannel with kube-router, or Cilium)
3. **Node security**: Nodes not compromised (physical security, SSH keys)
4. **Control plane**: Admin access limited to trusted operators
5. **Image trust**: Smithers images from trusted registry (GHCR with signature verification)

---

## Glossary

- **NetworkPolicy**: K8s resource controlling pod-to-pod traffic
- **Pod Security Standard**: Predefined security policies (privileged, baseline, restricted)
- **Seccomp**: Secure computing mode (syscall filtering)
- **Capabilities**: Linux kernel privileges (CAP_SYS_ADMIN, etc.)
- **Lateral movement**: Attacker moving from compromised pod to others
- **Privilege escalation**: Gaining more permissions than granted
- **Audit log**: Record of API server requests for forensics
