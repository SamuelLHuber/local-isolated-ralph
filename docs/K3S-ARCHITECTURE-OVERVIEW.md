# Fabrik k3s Architecture Overview

> Complete self-improving, cost-optimized, secure fabrik platform on k3s

**Version**: 1.0.0  
**Last Updated**: 2026-02-16  
**Specs**: 050-061 (8 specifications, 150KB)

---

## System Architecture

```
┌─ FABRIK K3S PLATFORM ─────────────────────────────────────────────────────┐
│                                                                          │
│  LAYER 1: FOUNDATION (050)                                              │
│  ┌─ Infrastructure (Pulumi + NixOS + Hetzner) ─────────────────────────┐ │
│  │  ├─ Provisions: Servers, network, storage, k3s                    │ │
│  │  ├─ Builds: Container images via Nix                               │ │
│  │  └─ State: Self-hosted (S3/MinIO, not Pulumi Cloud)               │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                           │
│                              ▼                                           │
│  LAYER 2: EXECUTION (051)                                               │
│  ┌─ Orchestrator (K8s Jobs) ───────────────────────────────────────────┐ │
│  │  ├─ Runs: Smithers workloads as Jobs                               │ │
│  │  ├─ Stores: SQLite state in PVC (survives restarts)              │ │
│  │  ├─ Resilience: Auto-resume, alerting, auto-healing              │ │
│  │  └─ Cleanup: K8s native TTL (no custom controller)                │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                           │
│                              ▼                                           │
│  LAYER 3: OBSERVABILITY (052, 054, 055, 056)                           │
│  ┌─ Dashboard (Direct K8s API) ───────────┐ ┌─ Cron Monitoring ─────┐ │
│  │  ├─ Web: React + Vite                  │ │  ├─ Missed run detect │ │
│  │  ├─ TUI: Ink (k9s-style)             │ │  ├─ Duration alerts   │ │
│  │  └─ Debug: kubectl/k9s integration     │ │  └─ Health checks     │ │
│  └────────────────────────────────────────┘ └──────────────────────────┘ │
│  ┌─ Run Analytics ───────────────────────┐ ┌─ Cost Management ───────┐ │
│  │  ├─ Pattern detection                  │ │  ├─ Track spend        │ │
│  │  ├─ Suggestion engine                  │ │  ├─ Budget alerts      │ │
│  │  └─ Spec quality scores                │ │  └─ Cost optimization  │ │
│  └────────────────────────────────────────┘ └──────────────────────────┘ │
│                              │                                           │
│                              ▼                                           │
│  LAYER 4: PROTECTION (060)                                              │
│  ┌─ Security Hardening ────────────────────────────────────────────────┐ │
│  │  ├─ NetworkPolicy: Namespace isolation                               │ │
│  │  ├─ Pod Security: Restricted profile                                │ │
│  │  ├─ ResourceQuota: DoS prevention                                  │ │
│  │  └─ Audit: All actions logged                                        │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                              │                                           │
│                              ▼                                           │
│  LAYER 5: OPTIMIZATION (061) ⭐ SELF-IMPROVING                           │
│  ┌─ In-Cluster Optimizer ──────────────────────────────────────────────┐ │
│  │  ├─ Observes: Metrics from all layers                                │ │
│  │  ├─ Analyzes: Patterns, inefficiencies                           │ │
│  │  ├─ Experiments: A/B tests on subset of runs                        │ │
│  │  ├─ Implements: Auto-apply low-risk, PR for high-risk              │ │
│  │  └─ Guardrails: Max 3 experiments, auto-rollback                   │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ LAOS (Observability Stack) ────────────────────────────────────────┐ │
│  │  ├─ Prometheus: Metrics                                               │ │
│  │  ├─ Loki: Logs                                                      │ │
│  │  ├─ Grafana: Dashboards                                               │ │
│  │  └─ AlertManager: Notifications                                      │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Spec Dependency Graph

```
050-infrastructure ─┬──► 051-orchestrator ─┬──► 052-dashboard
     │              │         │            │         │
     │              │         │            │         ▼
     │              │         │            │    ┌────────────┐
     │              │         │            └───►│ 060-       │
     │              │         │                 │ security   │
     │              │         │                 └────────────┘
     │              │         │
     │              │         └────────┬────────┬────────┐
     │              │                  │        │        │
     │              │                  ▼        ▼        ▼
     │              │            054-cron  055-analytics 056-cost
     │              │            monitoring   │         │
     │              │                          │         │
     │              └───────────────────────────┴─────────┘
     │                          │
     ▼                          ▼
┌─────────┐              ┌──────────────┐
│ Container │              │ 061-optimizer │
│ Images  │◄───────────────│  (self-       │
│ (Nix)   │              │  improving)   │
└─────────┘              └──────────────┘
```

---

## Key Architectural Decisions

| Decision | Rationale | Impact |
|----------|-----------|--------|
| **No Pulumi Cloud** | Self-host state in S3/MinIO | No external dependencies |
| **No Daemon** | Direct K8s API like kubectl/k9s | Simpler, fewer moving parts |
| **SQLite in PVC** | Survives pod restarts | Enables resume without progress loss |
| **K8s Native Cleanup** | `ttlSecondsAfterFinished` | No custom controller needed |
| **kubectl for Debug** | Document standard tools | Don't reinvent debugging |
| **A/B Testing** | Test changes on <20% of runs | Safe experimentation |
| **Auto-Low, PR-High** | Auto-apply resource tuning, PR for model changes | Balance speed and safety |
| **Self-Documenting** | All changes in git with rationale | Audit trail, learning |

---

## Data Flow: The Feedback Loop

```
1. RUN EXECUTION (051)
   Job runs → Smithers updates annotations → SQLite in PVC
   ├─ Pod metrics → Prometheus
   ├─ Logs → Loki
   └─ Cost → Annotations

2. DATA COLLECTION (055)
   CronJob every 5min:
   ├─ Query Prometheus (resources, duration)
   ├─ Query Loki (errors, patterns)
   ├─ Query K8s API (run outcomes)
   └─ Store in analytics.db

3. PATTERN DETECTION (055)
   SQL queries:
   ├─ "Specs of type X fail 40% with Sonnet, 15% with Opus"
   ├─ "p95 memory is 3.2Gi, current limit 2Gi → 75% OOM"
   └─ "Complex specs (>7 tasks) retry 40% less with early validation"

4. HYPOTHESIS GENERATION (061)
   Optimizer creates candidates:
   ├─ "Increase memory to 4Gi (confidence: 92%, 47 runs)"
   ├─ "Use Opus for >7 tasks (confidence: 89%, 23 runs)"
   └─ "Add early validation step (confidence: 78%, pattern detected)"

5. A/B TESTING (061)
   For each candidate:
   ├─ Deploy experiment (10% treatment, 90% control)
   ├─ Run for N iterations or statistical significance
   ├─ Measure: success rate, duration, cost, error rate
   └─ Statistical comparison (p-value < 0.05)

6. DECISION & IMPLEMENTATION (061)
   If confidence ≥ 95% and low risk:
   ├─ Auto-apply: Update default resource limits
   └─ Update spec._learned fields

   If medium/high risk:
   ├─ Create PR with full rationale
   ├─ Human reviews: "Accept 2.2x cost for 13% better success?"
   └─ Merge or reject

7. DOCUMENTATION (061)
   All changes tracked:
   ├─ Git commit: "optimizer: Increase memory..."
   ├─ Spec _learned: {optimal_model, recommended_resources}
   └─ Analytics: Link experiment ID to outcomes

8. CONTINUOUS MONITORING (061)
   Safety guardrails:
   ├─ If success rate drops >10% → Auto-rollback
   ├─ If error rate doubles → Alert + rollback
   └─ If cost 3x → Emergency stop
```

---

## Cost Optimization Flow

```
┌─ Cost Management (056) ──────────────────────────────────────────────────┐
│                                                                          │
│  1. Track Every Run                                                      │
│     ├─ Infrastructure: Hetzner pricing × hours running                   │
│     ├─ LLM: Tokens × model price (from annotations)                    │
│     └─ Storage: PVC size × days retained                               │
│                                                                          │
│  2. Set Budgets                                                          │
│     ├─ Infrastructure: €100/month (alert at €80)                        │
│     ├─ LLM: $500/month (alert at $450)                                 │
│     └─ Per-project limits                                               │
│                                                                          │
│  3. Optimization Opportunities (061 detects)                           │
│     ├─ "Nightly dev clusters unused 18h → Auto-shutdown saves €24"      │
│     ├─ "Use spot instances for fault-tolerant runs → 60% cheaper"     │
│     ├─ "Sonnet vs Opus cost/success ratio → Use Sonnet for impl"        │
│     └─ "Batch non-urgent runs to off-peak → 30% cheaper"               │
│                                                                          │
│  4. Auto-Implementation                                                  │
│     ├─ Low risk: Auto-shutdown schedule                                  │
│     ├─ Medium risk: PR for spot instance tolerations                     │
│     └─ Monitor: Track actual savings vs projected                        │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Security Architecture

```
┌─ Security Hardening (060) ───────────────────────────────────────────────┐
│                                                                          │
│  ASSUMPTION: Runs are untrusted (LLM generates code, could be malicious)│
│                                                                          │
│  LAYER 1: Network Isolation (NetworkPolicy)                             │
│  ├─ fabrik-runs → Block egress to fabrik-system                        │
│  ├─ fabrik-runs → Block pod-to-pod (except same Job)                   │
│  └─ fabrik-system → Allow only k3s API (6443) from fabrik-runs         │
│                                                                          │
│  LAYER 2: Pod Security (Restricted)                                     │
│  ├─ Non-root user (1000:1000)                                          │
│  ├─ No privilege escalation                                             │
│  ├─ Read-only root filesystem                                           │
│  ├─ Drop all capabilities                                               │
│  └─ Seccomp: RuntimeDefault                                             │
│                                                                          │
│  LAYER 3: Resource Limits (DoS Prevention)                              │
│  ├─ Max 100 concurrent Jobs                                            │
│  ├─ Max 200Gi total memory                                              │
│  ├─ Max 100 CPU cores                                                   │
│  └─ Max 50 PVCs                                                         │
│                                                                          │
│  LAYER 4: Audit & Monitoring                                            │
│  ├─ All API calls logged to LAOS                                        │
│  ├─ Pod exec, delete operations flagged                                 │
│  └─ 90-day retention for forensics                                    │
│                                                                          │
│  CONTAINMENT: If compromised:                                           │
│  ├─ Can't reach control plane                                           │
│  ├─ Can't access other pods                                             │
│  ├─ Can't escalate privileges                                           │
│  └─ All actions logged for investigation                                │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Priority

### Phase 1: Foundation (Weeks 1-2)
- [ ] **050** Infrastructure: Get k3s cluster running
- [ ] **051** Orchestrator: Run first Job successfully
- [ ] **052** Dashboard: Basic TUI for viewing runs

**Goal**: Core functionality working, manual operation

### Phase 2: Safety & Monitoring (Weeks 3-4)
- [ ] **060** Security: Network policies, pod security
- [ ] **054** Cron Monitoring: Detect missed scheduled runs
- [ ] **056** Cost Management: Track spend, set budgets

**Goal**: Production-ready, secure, cost-controlled

### Phase 3: Intelligence (Weeks 5-6)
- [ ] **055** Run Analytics: Collect data, detect patterns
- [ ] **061** In-Cluster Optimizer: A/B testing, auto-improvement

**Goal**: Self-improving system, continuous optimization

### Phase 4: Refinement (Week 7+)
- [ ] Tune optimizer guardrails based on real data
- [ ] Add more optimization domains (scheduling, caching)
- [ ] Scale to multiple clusters

**Goal**: Mature, autonomous platform

---

## Success Metrics

| Metric | Baseline | Target | How Measured |
|--------|----------|--------|--------------|
| Run success rate | 75% (VM era) | 90%+ | 055-analytics |
| Cost per successful run | €12 + $2 LLM | €8 + $1.50 | 056-cost |
| Time to completion | 45 min | 30 min | 055-analytics |
| OOM rate | 35% | <5% | 051-orchestrator |
| Optimizer experiments | 0 | 2-3/week | 061-optimizer |
| Auto-rollback rate | N/A | <10% | 061-optimizer |
| Human PR reviews | 0 | 1-2/week | GitHub |

---

## Spec Index

| Spec | Size | Purpose | Auto-Improve? |
|------|------|---------|---------------|
| **050** Infrastructure | 33KB | Provision cluster | ❌ Static |
| **051** Orchestrator | 31KB | Run workloads | ✅ Via optimizer |
| **052** Dashboard | 31KB | View & debug | ❌ Static |
| **054** Cron Monitor | 12KB | Schedule health | ✅ Via optimizer |
| **055** Run Analytics | 16KB | Collect data | ✅ Source for optimizer |
| **056** Cost Mgmt | 14KB | Spend tracking | ✅ Optimizer input |
| **060** Security | 13KB | Protection | ❌ Static |
| **061** Optimizer ⭐ | 20KB | **Self-improve** | ✅ **This is the loop** |

**Total**: 8 specs, ~170KB, complete self-improving platform specification.

---

## Key Insights

1. **Start collecting data immediately** (055): Even before you know what to optimize, store run outcomes. Patterns emerge after 50+ runs.

2. **Safety first** (060, 061 guardrails): Self-improving doesn't mean reckless. A/B test small, measure, expand.

3. **Human in the loop for big changes**: Auto-apply resource tuning (low risk), PR review for model selection (high cost impact).

4. **Self-documenting**: Every change in git with experiment ID, confidence, metrics. Audit trail becomes learning material.

5. **K8s-native everything**: No custom controllers, no daemons, no external SaaS. Use K8s primitives (TTL, NetworkPolicy, CronJob).

6. **The goal**: System that improves 24/7 without human intervention for low-risk items, escalates high-risk decisions for review.
