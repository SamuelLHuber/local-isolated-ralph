# Spec: In-Cluster Optimizer (Self-Improving System)

> Continuous optimization agent that runs in-cluster, analyzes performance, proposes improvements, A/B tests changes, and auto-implements speedups

**Status**: draft  
**Version**: 1.0.0  
**Last Updated**: 2026-02-16  
**Depends On**: `051-k3s-orchestrator`, `055-run-analytics`, `056-cost-management`  
**Provides**: Self-optimizing, continuously improving fabrik cluster

---

## Changelog

- **v1.0.0** (2026-02-16): Initial specification

---

## Identity

**What**: An in-cluster optimization agent that:
1. **Observes**: Collects metrics from LAOS, Prometheus, run outcomes
2. **Analyzes**: Identifies inefficiencies, bottlenecks, cost waste
3. **Hypothesizes**: Generates optimization candidates (configs, specs, resources)
4. **Experiments**: A/B tests changes on subset of real workloads
5. **Implements**: Auto-applies winning changes, rolls back losers
6. **Documents**: Updates specs with learnings, creates PRs for review

**Why**: Manual optimization doesn't scale. The system should optimize itself 24/7.

**Not**: 
- Dangerous auto-changes without guardrails (safety first)
- ML model training (starts with rule-based + statistical)
- External SaaS (runs entirely in-cluster)

---

## Goals

1. **Continuous optimization**: Always running, always improving
2. **Safe experimentation**: A/B test on <10% of runs, measure, then expand
3. **Multi-objective**: Balance speed, cost, reliability, security
4. **Self-documenting**: Changes recorded in git, specs updated with rationale
5. **Human oversight**: Significant changes require PR review, emergencies auto-rollback

---

## Non-Goals

- Unsupervised changes to infrastructure (costly mistakes)
- Modifying application code (only configs, resources, scheduling)
- Real-time ML inference (batch analysis is sufficient)
- Cross-cluster optimization (single cluster scope)

---

## Architecture

```
┌─ In-Cluster Optimizer ────────────────────────────────────────────────────┐
│  Namespace: fabrik-optimizer (isolated from fabrik-runs)                  │
│                                                                           │
│  ┌─ Optimizer Controller (Deployment) ───────────────────────────────────┐ │
│  │  ├─ Configuration: Optimization policies, guardrails, thresholds   │ │
│  │  ├─ State: SQLite (experiments in flight, results, pending changes) │ │
│  │  └─ API: Internal API for experiment management                     │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ Experiment Runner (CronJob: every 5 min) ──────────────────────────┐ │
│  │  1. Query metrics from Prometheus (resource usage, latencies)        │ │
│  │  2. Query LAOS (error rates, run outcomes)                           │ │
│  │  3. Query analytics DB (055-run-analytics)                           │ │
│  │  4. Generate optimization candidates                                │ │
│  │  5. For each candidate: check if safe to test                      │ │
│  │  6. If safe: deploy A/B test (experiment Job with variant config)    │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ Experiment Jobs (fabrik-runs namespace) ────────────────────────────┐ │
│  │  Normal fabrik runs, but with:                                       │ │
│  │  ├─ Variant label: optimizer.dev/experiment="memory-4gi-test"      │ │
│  │  ├─ Control group: baseline config                                  │ │
│  │  └─ Treatment group: variant config                                │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ Results Analyzer (CronJob: every 15 min) ──────────────────────────┐ │
│  │  1. Collect outcomes from experiment Jobs                            │ │
│  │  2. Statistical comparison (control vs treatment)                    │ │
│  │  3. Decide: rollout, rollback, or continue experiment              │ │
│  │  4. If significant win: create Change Request (K8s CR or git PR)     │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ Change Implementer (Controller) ───────────────────────────────────┐ │
│  │  ├─ Auto-apply: Resource tuning (memory, CPU) - low risk            │ │
│  │  ├─ PR-create: Spec changes, model selection - medium risk         │ │
│  │  ├─ Alert-only: Infrastructure changes - high risk (human decides)  │ │
│  │  └─ Emergency rollback: If success rate drops >10%                  │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ Guardrails (Enforced) ──────────────────────────────────────────────┐ │
│  │  ├─ Max 3 concurrent experiments                                     │ │
│  │  ├─ No experiments on production runs without approval               │ │
│  │  ├─ Auto-rollback if error rate > threshold                          │ │
│  │  ├─ Business hours only for risky changes                            │ │
│  │  └─ Require 95% confidence before rollout                           │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Optimization Domains

### **1. Resource Tuning** (Low Risk, Auto-Apply)

**What**: Memory/CPU limits, requests, storage

**Hypothesis generation**:
```typescript
// From analytics: p95 memory is 3.2Gi, current limit is 2Gi
const candidate = {
  type: 'resource',
  target: { kind: 'Job', labelSelector: 'fabrik.dev/spec-type=impl' },
  change: { memoryLimit: '4Gi' },  // Was 2Gi
  reason: '75% OOM rate, p95 memory 3.2Gi',
  confidence: 0.92,
  experimentSize: 10,  // Test on 10% of runs
  rollbackThreshold: { oomRate: 0.5 }  // Rollback if OOM >50%
};
```

**A/B Test**:
- Control: 90% of runs get current config (2Gi)
- Treatment: 10% of runs get variant (4Gi)
- Measure: Success rate, duration, cost

**Decision**:
- If treatment success rate >= control: Rollout to 100%
- If treatment OOM rate < control: Rollout, update spec default
- If treatment success rate < control - 5%: Rollback

---

### **2. Model Selection** (Medium Risk, PR Review)

**What**: Which LLM model to use per task type

**Hypothesis generation**:
```typescript
// Analytics shows: Opus 98% success for complex specs, Sonnet 85%
const candidate = {
  type: 'model',
  target: { taskType: 'impl', complexity: '>7' },
  change: { model: 'claude-3-opus-20240229' },  // Was sonnet
  reason: 'Complex specs (>7 tasks) succeed 98% with Opus vs 85% with Sonnet',
  confidence: 0.89,
  costImpact: '+220%',  // More expensive
  experimentSize: 20,
  requiresApproval: true  // Due to cost
};
```

**A/B Test**:
- Run 20 complex specs with each model
- Measure: Success rate, duration, cost per success

**Decision**:
- If success improvement > cost increase: Create PR to update default
- Human reviews: "Accept 2.2x cost for 13% better success?"

---

### **3. Batch Size / Parallelism** (Medium Risk)

**What**: How many tasks to run in parallel

**Hypothesis**:
- Current: Sequential tasks (1 at a time)
- Variant: Parallel validation (run tests while next impl generates)

**Experiment**:
- Run 50 specs with parallel mode
- Measure: Total wall-clock time, LLM context quality, error rate

---

### **4. Spec Pattern Optimization** (High Risk, PR Required)

**What**: Restructure specs based on success patterns

**Hypothesis generation**:
```typescript
// Pattern: Specs with "validate" before "impl" retry 40% less
const candidate = {
  type: 'spec_rewrite',
  target: { specId: 'api-implementation' },
  change: {
    addTask: { type: 'validate', after: 'impl', before: 'review' }
  },
  reason: 'Early validation catches errors before expensive review',
  confidence: 0.78,
  experimentSize: 30,
  autoApply: false,  // Always requires PR
  prDescription: 'Add early validation step based on 47-run analysis'
};
```

---

### **5. Scheduling / Timing** (Low Risk)

**What**: When to run jobs

**Hypothesis**:
- Current: Run immediately
- Variant: Batch runs to off-peak hours for cheaper spot instances

**Experiment**:
- Queue non-urgent runs, batch at 2-6 AM
- Measure: Cost savings, latency impact

---

## Experiment Protocol

### **Experiment Lifecycle**

```
Proposed → Safety Check → Deployed → Running → Analyzed → Decided
    │            │            │           │           │          │
    │            │            │           │           │          ├─ Rollout (update default)
    │            │            │           │           │          ├─ Continue (gather more data)
    │            │            │           │           │          └─ Rollback (keep baseline)
    │            │            │           │           │
    │            │            │           │           └─ Statistical significance test
    │            │            │           └─ Collect metrics for N runs
    │            │            └─ Create variant Job with experiment label
    │            └─ Check: Is change safe? Guardrails pass? Budget OK?
    └─ Generated from analytics pattern detection
```

### **Safety Guardrails**

| Guardrail | Rule | Action on Violation |
|-----------|------|---------------------|
| **Max Experiments** | ≤3 concurrent | Queue new proposals |
| **Production Protection** | No experiments on `prod` cluster without approval | Require human gate |
| **Error Rate** | Treatment error rate < control + 5% | Auto-rollback |
| **Cost Ceiling** | Treatment cost < 2x control | Require approval |
| **Business Hours** | Risky changes (infrastructure) 9AM-5PM only | Schedule for window |
| **Confidence Threshold** | ≥95% confidence for rollout | Continue experiment |
| **Minimum Sample** | ≥30 runs per variant | Don't analyze yet |

---

## Implementation: Change Request System

### **Change Request CRD**

```yaml
apiVersion: fabrik.dev/v1
kind: OptimizationChange
metadata:
  name: memory-4gi-for-impl-specs
  namespace: fabrik-optimizer
spec:
  type: resource
  target:
    labelSelector:
      fabrik.dev/spec-type: impl
  change:
    memoryLimit: 4Gi
  rationale: |
    75% of impl specs OOM at 2Gi limit.
    p95 memory usage: 3.2Gi.
    Experiment: 47 runs at 4Gi, 0% OOM, 12% faster completion.
  
  experiment:
    controlRuns: 90
    treatmentRuns: 47
    duration: 3d
    confidence: 0.97
    
  risk: low  # low/medium/high
  autoApply: true  # If low risk + high confidence
  
  rollbackPlan:
    metric: oom_rate
    threshold: 0.10
    action: immediate_rollback
    
status:
  phase: approved  # proposed → experiment_running → analyzing → approved/rejected → applied
  experimentId: exp-20260216-001
  rolloutProgress: 100%
  lastAppliedAt: 2026-02-16T15:00:00Z
```

### **Git Integration (for spec changes)**

```typescript
// For medium/high risk changes: Create PR
async function createOptimizationPR(change: OptimizationChange): Promise<void> {
  const branch = `optimizer/${change.metadata.name}`;
  
  // 1. Checkout specs repo
  await git.checkoutBranch(branch);
  
  // 2. Apply change to spec
  const spec = await loadSpec(change.spec.target.specId);
  spec.resources.memory = change.change.memoryLimit;
  spec._learned.optimizationApplied = {
    change: change.metadata.name,
    confidence: change.spec.experiment.confidence,
    metrics: change.status.experimentMetrics
  };
  await saveSpec(spec);
  
  // 3. Commit with detailed message
  await git.commit(`
optimizer: Increase memory to ${change.change.memoryLimit} for impl specs

Based on experiment ${change.spec.experiment.experimentId}:
- Control: ${change.spec.experiment.controlRuns} runs at 2Gi (75% OOM)
- Treatment: ${change.spec.experiment.treatmentRuns} runs at 4Gi (0% OOM)
- Confidence: ${change.spec.experiment.confidence}
- Impact: 12% faster completion, 0% OOM rate

Auto-rollback trigger: OOM rate > 10%
`);
  
  // 4. Push and create PR
  await git.push(branch);
  const pr = await github.createPR({
    title: `[optimizer] ${change.spec.rationale.split('\n')[0]}`,
    body: generatePRDescription(change),
    labels: ['optimizer', 'auto-generated', change.spec.risk]
  });
  
  // 5. Notify (Slack, email)
  await notify(`Optimization PR ready for review: ${pr.url}`);
}
```

---

## CLI Commands

```bash
# View active experiments
fabrik optimizer status
# Output:
# ┌─ Active Experiments (2) ─────────────────────────────────────────────────┐
# │                                                                          │
# │  1. memory-4gi-for-impl-specs                                          │
# │     Status: running (23/100 runs)                                    │
# │     Change: memory 2Gi → 4Gi                                           │
# │     Confidence so far: 0.87 (need 0.95)                                │
# │                                                                          │
# │  2. model-opus-for-complex                                              │
# │     Status: analyzing (complete)                                       │
# │     Change: sonnet → opus for >7 task specs                            │
# │     Confidence: 0.96 ✓                                                   │
# │     Decision: Create PR for review                                       │
# │                                                                          │
# └──────────────────────────────────────────────────────────────────────────┘

# View pending changes
fabrik optimizer changes list
fabrik optimizer changes show memory-4gi-for-impl-specs

# Approve/reject pending change
fabrik optimizer changes approve memory-4gi-for-impl-specs
fabrik optimizer changes reject memory-4gi-for-impl-specs --reason "Too expensive"

# Emergency rollback
fabrik optimizer rollback memory-4gi-for-impl-specs

# View optimization history
fabrik optimizer history --last-30d
# Shows: Applied changes, their impact, rollback events

# Pause optimizer (emergency)
fabrik optimizer pause --reason "Investigating issue"
fabrik optimizer resume

# Configure optimizer policies
fabrik optimizer config set max_experiments 5
fabrik optimizer config set auto_apply_risk low
fabrik optimizer config set business_hours_only true
```

---

## Metrics & Observability

### **Optimizer Health Dashboard**

```
┌─ Optimizer Health ───────────────────────────────────────────────────────┐
│                                                                            │
│  Experiments: 2 active, 47 completed (30d)                              │
│  Success Rate: 94% experiments lead to improvement                        │
│  Rollbacks: 3 (6% - within acceptable range)                           │
│                                                                            │
│  Active Optimizations:                                                    │
│  ├─ Resource: 2 (memory tuning)                                           │
│  ├─ Model: 1 (Opus for complex)                                         │
│  └─ Scheduling: 0                                                       │
│                                                                            │
│  Impact (Last 30 Days):                                                   │
│  ├─ Cost Reduction: €142 (12% infra savings)                            │
│  ├─ Speed Improvement: -18% avg duration                                  │
│  ├─ Success Rate: +5.2% (87% → 92%)                                     │
│  └─ OOM Reduction: -68% (35% → 11%)                                     │
│                                                                            │
│  Pending Reviews: 2 PRs awaiting human approval                         │
│                                                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

### **Key Metrics**

| Metric | Target | Alert If |
|--------|--------|----------|
| Experiment success rate | >80% | <70% |
| Rollback rate | <10% | >15% |
| Time to rollout | <7 days | >14 days |
| Unreviewed PRs | 0 | >3 |
| Cost savings | >5% | Negative |

---

## Safety: Emergency Procedures

### **Auto-Rollback Triggers**

```typescript
// Continuous monitoring (every minute)
async function safetyMonitor(): Promise<void> {
  for (const change of activeChanges) {
    const metrics = await collectMetrics(change);
    
    // Trigger 1: Success rate drop
    if (metrics.successRate < change.baseline.successRate * 0.90) {
      await emergencyRollback(change, 'Success rate dropped >10%');
    }
    
    // Trigger 2: Error rate spike
    if (metrics.errorRate > change.baseline.errorRate * 2) {
      await emergencyRollback(change, 'Error rate doubled');
    }
    
    // Trigger 3: Cost explosion
    if (metrics.costPerRun > change.baseline.costPerRun * 3) {
      await emergencyRollback(change, 'Cost 3x baseline');
    }
    
    // Trigger 4: Duration regression
    if (metrics.durationP95 > change.baseline.durationP95 * 1.5) {
      await alert(`Duration regression detected for ${change.name}`);
    }
  }
}
```

### **Emergency Rollback Procedure**

```bash
# Automatic (no human intervention)
1. Revert K8s resource to baseline
2. Label all new Jobs with "optimizer.dev/rolled-back=true"
3. Stop experiment
4. Alert: "Change X rolled back due to Y"
5. Create incident report in SQLite

# Human verification (within 1 hour)
6. Review rollback decision
7. If false alarm: Re-enable with adjusted guardrails
8. If correct: Document lesson learned
```

---

## Acceptance Criteria

- [ ] Optimizer runs as in-cluster Deployment (not external)
- [ ] Automatically detects optimization opportunities from analytics data
- [ ] A/B tests changes on <20% of runs before full rollout
- [ ] 95% confidence threshold for auto-apply (low risk changes)
- [ ] Human PR review required for medium/high risk changes
- [ ] Auto-rollback if success rate drops >10% or errors double
- [ ] Max 3 concurrent experiments to limit blast radius
- [ ] Git PRs created for spec changes with full rationale
- [ ] Dashboard shows experiment status, impact metrics, pending reviews
- [ ] Emergency pause/resume capability
- [ ] All changes documented with experiment ID, confidence, metrics

---

## Assumptions

1. **Sufficient data volume**: ≥100 runs/month for statistical significance
2. **Stable workloads**: Spec types don't change radically week-to-week
3. **Cost tolerance**: 10-20% cost increase acceptable for experiments
4. **Human bandwidth**: Can review 2-3 PRs per week
5. **Git access**: Optimizer can create branches and PRs
6. **Test environment**: Dev/staging cluster for risky experiments

---

## Glossary

- **Control**: Baseline group (current configuration)
- **Treatment**: Variant group (new configuration being tested)
- **Confidence**: Statistical confidence in result (p-value < 0.05 = 95%)
- **Rollout**: Applying change to 100% of workloads
- **Rollback**: Reverting to baseline due to negative results
- **Guardrail**: Safety limit that stops or prevents dangerous changes
- **Blast radius**: How many runs/workloads affected by a change
- **Multi-objective**: Optimizing for multiple metrics simultaneously
