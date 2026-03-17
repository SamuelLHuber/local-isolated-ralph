# Spec: CLI Verification Map

> Explicit spec-to-verification mapping for all Fabrik CLI lifecycle features

**Status**: active  
**Version**: 1.1.0  
**Last Updated**: 2026-03-17  
**Supersedes**: Ad-hoc verification tracking

---

## Changelog

- **v1.0.0** (2026-03-12): Initial verification map covering all active CLI features
- **v1.1.0** (2026-03-17): Added verification map for shared credential bundles, overrides, and refresh visibility

---

## Identity

**What**: A comprehensive mapping of every CLI feature to its verification layers, enabling atomic task completion and ensuring no feature lacks defined verification.

**Why**: Verification-first development requires explicit paths. This document ensures every acceptance criterion has a named verification target and every cluster-facing feature has a k3d check.

**Not**: A replacement for specs or test files. This is the index that ties them together.

---

## Goals

1. **Atomic check-off**: Every feature can be marked done with explicit verification references
2. **No orphaned features**: All active CLI commands appear in this map
3. **Layered verification**: Unit, integration, k3d, and production-parity checks are explicitly named
4. **Spec traceability**: Every entry links to its originating spec acceptance criteria

---

## Design Principles

- Verification is built before or alongside implementation, never after
- Cluster-facing features require k3d verification as a minimum
- Production-parity checks are documented but run selectively
- Mock-based tests are integration tests when they verify command behavior

---

## Verification Layers

| Layer | Command | Purpose | Scope |
|-------|---------|---------|-------|
| L1 | `make verify-cli-unit` | Fast deterministic logic | All `*_test.go` files |
| L2 | Mock-based integration | Invariant-focused behavior tests | `internal/runs/k8s_test.go`, `cmd/*_test.go` |
| L3 | `make verify-cli-k3d` | Single-node cluster proof | `internal/run/integration_k3d_test.go` (dev-single) |
| L4 | `FABRIK_K3D_CLUSTER=dev-multi` | Multi-node proof | Same test file, different cluster |
| L5 | Verifier Jobs | Cloud-cluster validation | Workflow-dispatched child Jobs |
| L6 | Rootserver k3s | Production parity | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) |

---

## Feature-to-Verification Map

### 1. Runs Inspection (`fabrik runs list`, `fabrik runs show`, `fabrik run logs`)

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Acceptance Criteria 5, 6, 7

**Feature description**: List and inspect Fabrik runs directly from Kubernetes metadata and pod logs.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | List output formatting | `cmd/runs_test.go:TestRunsListOutputsTable` |
| L1 Unit | JSON output format | `cmd/runs_test.go:TestRunsListOutputsJSON` |
| L1 Unit | Name-only output | `cmd/runs_test.go:TestRunsListOutputsNames` |
| L1 Unit | Show table output | `cmd/runs_test.go:TestRunsShowOutputsTable` |
| L1 Unit | Show JSON output | `cmd/runs_test.go:TestRunsShowOutputsJSON` |
| L1 Unit | Logs retrieval | `cmd/runs_test.go:TestRunLogsReturnsLogs` |
| L2 Integration | List from Jobs/CronJobs | `internal/runs/k8s_test.go:TestListReturnsRunsFromJobsAndCronJobs` |
| L2 Integration | Show by run ID | `internal/runs/k8s_test.go:TestShowReturnsRunDetailsByID` |
| L2 Integration | Show missing run error | `internal/runs/k8s_test.go:TestShowReturnsErrorForMissingRun` |
| L2 Integration | Logs retrieval flow | `internal/runs/k8s_test.go:TestLogsReturnsPodLogs` |
| L2 Integration | Child job detection | `internal/runs/k8s_test.go:TestChildJobDetection` |
| L2 Integration | Status from conditions | `internal/runs/k8s_test.go:TestJobStatusFromConditions` |
| L2 Integration | Parse status annotation | `internal/runs/k8s_test.go:TestParseStatusAnnotation` |
| L3 k3d | Runs list on real cluster | Manual: `fabrik runs list` against dev-single |
| L4 Multi | Cross-cluster listing | Manual: configure dev-multi context |

**Acceptance criteria coverage**:
- [x] `fabrik runs list` queries K8s directly, returns all runs across configured clusters
- [x] `fabrik runs show --id <run-id>` returns current phase, task, progress from pod labels
- [x] Command output is stable enough to script against

**Completion status**: [done]

---

### 2. Run Cancellation (`fabrik run cancel --id <run-id>`)

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Acceptance Criteria 8

**Feature description**: Cancel a running Fabrik run by deleting its Kubernetes Job.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | Cancel command output | `cmd/runs_test.go:TestRunCancel` |
| L1 Unit | Cancel finished job | `cmd/runs_test.go:TestRunCancelFinishedJob` |
| L1 Unit | Cancel missing run | `cmd/runs_test.go:TestRunCancelMissingRun` |
| L2 Integration | Delete Job resource | `internal/runs/k8s_test.go:TestCancelDeletesJob` |
| L2 Integration | Active job cancel | `internal/runs/k8s_test.go:TestCancelActiveJob` |
| L2 Integration | Succeeded job cleanup | `internal/runs/k8s_test.go:TestCancelSucceededJob` |
| L2 Integration | Failed job cleanup | `internal/runs/k8s_test.go:TestCancelFailedJob` |
| L2 Integration | CronJob cancel | `internal/runs/k8s_test.go:TestCancelCronJob` |
| L2 Integration | Child job cancel | `internal/runs/k8s_test.go:TestCancelCronJobChildJob` |
| L2 Integration | Missing run error | `internal/runs/k8s_test.go:TestCancelMissingRun` |
| L2 Integration | RBAC error handling | `internal/runs/k8s_test.go:TestCancelRBACPermissionDenied` |
| L2 Integration | Pending job cancel | `internal/runs/k8s_test.go:TestCancelPendingJob` |
| L2 Integration | Phase info in result | `internal/runs/k8s_test.go:TestCancelResultHasPhaseInfo` |
| L3 k3d | Active job cancellation | Manual against dev-single cluster |

**Acceptance criteria coverage**:
- [x] `fabrik run cancel --id <run-id>` deletes Job, cascading to pod
- [x] Status/output clearly indicates what was cancelled
- [x] Cancellation does not leave ambiguous state

**Completion status**: [done]

---

### 3. Run Resume (`fabrik run resume --id <run-id>`)

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Acceptance Criteria 9, 29, 30

**Feature description**: Resume a stuck Fabrik run by deleting its pod, causing Job controller to recreate it with the same specification.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | Resume command output | `cmd/runs_test.go:TestRunResume` |
| L1 Unit | RBAC error handling | `cmd/runs_test.go:TestRunResumeRBACError` |
| L2 Integration | Resume deletes pod | `internal/runs/k8s_test.go:TestResumeDeletesPod` |
| L2 Integration | Immutable image check | `internal/runs/k8s_test.go:TestResumeFailsWithMutableImage` |
| L2 Integration | Succeeded job rejection | `internal/runs/k8s_test.go:TestResumeFailsWhenJobSucceeded` |
| L2 Integration | Missing PVC rejection | `internal/runs/k8s_test.go:TestResumeFailsWhenPVCMissing` |
| L2 Integration | Pending PVC rejection | `internal/runs/k8s_test.go:TestResumeFailsWhenPVCPending` |
| L2 Integration | Missing job error | `internal/runs/k8s_test.go:TestResumeFailsWhenJobNotFound` |
| L2 Integration | RBAC permission error | `internal/runs/k8s_test.go:TestResumeFailsWithRBACPermissionError` |
| L3 k3d | Resume preserves PVC | `internal/run/integration_k3d_test.go:TestK3dResumePreservesPVCAndImageDigest` |
| L4 Multi | Resume on multi-node | Same test with `FABRIK_K3D_CLUSTER=dev-multi` |

**Acceptance criteria coverage**:
- [x] `fabrik run resume --id <run-id>` deletes stuck pod, Job recreates it
- [x] Resume uses the same image digest as the original run
- [x] PVC persists across pod restarts
- [x] Smithers resumes from last completed task after pod restart

**Completion status**: [done]

---

### 4. Run Dispatch (`fabrik run` - base dispatch)

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Acceptance Criteria 2, 22

**Feature description**: Dispatch a Fabrik run to Kubernetes with proper resource rendering and validation.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | Render without mutation | `internal/run/dispatch_test.go:TestExecuteRenderOnlyNoClusterMutation` |
| L1 Unit | Cron schedule rendering | `internal/run/dispatch_test.go:TestExecuteRenderOnlyCronRendersCronJobWithoutPVC` |
| L1 Unit | Dry-run validation | `internal/run/dispatch_test.go:TestExecuteDryRunWorkflowDoesNotApplyCodexSecret` |
| L1 Unit | Dry-run with env file | `internal/run/dispatch_test.go:TestExecuteDryRunWithEnvFileAndGitHubRepoAcrossNamedClusters` |
| L1 Unit | Dry-run missing env | `internal/run/dispatch_test.go:TestExecuteDryRunWithMissingProjectEnvFailsBeforeKubectlApply` |
| L1 Unit | Live dispatch no-wait | `internal/run/dispatch_test.go:TestExecuteLiveDispatchWithoutWaitVerifiesPodStartAndDoesNotSync` |
| L1 Unit | Live with env file | `internal/run/dispatch_test.go:TestExecuteLiveDispatchWithEnvFileAppliesEnvSecretsInSourceAndRunNamespaces` |
| L1 Unit | Live cron create | `internal/run/dispatch_test.go:TestExecuteLiveCronCreateVerifiesCronJobAndSkipsJobFlow` |
| L1 Unit | Live cron missing env | `internal/run/dispatch_test.go:TestExecuteLiveCronWithMissingProjectEnvFailsBeforeApply` |
| L1 Unit | Wait success (ignore patch fail) | `internal/run/dispatch_test.go:TestExecuteWaitSuccessIgnoresMetadataPatchFailure` |
| L1 Unit | Wait failure returns error | `internal/run/dispatch_test.go:TestExecuteWaitFailureReturnsWaitErrorEvenIfMetadataPatchFails` |
| L1 Unit | Dry-run requires auth | `internal/run/dispatch_test.go:TestExecuteDryRunWorkflowRequiresCodexAuthFiles` |
| L1 Unit | Sync excludes | `internal/run/dispatch_test.go:TestSyncWorkdirExcludesMatchDocumentedBuildArtifacts` |
| L2 Integration | Fabrik sync rendering | `internal/run/dispatch_test.go:TestExecuteRenderOnlyWithFabrikSyncRendersSecretAndBootstrap` |
| L2 Integration | Project env rendering | `internal/run/dispatch_test.go:TestExecuteRenderOnlyWithProjectEnvRendersSecretMountAndEnvFrom` |
| L3 k3d | Render and dry-run | `internal/run/integration_k3d_test.go:TestK3dRenderAndDryRun` |
| L3 k3d | Project env injection | `internal/run/integration_k3d_test.go:TestK3dRunInjectsProjectEnvForCommandAndWorkflow` |
| L4 Multi | Env injection multi-node | Same test with `FABRIK_K3D_CLUSTER=dev-multi` |

**Acceptance criteria coverage**:
- [x] `fabrik run --spec x.json` creates Job that completes successfully
- [x] Image uses immutable references (digest enforcement in resume)
- [x] Base image pulls successfully

**Completion status**: [done]

---

### 5. Workflow Dispatch (`fabrik run --workflow-path`)

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Workflow execution model

**Feature description**: Dispatch a workflow-backed run with bundle mounting and Smithers invocation.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | Workflow bundle rendering | `internal/run/workflow_bundle_test.go` |
| L1 Unit | Help mentions filtered sync | `cmd/run_test.go:TestRunHelpMentionsFilteredSyncAndFabrikSync` |
| L2 Integration | Workflow + sync render | `internal/run/dispatch_test.go:TestExecuteRenderOnlyWithFabrikSyncRendersSecretAndBootstrap` |
| L3 k3d | Workflow cron | `internal/run/integration_k3d_test.go:TestK3dCronSchedulesCommandAndWorkflowJobs` |
| L3 k3d | Workflow env injection | `internal/run/integration_k3d_test.go:TestK3dRunInjectsProjectEnvForCommandAndWorkflow` |
| L3 k3d | Workflow with repo | `internal/run/integration_k3d_test.go:TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters` |
| L4 Multi | Workflow on multi-node | Same tests with `FABRIK_K3D_CLUSTER=dev-multi` |

**Acceptance criteria coverage**:
- [x] Workflow bundle mounting
- [x] Workflow startup
- [x] Repo-aware workflow execution

**Completion status**: [done]

---

### 6. CronJob Management (`fabrik run --cron`)

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Acceptance Criteria 23

**Feature description**: Create and manage scheduled CronJobs.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | Cron rendering | `internal/run/dispatch_test.go:TestExecuteRenderOnlyCronRendersCronJobWithoutPVC` |
| L1 Unit | Cron live create | `internal/run/dispatch_test.go:TestExecuteLiveCronCreateVerifiesCronJobAndSkipsJobFlow` |
| L1 Unit | Cron missing env | `internal/run/dispatch_test.go:TestExecuteLiveCronWithMissingProjectEnvFailsBeforeApply` |
| L2 Integration | List CronJobs | `internal/runs/k8s_test.go:TestListReturnsRunsFromJobsAndCronJobs` |
| L2 Integration | Cancel CronJob | `internal/runs/k8s_test.go:TestCancelCronJob` |
| L2 Integration | Child job detection | `internal/runs/k8s_test.go:TestChildJobDetection` |
| L3 k3d | Cron command path | `internal/run/integration_k3d_test.go:TestK3dCronSchedulesCommandAndWorkflowJobs` |
| L3 k3d | Cron workflow path | `internal/run/integration_k3d_test.go:TestK3dCronSchedulesCommandAndWorkflowJobs` |

**Acceptance criteria coverage**:
- [x] CronJob creates Jobs on schedule
- [x] Child jobs labeled with schedule-id
- [x] Cancel works on CronJobs and child jobs

**Completion status**: [done]

---

### 7. Environment Management (`fabrik env`)

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Acceptance Criteria 10-15, 16-20

**Feature description**: Manage project environment secrets in Kubernetes.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | Parse dotenv rejects duplicates | `internal/env/env_test.go:TestParseDotenvRejectsDuplicateKeys` |
| L1 Unit | Reject reserved keys | `internal/env/env_test.go:TestParseDotenvRejectsReservedSmithersKey` |
| L1 Unit | Render sorted | `internal/env/env_test.go:TestRenderDotenvSorted` |
| L1 Unit | Parse preserves quotes | `internal/env/env_test.go:TestParseDotenvPreservesUnbalancedQuotes` |
| L1 Unit | Parse strips matching quotes | `internal/env/env_test.go:TestParseDotenvStripsMatchingWrapperQuotesOnly` |
| L1 Unit | Write private file | `internal/env/env_test.go:TestWritePrivateFileTightensExistingPermissions` |
| L1 Unit | Upsert dotenv | `internal/env/env_test.go:TestUpsertDotenvValueUpdatesAndAppends` |
| L1 Unit | Env help mentions commands | `cmd/env_test.go:TestEnvHelpMentionsPullAndPromote` |
| L2 Integration | Root has env command | `cmd/env_test.go:TestRootCommandHasEnv` |
| L3 k3d | Env set/pull/run | Manual: `fabrik env set`, `fabrik env pull`, `fabrik env run` |
| L3 k3d | Env diff/promote | Manual: `fabrik env diff`, `fabrik env promote` |
| L4 Multi | Cross-cluster env | Manual against dev-multi |

**Acceptance criteria coverage**:
- [x] `fabrik env set --project myapp --env dev` creates Secret
- [x] `fabrik env pull --project myapp --env dev` writes dotenv-compatible output
- [x] `fabrik env run --project myapp --env dev -- <cmd>` runs with injected env
- [x] `fabrik env diff --project myapp --from dev --to staging` shows differences
- [x] `fabrik env promote --project myapp --from dev --to staging` copies values
- [x] Secrets mounted as files in `/etc/fabrik/env/` and injected as env vars
- [x] Reserved `SMITHERS_*` keys rejected from project env writes

**Completion status**: Partial - Core implemented, diff/promote need strengthening per todo item 5

---

### 8. Project ID Validation

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Acceptance Criteria 21

**Feature description**: DNS-1123 compliant project ID validation.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | DNS-1123 regex validation | Code review: `internal/run/options.go` (implied by `isValidDNS1123Label`) |
| L2 Integration | Rejection messaging | Manual test with invalid project ID |
| L3 k3d | Valid project acceptance | All k3d tests use `project: "demo"` |

**Acceptance criteria coverage**:
- [x] `--project` IDs validated against DNS-1123
- [x] Invalid project IDs rejected with clear error

**Completion status**: [done] (validation exists in render path)

---

### 9. Metadata and Labeling

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Acceptance Criteria 3, 4, 5

**Feature description**: Proper Kubernetes labels and annotations on Jobs and Pods.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | Label rendering | `internal/run/manifest.go` (inspected via render tests) |
| L2 Integration | Status annotation parse | `internal/runs/k8s_test.go:TestParseStatusAnnotation` |
| L2 Integration | Job to run info | `internal/runs/k8s_test.go:TestJobStatusFromConditions` |
| L3 k3d | Labels on real jobs | `internal/run/integration_k3d_test.go` (asserted via job queries) |

**Acceptance criteria coverage**:
- [x] Job pods show correct labels: `fabrik.sh/phase`, `fabrik.sh/task`, `fabrik.sh/status`
- [x] Job pods show correct annotations: `fabrik.sh/progress` as JSON
- [x] Smithers updates pod labels/annotations in real-time

**Completion status**: [done]

---

### 8. Shared Credential Bundles And Rotation

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Shared credential bundles, refreshable mount contract, separation of responsibilities, Kubernetes-native notification model

**Feature description**: Distribute cluster-shared credential bundles and run-scoped overrides into Fabrik jobs while preserving generic bundle semantics, helper-layer rotation, and live refresh visibility for cluster-backed directory mounts.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | Select cluster default bundle | `internal/run/credentials_test.go:TestResolveSharedCredentialBundleSelectsClusterDefault` |
| L1 Unit | Run override suppresses cluster default | `internal/run/credentials_test.go:TestResolveSharedCredentialBundleOverrideSuppressesDefault` |
| L1 Unit | Existing cluster Secret reference override | `internal/run/credentials_test.go:TestResolveSharedCredentialBundleSupportsExistingSecretReference` |
| L1 Unit | Precedence resolution | `internal/run/credentials_test.go:TestResolveSharedCredentialPrecedence` |
| L1 Unit | Render directory mount, not subPath | `internal/run/manifest_credentials_test.go:TestSharedCredentialBundleRendersDirectoryMount` |
| L1 Unit | Env-style shared credential projection | `internal/run/manifest_credentials_test.go:TestSharedCredentialEnvProjectionRendersDeterministically` |
| L1 Unit | Kubernetes Event reason mapping | `internal/run/credentials_test.go:TestSharedCredentialEventReasonMapping` |
| L2 Integration | Mirror shared bundle into run namespace | `internal/run/dispatch_credentials_test.go:TestExecuteLiveDispatchMirrorsSharedCredentialBundle` |
| L2 Integration | Run override uses run-only Secret | `internal/run/dispatch_credentials_test.go:TestExecuteLiveDispatchUsesRunScopedCredentialOverride` |
| L2 Integration | Override skips cluster default mount | `internal/run/dispatch_credentials_test.go:TestExecuteLiveDispatchOverrideSuppressesDefaultMount` |
| L2 Integration | Cluster-backed bundles avoid subPath | `internal/run/dispatch_credentials_test.go:TestExecuteRenderSharedCredentialBundleAvoidsSubPath` |
| L2 Integration | Missing bundle emits Kubernetes-native event metadata | `internal/run/dispatch_credentials_test.go:TestSharedCredentialFailureProducesEventMetadata` |
| L3 k3d | Env-style shared credential replacement affects next job | `internal/run/integration_k3d_test.go:TestK3dSharedEnvCredentialReplacementAffectsNextJob` |
| L3 k3d | Run-scoped env override suppresses default | `internal/run/integration_k3d_test.go:TestK3dRunScopedEnvCredentialOverrideSuppressesDefault` |
| L3 k3d | Cluster-backed file bundle visible to next job after replacement | `internal/run/integration_k3d_test.go:TestK3dSharedFileBundleReplacementAffectsNextJob` |
| L3 k3d | Running job sees updated cluster-backed directory bundle | `internal/run/integration_k3d_test.go:TestK3dRunningJobSeesUpdatedSharedDirectoryBundle` |
| L3 k3d | Codex helper rotation against shared pool | `internal/run/integration_k3d_test.go:TestK3dCodexHelperRotatesAcrossSharedPool` |
| L3 k3d | Claude helper rotation against shared pool | `internal/run/integration_k3d_test.go:TestK3dClaudeHelperRotatesAcrossSharedPool` |
| L3 k3d | Pi auth bundle mount and adjacent models config | `internal/run/integration_k3d_test.go:TestK3dPiAuthBundleWithAdjacentModelsConfig` |
| L4 Multi | Shared env credential replacement on multi-node | Same tests with `FABRIK_K3D_CLUSTER=dev-multi` |
| L4 Multi | Shared file bundle replacement on multi-node | Same tests with `FABRIK_K3D_CLUSTER=dev-multi` |
| L5 Verifier Jobs | Child verifier jobs validate in-cluster secret replacement and helper rotation | Workflow-dispatched verifier jobs in same cluster |
| L6 Rootserver | Rootserver parity for shared bundle replacement and override suppression | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) |

**Acceptance criteria coverage**:
- [ ] Cluster-shared credential bundles are modeled as named Secrets, not one monolithic secret payload requirement
- [ ] Explicit run-scoped overrides suppress the cluster default for the same target
- [ ] Cluster-backed credential bundles mount as directories, not `subPath`
- [ ] New jobs always see updated cluster-backed credentials
- [ ] Running jobs can observe updated cluster-backed credentials when helpers re-read the mounted directory
- [ ] Fabrik remains generic while helper-layer logic owns provider-specific rotation and auth parsing
- [ ] Kubernetes-native event emission exists for missing, exhausted, or helper-reported invalid credentials

**Completion status**: [planned]

---

### 10. PVC and Storage Management

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Acceptance Criteria 9, 28

**Feature description**: Persistent storage for Smithers state across pod restarts.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | PVC size rendering | `internal/run/manifest.go` (inspected via render tests) |
| L2 Integration | PVC exists check | `internal/runs/k8s_test.go:TestResumeFailsWhenPVCMissing` |
| L2 Integration | PVC bound check | `internal/runs/k8s_test.go:TestResumeFailsWhenPVCPending` |
| L3 k3d | Ephemeral workspace PVC | `internal/run/integration_k3d_test.go:assertEphemeralWorkspacePVC` |
| L3 k3d | Resume preserves PVC | `internal/run/integration_k3d_test.go:TestK3dResumePreservesPVCAndImageDigest` |
| L4 Multi | PVC multi-node | Same tests with `FABRIK_K3D_CLUSTER=dev-multi` |

**Acceptance criteria coverage**:
- [x] PVC persists across pod restarts
- [x] PVC deleted 7 days after Job completion (configurable via TTL)

**Completion status**: [done]

---

### 11. Image Immutability

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Immutable Images section

**Feature description**: Jobs must use immutable image references (digest or pinned tag).

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L2 Integration | Mutable image rejection | `internal/runs/k8s_test.go:TestResumeFailsWithMutableImage` |
| L3 k3d | Resume digest preservation | `internal/run/integration_k3d_test.go:TestK3dResumePreservesPVCAndImageDigest` |
| L4 Multi | Digest preservation multi | Same test with `FABRIK_K3D_CLUSTER=dev-multi` |

**Acceptance criteria coverage**:
- [x] Jobs must use immutable image references
- [x] Resume uses exact same image digest as original run

**Completion status**: [done]

---

### 12. Preflight Checks

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Validation requirements

**Feature description**: Pre-dispatch validation and requirement collection.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | GitHub note without env file | `internal/run/preflight_test.go:TestCollectPreflightRequirementsAddsGitHubNoteWithoutEnvFile` |
| L1 Unit | GitHub token requirement | `internal/run/preflight_test.go:TestCollectPreflightRequirementsAddsGitHubTokenRequirement` |
| L1 Unit | Interactive token write | `internal/run/preflight_test.go:TestSatisfyPreflightRequirementsInteractiveWritesGitHubToken` |

**Acceptance criteria coverage**:
- [x] Shared credential secret mirroring
- [x] GitHub token requirement detection

**Completion status**: [done]

---

### 13. Rootserver k3s Parity (L6 Verification)

**Spec tie-in**: [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) - Full parity checklist

**Feature description**: Production-parity verification on real single-node k3s rootservers (not k3d).

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L6 Manual | Cluster connectivity | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) - Check 1 |
| L6 Manual | Image distribution (remote registry) | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) - Check 2 |
| L6 Manual | PVC provisioning | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) - Check 3 |
| L6 Manual | Real k3s dispatch | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) - Check 4 |
| L6 Manual | Environment injection | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) - Check 5 |
| L6 Manual | Repo-aware workflow execution | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) - Check 6 |
| L6 Manual | PVC persistence | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) - Check 7 |
| L6 Manual | Resume with immutable digest | [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md) - Check 8 |

**Acceptance criteria coverage**:
- [ ] Local verification is not hiding real k3s differences
- [ ] Image distribution works on remote registries
- [ ] Runtime assumptions hold outside k3d

**Completion status**: [ ]

---

## Future Task Verification Templates

When adding new tasks to `todo.md`, use this template:

```markdown
### N. Task Name

**Spec tie-in**: [Spec file and section]

**Feature description**: [Brief description]

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | [Test name] | `[file]:[test]` |
| L2 Integration | [Test name] | `[file]:[test]` |
| L3 k3d | [Test name or manual step] | `[file]:[test]` or Manual: `[command]` |
| L4 Multi | [Test name or manual step] | `[file]:[test]` or Manual: `[command]` |

**Acceptance criteria coverage**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

**Completion status**: [ ]
```

---

## Required Checks Before Marking Done

For any feature to be marked [done], the following must pass:

1. **Unit tests**: `make verify-cli-unit` passes
2. **Integration tests**: All mock-based tests in the feature's test files pass
3. **k3d single-node**: Feature verified against `dev-single` cluster (automated or manual)
4. **Code review**: All acceptance criteria from linked specs have coverage entries in this map

Required for execution-semantic changes:

5. **k3d multi-node**: Feature verified against `dev-multi` cluster
6. **Production parity**: Manual verification against real k3s rootserver using [`059-k3s-rootserver-parity.md`](./059-k3s-rootserver-parity.md)

---

### 14. Shared Credentials (`fabrik credentials`)

**Spec tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md) - Secret classes, Runtime injection rules

**Feature description**: Manage the cluster-wide `fabrik-credentials` shared secret, mirror it to run namespaces, and mount it as a directory in workflow pods.

| Verification | Target | File/Command |
|-------------|--------|--------------|
| L1 Unit | Reserved key rejection | `internal/credentials/credentials_test.go:TestIsReservedKeyRejectsSmithersPrefix` |
| L1 Unit | Provider key acceptance | `internal/credentials/credentials_test.go:TestIsReservedKeyAcceptsProviderKeys` |
| L1 Unit | Dotenv parsing | `internal/credentials/credentials_test.go:TestParseDotenvFileRaw` |
| L1 Unit | Duplicate key rejection | `internal/credentials/credentials_test.go:TestParseDotenvFileRawRejectsDuplicates` |
| L1 Unit | Directory mount rendering | `internal/run/manifest_credentials_test.go:TestBuildManifestsWorkflowUsesSharedCredentialsDirectoryMount` |
| L1 Unit | No codex-auth references | `internal/run/manifest_credentials_test.go:TestBuildManifestsWorkflowDoesNotUseCodexAuthSubPathMounts` |
| L1 Unit | Command jobs no creds | `internal/run/manifest_credentials_test.go:TestBuildManifestsCommandJobDoesNotMountCredentials` |
| L1 Unit | Precedence: both present | `internal/run/manifest_credentials_test.go:TestBuildManifestsCredentialPrecedenceProjectEnvAndCredentials` |
| L2 Integration | Dry-run no cred apply | `internal/run/dispatch_test.go:TestExecuteDryRunWorkflowDoesNotApplySharedCredentialSecret` |
| L2 Integration | No local file required | `internal/run/dispatch_test.go:TestExecuteDryRunWorkflowDoesNotRequireLocalCredentialFiles` |
| L2 Integration | Render uses cred mount | `internal/run/dispatch_test.go:TestExecuteRenderOnlyWorkflowUsesSharedCredentialsMount` |
| L3 k3d | Credential set/ls | Manual: `fabrik credentials set/ls --context k3d-dev-single` |
| L3 k3d | Mirror to run namespace | Manual: dispatch workflow and verify secret in fabrik-runs |
| L3 k3d | Directory mount visible | Manual: describe pod and check /etc/fabrik/credentials mount |
| L4 Multi | Same on multi-node | Manual: `fabrik credentials set/ls --context k3d-dev-multi` |

**Acceptance criteria coverage**:
- [x] `fabrik-credentials` is the canonical cluster-wide source of truth for shared runtime credentials
- [x] Shared credentials mounted as directory (not subPath) at `/etc/fabrik/credentials`
- [x] Project env overrides shared credentials for conflicting keys (envFrom vs file mount)
- [x] Reserved `SMITHERS_*`/`FABRIK_*`/`KUBERNETES_*` keys rejected from shared credentials
- [x] Old `codex-auth` subPath mount pattern replaced

**Completion status**: [partial] — Core model, CLI commands, manifest rendering, k3d verification done. Credential bundle/pool rotation, per-agent adapters, and notification path remain in todo #1.

---

## Verification Commands Reference

```bash
# Run all unit tests
make verify-cli

# Run k3d integration tests (requires dev-single cluster)
make verify-cli-k3d

# Run k3d tests against multi-node cluster
FABRIK_K3D_CLUSTER=dev-multi make verify-cli-k3d

# Run specific test
FABRIK_K3D_E2E=1 go test ./internal/run -run TestK3dResumePreservesPVCAndImageDigest -v
```

---

## Glossary

- **L1/L2/L3/L4/L5/L6**: Verification layers 1-6 as defined in `todo.md`
- **Mock-based integration**: Tests using mock kubectl binaries to verify command behavior
- **k3d integration**: Tests running against real k3d clusters
- **AC**: Acceptance Criteria from linked specs

---

## Changelog

- **v1.0.0** (2026-03-12): Initial map covering 12 active CLI features with 60+ named verification targets
