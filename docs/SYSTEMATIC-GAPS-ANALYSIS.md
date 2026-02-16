# Systematic Gaps Analysis: Fabrik k3s Platform

> Critical assessment of what's specified vs. what's needed for production

**Analysis Date**: 2026-02-16  
**Specs Analyzed**: 050-061 (8 specifications)  
**Status**: Pre-implementation planning

---

## Executive Summary

**Current State**: We have a well-specified architecture (8 specs, 170KB) covering infrastructure, orchestration, observability, security, and self-improvement.

**Critical Gap**: We're missing the **connective tissue** that makes a system usable:
- How does a user onboard? (no quickstart)
- How do we test changes? (no testing strategy)
- What are the actual API contracts? (no API spec)
- How do we migrate from VM? (no migration guide)
- What happens when production breaks at 2 AM? (no ops runbook)

**Recommendation**: Build in **4 phases**, starting with MVP (specs 050-052 + gaps), then hardening, then intelligence.

---

## Systematic Gap Analysis

### 1. User Experience Layer ⭐ CRITICAL GAP

| Gap | Current State | Impact | Priority |
|-----|--------------|--------|----------|
| **Onboarding/Quickstart** | None | User can't get started without reading 170KB of specs | 🔴 P0 |
| **First-Run Tutorial** | None | High abandonment rate | 🔴 P0 |
| **Error Messages** | Mentioned but not specified | Users stuck without actionable errors | 🟡 P1 |
| **Help System** | None | Users resort to kubectl/k9s for everything | 🟡 P1 |
| **Configuration Wizard** | "fabrik infra init" mentioned, not detailed | Manual config error-prone | 🟡 P1 |

**What's Missing**:
- Step-by-step: `curl ... | bash` to first working run
- Interactive wizard: "What cloud provider?", "What project?"
- Validation: Pre-flight checks before any deployment
- Common errors: "Port 6443 blocked", "No SSH key found", etc.

**Spec Needed**: `070-user-onboarding.md` or `QUICKSTART.md`

---

### 2. API & Integration Layer ⭐ CRITICAL GAP

| Gap | Current State | Impact | Priority |
|-----|--------------|--------|----------|
| **API Specification** | "@kubernetes/client-node" mentioned, no REST/gRPC spec | Can't build web dashboard, SDKs | 🔴 P0 |
| **Authentication/AuthZ** | "kubeconfig" only, no user management | Multi-user scenarios impossible | 🔴 P0 |
| **Webhook Integration** | Mentioned in 054/061, not specified | GitHub, Slack integrations undefined | 🟡 P1 |
| **LLM Provider Management** | "K8s Secrets" only, no key rotation/failover | API key exhaustion = downtime | 🟡 P1 |
| **GitHub App Integration** | "git clone" mentioned, no PR checks/webhooks | Missing CI/CD integration point | 🟡 P1 |

**What's Missing**:
- REST API: `/api/v1/runs`, `/api/v1/specs`, authentication
- WebSocket: Real-time updates for dashboard
- LLM Proxy: Rate limiting, failover between providers
- GitHub: PR status checks, "Fabrik is running"

**Spec Needed**: `065-api-integration.md`

---

### 3. Testing & Quality Layer ⭐ CRITICAL GAP

| Gap | Current State | Impact | Priority |
|-----|--------------|--------|----------|
| **Testing Strategy** | "Acceptance criteria" in specs, no test plan | Can't validate implementations | 🔴 P0 |
| **E2E Test Suite** | None | Regressions in production | 🔴 P0 |
| **Integration Tests** | None | K8s API changes break us | 🟡 P1 |
| **Load Testing** | None | Don't know scaling limits | 🟡 P1 |
| **Chaos Engineering** | "Auto-rollback" in 061, no failure injection | Resilience untested | 🟢 P2 |

**What's Missing**:
- Test pyramid: Unit → Integration → E2E
- E2E: Spin up k3d cluster, run full workflow
- Contract tests: K8s API version compatibility
- Load tests: 100 concurrent runs

**Spec Needed**: `068-testing-strategy.md`

---

### 4. Data & Migration Layer 🔴 HIGH GAP

| Gap | Current State | Impact | Priority |
|-----|--------------|--------|----------|
| **VM → k3s Migration** | "Sunset VM" in 050, no migration path | Existing users stranded | 🔴 P0 |
| **Data Export/Import** | "SQLite in PVC", no export specified | Vendor lock-in, no portability | 🔴 P0 |
| **Backup Strategy** | "etcd backup" mentioned in 050, not detailed | Data loss risk | 🔴 P0 |
| **Disaster Recovery** | None | Can't recover from cluster loss | 🟡 P1 |
| **Cross-Cluster Migration** | "Multi-cluster" mentioned, no procedure | Scaling blocked | 🟢 P2 |

**What's Missing**:
- Migration: Export ralph-1 SQLite → Import k3s PVC
- Backup: Automated PVC snapshots, S3 sync
- DR: Restore cluster from backup in <1 hour

**Spec Needed**: `066-data-migration.md`

---

### 5. Operations Layer 🔴 HIGH GAP

| Gap | Current State | Impact | Priority |
|-----|--------------|--------|----------|
| **Incident Response** | "fabrik doctor" mentioned, no procedures | 2 AM outages = panic | 🔴 P0 |
| **Runbook** | None | Knowledge in people's heads | 🔴 P0 |
| **Monitoring/Alerting** | "LAOS" mentioned, not configured | Flying blind in production | 🟡 P1 |
| **Capacity Planning** | "ResourceQuota" in 051/060, no guidance | Out of resources unexpectedly | 🟡 P1 |
| **Upgrade Procedures** | "NixOS atomic upgrades" in 050, no k3s upgrade | Stuck on old versions | 🟡 P1 |

**What's Missing**:
- Runbook: "Pod stuck in ContainerCreating"
- Runbook: "High error rate, what do I check?"
- Upgrade: k3s version bump without downtime
- Capacity: "You're at 80% memory, scale up"

**Spec Needed**: `067-operations-runbook.md`

---

### 6. Developer Experience Layer 🟡 MEDIUM GAP

| Gap | Current State | Impact | Priority |
|-----|--------------|--------|----------|
| **Local Development** | None | Can't develop without cloud | 🟡 P1 |
| **Debugging Tools** | "kubectl/k9s" in 052, no Fabrik-native | Time lost to context switching | 🟡 P1 |
| **Documentation Generator** | None | Specs stay out of date | 🟢 P2 |
| **SDK/CLI Library** | "CLI commands" scattered, no unified SDK | Inconsistent interfaces | 🟢 P2 |
| **Extension Points** | None | Can't add custom task types | 🟢 P2 |

**What's Missing**:
- Local dev: k3d/k3s in Docker for local testing
- Debug: `fabrik debug --run-id X` opens relevant logs/metrics
- SDK: TypeScript/Python SDKs for integration

**Spec Needed**: `069-developer-experience.md` (can defer)

---

### 7. Business Continuity Layer 🟢 LOWER GAP

| Gap | Current State | Impact | Priority |
|-----|--------------|--------|----------|
| **Multi-Region** | "Hetzner locations" in 050, no federation | Single point of failure | 🟢 P2 |
| **Compliance** | None | Can't sell to enterprise | 🟢 P2 |
| **SLA/SLO Definition** | None | No reliability targets | 🟢 P2 |
| **Billing Integration** | "Cost tracking" in 056, no invoicing | Can't charge customers | 🟢 P2 |

These are important but **can wait** until after MVP is stable.

---

## Gap Dependency Graph

```
┌─ CRITICAL GAPS (Block Production) ───────────────────────────────────────┐
│                                                                          │
│  070-USER-ONBOARDING ─┬─► 065-API-INTEGRATION ─┬─► 067-OPS-RUNBOOK      │
│       (Quickstart)    │       (REST/WebSocket)   │      (Incident response)
│                       │                        │
│                       ▼                        ▼
│               066-DATA-MIGRATION ◄───────────┘
│               (VM→k3s, backup, DR)
│                       │
│                       ▼
│               068-TESTING-STRATEGY
│               (E2E, validation)
│
└──────────────────────────────────────────────────────────────────────────┘

┌─ IMPORTANT GAPS (Improve Quality) ───────────────────────────────────────┐
│                                                                          │
│  069-DEVELOPER-EXPERIENCE (local dev, debugging, SDK)                    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

┌─ FUTURE GAPS (Scale/Business) ───────────────────────────────────────────┐
│                                                                          │
│  Multi-region, Compliance, SLA, Billing                                  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Recommended Implementation Order

### Phase 1: MVP Foundation (Weeks 1-3) 🔴 CRITICAL

**Goal**: Get from zero to first run, manually

| Order | Work | Why First? | Spec |
|-------|------|-----------|------|
| 1 | **070-User-Onboarding** | Nothing else matters if users can't start | New |
| 2 | **050-Infrastructure** | Core dependency | ✅ Exists |
| 3 | **068-Testing-Strategy** | Ensure foundation is solid | New |
| 4 | **051-Orchestrator** | Core functionality | ✅ Exists |
| 5 | **052-Dashboard** | User can see what's happening | ✅ Exists |
| 6 | **E2E Test Suite** | Validate the above works | Part of 068 |

**Definition of Done**: 
- New user runs 5 commands, has working cluster
- E2E test passes: init → up → run → show → destroy

---

### Phase 2: Hardening (Weeks 4-6) 🔴 CRITICAL

**Goal**: Production-ready (secure, reliable, recoverable)

| Order | Work | Why? | Spec |
|-------|------|------|------|
| 7 | **065-API-Integration** | Web dashboard needs contracts | New |
| 8 | **060-Security-Hardening** | Can't run untrusted code without this | ✅ Exists |
| 9 | **066-Data-Migration** | Users need upgrade path | New |
| 10 | **067-Operations-Runbook** | Production needs incident response | New |
| 11 | **Backup/DR Implementation** | Part of 066 | New |

**Definition of Done**:
- Security audit passes (network isolated, non-root)
- Can restore from backup in <1 hour
- Runbook covers top 10 incidents

---

### Phase 3: Intelligence (Weeks 7-9) 🟡 IMPORTANT

**Goal**: Self-managing, cost-optimized

| Order | Work | Why? | Spec |
|-------|------|------|------|
| 12 | **055-Run-Analytics** | Collect data for optimization | ✅ Exists |
| 13 | **056-Cost-Management** | Track spend | ✅ Exists |
| 14 | **054-Cron-Monitoring** | Ensure reliability | ✅ Exists |
| 15 | **061-In-Cluster-Optimizer** | Self-improvement (needs data from 12-14) | ✅ Exists |

**Definition of Done**:
- System proposes first optimization
- A/B test runs automatically
- Cost savings >10% vs baseline

---

### Phase 4: Polish (Weeks 10+) 🟢 LOWER

**Goal**: Delightful developer experience

| Order | Work | Why Last? | Spec |
|-------|------|-----------|------|
| 16 | **069-Developer-Experience** | SDK, local dev, debugging | New |
| 17 | **Documentation Generator** | Keep specs in sync | Tool |
| 18 | **Multi-region** | Scale needs | Future |
| 19 | **Compliance/SLA** | Enterprise needs | Future |

---

## Critical Specs to Write Now

### 🔴 P0: Must Write Before Implementation

**070-User-Onboarding.md**:
- 5-minute quickstart: curl | bash → first run
- Interactive wizard for configuration
- Pre-flight validation (ports, SSH keys, cloud tokens)
- Common errors and solutions
- Troubleshooting flowchart

**065-API-Integration.md**:
- REST API specification (OpenAPI/Swagger)
- WebSocket for real-time updates
- Authentication (JWT, service accounts)
- LLM provider proxy (rate limiting, failover)
- GitHub webhook handlers

**068-Testing-Strategy.md**:
- Test pyramid: unit → integration → E2E
- E2E: k3d cluster, full workflow
- Contract tests: K8s API compatibility
- Chaos: Pod kills, network partitions

**066-Data-Migration.md**:
- VM (ralph-1) → k3s migration procedure
- SQLite export/import
- PVC backup/restore to S3
- Disaster recovery runbook

**067-Operations-Runbook.md**:
- Incident response procedures
- Common alerts and fixes
- Capacity planning guide
- Upgrade procedures (k3s, Fabrik)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| No onboarding → users can't start | High | Critical | Write 070 **now** |
| No API spec → web dashboard blocked | High | High | Write 065 before Phase 2 |
| No testing → regressions in prod | High | Critical | Write 068, implement E2E |
| No migration → existing users stranded | Medium | High | Write 066 before VM sunset |
| No runbook → outages extended | Medium | High | Write 067 before production |
| Missing specs discovered mid-impl | Medium | Medium | Weekly spec review meetings |

---

## Recommended Next Actions

### Immediate (This Week)

1. **Write 070-User-Onboarding.md** - Blocks everything else
2. **Review all 050-061 for consistency** - Ensure they work together
3. **Prioritize acceptance criteria** - What MUST work for MVP?

### Short Term (Next 2 Weeks)

4. **Write 065-API-Integration.md** - Unblocks web dashboard implementation
5. **Write 068-Testing-Strategy.md** - Foundation for quality
6. **Create GitHub issues** - From acceptance criteria in all specs

### Medium Term (Before Production)

7. **Write 066-Data-Migration.md** - For VM users
8. **Write 067-Operations-Runbook.md** - For production readiness
9. **Implement E2E test suite** - Validate entire stack

---

## Summary: The 5 Missing Pillars

We have **architecture** (8 specs). We're missing:

1. **🚪 Entry** (070): How users get in
2. **🔌 Interface** (065): How systems connect
3. **🧪 Validation** (068): How we know it works
4. **🚚 Transition** (066): How we move forward
5. **🚨 Response** (067): How we fix breakage

**Total specs needed for production**: 8 (existing) + 5 (critical gaps) = 13 specs

**Estimated total size**: 170KB + 80KB = 250KB

**Recommended**: Write 070, 065, 068 **this week** before any implementation starts.
