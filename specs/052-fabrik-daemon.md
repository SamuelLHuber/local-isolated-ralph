# Spec: Fabrik Daemon (SUPERSEDED)

> **STATUS**: Superseded by direct K8s API approach in specs 050 and 051

**Status**: superseded  
**Version**: 1.0.0-superseded  
**Last Updated**: 2026-02-16  
**Superseded By**: `050-k3s-orchestrator`, `051-k3s-orchestrator-dashboard`

---

## This Spec is Superseded

After review, we determined a **daemon is unnecessary**. Like `kubectl` and `k9s`, we use direct K8s API access:

```
Before (this spec):  CLI/TUI → Daemon → K8s API
After (specs 050/051): CLI/TUI → K8s API (direct)
```

**Rationale**:
- k9s doesn't have a daemon - it queries K8s directly
- kubectl doesn't have a daemon - it uses kubeconfig
- Adding a daemon adds complexity (another process to manage)
- K8s Watch API provides efficient real-time updates without persistent daemon
- Optional SQLite cache for performance (not required)

---

## See Instead

- **Spec 050**: `specs/050-k3s-orchestrator.md` - K8s-native execution
- **Spec 051**: `specs/051-k3s-orchestrator-dashboard.md` - Direct K8s dashboard (TUI + Web)

Key changes:
- No daemon process
- No API server deployment
- Direct `@kubernetes/client-node` usage
- K8s labels/annotations for status (Smithers writes directly)
- Optional local cache (SQLite) for TUI performance

---

## Historical Context

This spec was drafted to solve VM architecture problems:
- Dual database (host vs VM)
- Stale status due to heartbeat failures
- SSH/exec overhead for every query

The k3s-native approach in specs 050/051 solves these more elegantly:
- Single source of truth (K8s etcd)
- Native K8s watches (reliable, no heartbeats)
- Direct API access (no SSH)
- In-cluster observability (LAOS)

---

## Changelog

- **v1.0.0-superseded** (2026-02-16): Marked as superseded in favor of direct K8s approach
- **v1.0.0** (2026-02-16): Original daemon specification (never implemented)
