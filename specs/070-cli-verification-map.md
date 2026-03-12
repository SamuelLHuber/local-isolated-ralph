# Spec: CLI Verification Map

> Explicit spec-to-verification mapping for all CLI lifecycle features

**Status**: active  
**Version**: 1.0.0  
**Last Updated**: 2026-03-12  
**Tie-in**: [`051-k3s-orchestrator.md`](./051-k3s-orchestrator.md), [`057-k3s-local-testing.md`](./057-k3s-local-testing.md)

---

## Changelog

- **v1.0.0** (2026-03-12): Initial verification map covering all active CLI features

---

## Identity

**What**: A comprehensive mapping from CLI features to their verification paths (unit tests, integration tests, k3d checks, and production-parity checks).

**Why**: 
- Every acceptance criterion must have a named verification path
- Every cluster-facing feature must have a k3d check
- Future roadmap items can be added with pre-defined verification requirements

**Not**: 
- A replacement for the actual specs
- A test implementation guide (see test files for that)

---

## Goals

1. **Complete coverage**: Every CLI feature appears in the map
2. **Named verification paths**: Each acceptance criterion links to specific tests
3. **Layered verification**: Fast unit tests first, k3d integration second, production-parity optional
4. **Atomic check-offs**: Each verification can be independently marked complete
5. **Future-proof**: New features added to this file include verification requirements upfront

---

## Design Principles

- Verification-first: Build/update verification before claiming feature complete
- Layered validation: Unit → Integration → k3d → Production-parity
- Deterministic gates: No ad hoc cluster-only verification
- Immutable specs: Verification map versioned with specs

---

## Verification Layers

| Layer | Purpose | Execution | Trigger |
|-------|---------|-----------|---------|
| Unit | Fast, deterministic, no cluster | `go test ./...` (excludes k3d) | Every PR |
| Integration | Cross-module behavior, mock cluster | `go test ./...` with mocks | Every PR |
| k3d | Real cluster behavior validation | `make verify-cli-k3d` | k3d-gated changes |
| Production-parity | Cloud cluster equivalence | Manual / periodic | Pre-release |

---

## Feature-to-Verification Map

### 1. Run Lifecycle Commands

#### 1.1 `fabrik run` (Dispatch)

**Acceptance Criteria** (from 051-k3s-orchestrator.md):
- [ ] `fabrik run --spec x.json` creates Job that completes successfully
- [ ] Job pods show correct labels: `fabrik.sh/phase`, `fabrik.sh/task`, `fabrik.sh/status`
- [ ] Job pods show correct annotations: `fabrik.sh/progress` as JSON
- [ ] `--project` IDs validated against DNS-1123
- [ ] Invalid project IDs rejected with clear error
- [ ] Base image `ghcr.io/fabrik/smithers:latest` pulls successfully
- [ ] Image pinning enforced (digest or pinned tag)
- [ ] Resource limits enforced (jobs killed if memory > limit)
- [ ] 24-hour activeDeadlineSeconds enforced

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Job creation | `TestExecuteRenderOnlyNoClusterMutation` | `TestExecuteLiveDispatchWithoutWaitVerifiesPodStartAndDoesNotSync` | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` | Manual EKS/GKE validation |
| Label correctness | `TestExecuteRenderOnlyWithProjectEnvRendersSecretMountAndEnvFrom` | `TestExecuteLiveDispatchWithoutWaitVerifiesPodStartAndDoesNotSync` | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` | Label inspection on prod |
| Annotation correctness | `TestExecuteRenderOnlyWithProjectEnvRendersSecretMountAndEnvFrom` | `TestExecuteWaitSuccessIgnoresMetadataPatchFailure` | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` | Annotation inspection on prod |
| DNS-1123 validation | `TestValidateOptions` (project ID regex) | N/A | N/A | N/A |
| Image pinning | `TestValidateOptionsRejectsMutableImage`, `TestValidateOptionsAcceptsDigest` | N/A | `TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters` (digest validation) | Image ref audit |
| Resource limits | `TestExecuteRenderOnlyNoClusterMutation` (manifest validation) | N/A | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` (manifest inspection) | Resource quota validation |

**Test Files**:
- `internal/run/dispatch_test.go` - Core dispatch logic
- `internal/run/options_test.go` - Option validation
- `internal/run/preflight_test.go` - Preflight checks
- `internal/run/integration_k3d_test.go` - k3d validation

#### 1.2 `fabrik run --cron` (CronJob Scheduling)

**Acceptance Criteria**:
- [ ] CronJob creates Jobs on schedule
- [ ] `fabrik schedule create --spec specs/nightly.json --cron "0 2 * * *"`

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| CronJob creation | `TestExecuteRenderOnlyCronRendersCronJobWithoutPVC` | `TestExecuteLiveCronCreateVerifiesCronJobAndSkipsJobFlow` | `TestK3dCronSchedulesCommandAndWorkflowJobs` | Cron schedule validation |
| Schedule trigger | N/A | N/A | `TestK3dCronSchedulesCommandAndWorkflowJobs` (waits for tick) | Schedule fidelity check |

**Test Files**:
- `internal/run/dispatch_test.go` - Cron dispatch logic
- `internal/run/integration_k3d_test.go` - k3d cron validation

#### 1.3 `fabrik run resume`

**Acceptance Criteria**:
- [ ] `fabrik run resume --id <run-id>` deletes stuck pod, Job recreates
- [ ] Resume uses the exact same image digest as the original run
- [ ] PVC persists across pod restarts
- [ ] Smithers resumes from last completed task (no progress loss)

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Resume requires ID | `TestResumeRunRequiresRunID` | N/A | N/A | N/A |
| Resume finds job | `TestResumeRunFailsWhenJobNotFound` | N/A | `TestK3dResumePreservesPVCAndImageDigest` | Resume on prod cluster |
| Image digest preservation | `TestResumeRunFailsWithMutableImage` | N/A | `TestK3dResumePreservesPVCAndImageDigest` (asserts same digest) | Image consistency audit |
| PVC preservation | N/A | N/A | `TestK3dResumePreservesPVCAndImageDigest` (asserts same PVC) | Storage persistence check |
| Pod deletion/recreate | `TestResumeRunSucceedsAndDeletesPod` | N/A | `TestK3dResumePreservesPVCAndImageDigest` | Node failure simulation |

**Test Files**:
- `internal/run/resume_test.go` - Unit tests
- `internal/run/integration_k3d_test.go` - k3d resume validation (`TestK3dResumePreservesPVCAndImageDigest`)

#### 1.4 `fabrik run cancel`

**Acceptance Criteria**:
- [ ] `fabrik run cancel --id <run-id>` deletes Job, cascading to pod
- [ ] Works for both Jobs and CronJobs
- [ ] Clearly indicates what was cancelled and whether run was active

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Cancel requires ID | `TestCancelRunRequiresRunID` | N/A | N/A | N/A |
| Cancel not found | `TestCancelRunFailsWhenRunNotFound` | N/A | N/A | N/A |
| Cancel active Job | `TestCancelRunSucceedsForActiveJob` | N/A | `TestK3dCancelDeletesJobAndCascadesToPod` | Cancel on prod |
| Cancel finished Job | `TestCancelRunSucceedsForFinishedJob` | N/A | N/A | Terminal state check |
| Cancel CronJob | `TestCancelRunSucceedsForCronJob` | N/A | `TestK3dCronSchedulesCommandAndWorkflowJobs` (cleanup) | Cron cancellation |
| Cancel child Job | `TestCancelRunSucceedsForCronChildJob` | N/A | `TestK3dCronSchedulesCommandAndWorkflowJobs` (cleanup) | Child job cleanup |
| Cascading pod deletion | N/A | N/A | `TestK3dCancelDeletesJobAndCascadesToPod` (asserts pod deleted) | GC validation |

**Test Files**:
- `internal/run/cancel_test.go` - Unit tests
- `internal/run/integration_k3d_test.go` - k3d cancel validation (`TestK3dCancelDeletesJobAndCascadesToPod`)

#### 1.5 `fabrik run logs`

**Acceptance Criteria**:
- [ ] `fabrik run logs --id <run-id>` retrieves pod logs
- [ ] Streams logs from the correct pod associated with the run

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Logs requires ID | `TestRunLogsRequiresID` | N/A | N/A | N/A |
| Logs retrieves from pod | `TestRunLogsRetrievesPodLogs` | N/A | Manual kubectl logs comparison | Log streaming on prod |

**Test Files**:
- `internal/run/inspect_test.go` - Logs tests

---

### 2. Run Inspection Commands

#### 2.1 `fabrik runs list`

**Acceptance Criteria**:
- [ ] `fabrik runs list` queries K8s directly, returns all runs across configured clusters
- [ ] Output is tabular and stable for scripting
- [ ] Shows ID, project, phase, status, age, resource kind

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Label selector query | `TestListRunsQueriesJobsWithCorrectLabelSelector` | N/A | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` (list after create) | Cross-cluster list |
| Empty result handling | `TestListRunsHandlesEmptyResult` | N/A | N/A | Empty namespace check |
| Output format | `TestListRunsQueriesJobsWithCorrectLabelSelector` | N/A | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` (output inspection) | Format consistency |

**Test Files**:
- `internal/run/inspect_test.go` - List tests

#### 2.2 `fabrik runs show`

**Acceptance Criteria**:
- [ ] `fabrik runs show --id <run-id>` returns current phase, task, progress from pod labels
- [ ] Shows detailed information: phase, task, progress, timestamps, image digest, outcome

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Show requires ID | `TestShowRunRequiresID` | N/A | N/A | N/A |
| Returns job details | `TestShowRunReturnsJobDetails` | N/A | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` (show after create) | Show on prod run |
| Label/annotation parsing | `TestFetchRunPodsParsesContainerStatusCorrectly` | N/A | Label inspection in k3d | Annotation fidelity |

**Test Files**:
- `internal/run/inspect_test.go` - Show tests

---

### 3. Environment Management Commands

#### 3.1 `fabrik env set`

**Acceptance Criteria**:
- [ ] `fabrik env set --project myapp --env dev` creates Secret `fabrik-env-myapp-dev`
- [ ] `--from-file` imports dotenv-style values
- [ ] Merge-by-default, `--replace` for full replacement
- [ ] `--unset KEY` removes keys
- [ ] Reserved `SMITHERS_*` keys rejected
- [ ] Invalid dotenv lines rejected clearly
- [ ] Duplicate keys in same import rejected

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Secret creation | `TestUpsertDotenvValueUpdatesAndAppends` | N/A | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` (ensureProjectEnvSecret) | Secret creation on prod |
| From-file import | `TestParseDotenv*` tests | N/A | `TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters` | File import on prod |
| Merge behavior | `TestUpsertDotenvValueUpdatesAndAppends` | N/A | Manual secret content check | Merge on prod |
| Replace behavior | Covered in env internal tests | N/A | N/A | Replace on prod |
| Unset behavior | Covered in env internal tests | N/A | N/A | Unset on prod |
| Reserved key rejection | `TestParseDotenvRejectsReservedSmithersKey` | N/A | N/A | Reserved key check |
| Duplicate key rejection | `TestParseDotenvRejectsDuplicateKeys` | N/A | N/A | Duplicate rejection |
| Invalid line rejection | `TestParseDotenv*` tests | N/A | N/A | Invalid line check |

**Test Files**:
- `internal/env/env_test.go` - Core env tests
- `cmd/env_test.go` - Command-level tests

#### 3.2 `fabrik env ls`

**Acceptance Criteria**:
- [ ] `fabrik env ls --project myapp --env dev` lists keys in the secret

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| List keys | Covered in env internal tests | N/A | Manual secret list | List on prod |

**Test Files**:
- `internal/env/env_test.go`

#### 3.3 `fabrik env pull`

**Acceptance Criteria**:
- [ ] `fabrik env pull --project myapp --env dev .env.local` writes dotenv-compatible output
- [ ] Redacts output from terminal logs unless explicitly requested

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Pull to file | `TestRenderDotenvSorted` | N/A | Manual pull test | Pull on prod |
| Redaction | Covered in env internal tests | N/A | N/A | Redaction check |

**Test Files**:
- `internal/env/env_test.go`

#### 3.4 `fabrik env validate`

**Acceptance Criteria**:
- [ ] `fabrik env validate --project myapp --env dev` validates the secret

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Validate secret | Covered in env internal tests | N/A | Manual validate | Validate on prod |

**Test Files**:
- `internal/env/env_test.go`

#### 3.5 `fabrik env run`

**Acceptance Criteria**:
- [ ] `fabrik env run --project myapp --env dev -- npm test` runs local command with project env injected

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Env injection | N/A | N/A | Manual command test | Command exec on prod |

**Test Files**:
- Command-level testing (no unit tests for this yet)

#### 3.6 `fabrik env diff`

**Acceptance Criteria**:
- [ ] `fabrik env diff --project myapp --from dev --to staging` shows key-level differences

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Diff environments | Covered in env internal tests | N/A | Manual diff test | Diff on prod |

**Test Files**:
- `internal/env/env_test.go`

#### 3.7 `fabrik env promote`

**Acceptance Criteria**:
- [ ] `fabrik env promote --project myapp --from dev --to staging` copies values with explicit preview
- [ ] Requires explicit target selection
- [ ] Defaults to previewing diff first
- [ ] Protected production writes

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Promote with preview | Covered in env internal tests | N/A | Manual promote test | Promote on prod |
| Production protection | `TestParseDotenvRejectsReservedSmithersKey` (related) | N/A | N/A | Prod protection check |

**Test Files**:
- `internal/env/env_test.go`
- `cmd/env_test.go` (`TestEnvHelpMentionsPullAndPromote`)

---

### 4. Project Environment Injection

#### 4.1 Project Secret Mirroring

**Acceptance Criteria** (from 051-k3s-orchestrator.md):
- [ ] Secrets are mounted as files in `/etc/fabrik/env/` and injected as env vars
- [ ] `fabrik-credentials` and `fabrik-env-<project>-<env>` remain separate secret classes
- [ ] Project env overrides shared credentials for conflicting keys
- [ ] Precedence: platform metadata > project env > shared credentials

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Secret mounting | `TestExecuteRenderOnlyWithProjectEnvRendersSecretMountAndEnvFrom` | `TestExecuteLiveDispatchWithEnvFileAppliesEnvSecretsInSourceAndRunNamespaces` | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` (asserts mount path) | Mount inspection on prod |
| Secret separation | `TestExecuteRenderOnlyWithProjectEnvRendersSecretMountAndEnvFrom` | `TestExecuteLiveDispatchWithEnvFileAppliesEnvSecretsInSourceAndRunNamespaces` | `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` | Separation check |
| Precedence rules | N/A | `TestExecuteLiveDispatchWithEnvFileAppliesEnvSecretsInSourceAndRunNamespaces` | `TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters` | Precedence validation |
| Cross-namespace mirroring | `TestExecuteRenderOnlyWithProjectEnvRendersSecretMountAndEnvFrom` | `TestExecuteLiveDispatchWithEnvFileAppliesEnvSecretsInSourceAndRunNamespaces` | `TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters` | Mirroring on prod |

**Test Files**:
- `internal/run/dispatch_test.go` - Mount/render tests
- `internal/run/integration_k3d_test.go` - k3d validation (`TestK3dRunInjectsProjectEnvForCommandAndWorkflow`, `TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters`)

---

### 5. Workflow Dispatch Features

#### 5.1 Workflow Bundling

**Acceptance Criteria**:
- [ ] `--workflow-path` mounts workflow file into job
- [ ] Workflow bundled and mounted at dispatch time
- [ ] Rejects imports outside workflow directory

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Workflow bundling | `TestResolveWorkflowBundleStagesWorkflowUnderWorkflowsDir` | N/A | `TestK3dCronSchedulesCommandAndWorkflowJobs` | Workflow mount on prod |
| Import restrictions | `TestResolveWorkflowBundleRejectsImportsOutsideWorkflowDir` | N/A | N/A | Import validation |

**Test Files**:
- `internal/run/workflow_bundle_test.go`

#### 5.2 Fabrik Sync

**Acceptance Criteria**:
- [ ] `--fabrik-sync-file` injects explicit small non-VCS files
- [ ] Rejects `.git`, `.jj`, build artifacts
- [ ] Rejects symlinks, large files, parent traversal
- [ ] VCS metadata excluded from artifact sync

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Sync manifest parsing | `TestParseSyncManifest*` | N/A | `TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters` | Sync on prod |
| Forbidden path rejection | `TestParseSyncManifestRejectsForbiddenPath` | N/A | N/A | Forbidden check |
| Build artifact exclusion | `TestSyncWorkdirExcludesMatchDocumentedBuildArtifacts` | N/A | N/A | Exclusion check |
| Symlink rejection | `TestResolveSyncBundleRejectsSymlink` | N/A | N/A | Symlink check |
| Large file rejection | `TestResolveSyncBundleRejectsLargeFile` | N/A | N/A | Size limit check |
| Traversal rejection | `TestResolveSyncBundleRejectsParentTraversal` | N/A | N/A | Traversal check |

**Test Files**:
- `internal/run/fabrik_sync_test.go`

#### 5.3 Image Resolution

**Acceptance Criteria**:
- [ ] Immutable image references enforced
- [ ] Digest resolution for tagged images
- [ ] Registry authentication handling

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Image validation | `TestValidateOptionsRejectsMutableImage`, `TestValidateOptionsAcceptsDigest` | N/A | N/A | Image validation on prod |
| Digest resolution | `TestResolveRegistryDigestWithBearerChallenge` | N/A | `TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters` | Digest resolution on prod |
| Docker Hub parsing | `TestParseImageReferenceDockerHubLibraryImage` | N/A | N/A | Parsing on prod |

**Test Files**:
- `internal/run/image_test.go`

---

### 6. Command-Line Interface

#### 6.1 Root Command Structure

**Acceptance Criteria**:
- [ ] `fabrik` has `run`, `runs`, `env` subcommands
- [ ] Help text accurate and complete

**Verification Paths**:

| Criterion | Unit Tests | Integration | k3d Check | Prod-Parity |
|-----------|-----------|-------------|-----------|-------------|
| Subcommand presence | `TestRootCommandHasRun`, `TestRootCommandHasEnv` | N/A | N/A | Command structure on prod |
| Help accuracy | `TestRunHelpMentionsFilteredSyncAndFabrikSync`, `TestEnvHelpMentionsPullAndPromote` | N/A | N/A | Help text review |

**Test Files**:
- `cmd/root_test.go`
- `cmd/run_test.go`
- `cmd/env_test.go`

---

## Test Execution Matrix

### Fast Unit Tests (No Cluster Required)

```bash
cd src/fabrik-cli && go test ./... -count=1
```

**Coverage**:
- All validation logic
- All manifest rendering
- All option parsing
- All preflight checks
- All env parsing/validation
- All workflow bundling
- All sync bundle resolution
- All image reference parsing

### k3d Integration Tests (Cluster Required)

```bash
make verify-cli-k3d
# Or:
cd src/fabrik-cli && FABRIK_K3D_E2E=1 FABRIK_K3D_CLUSTER=dev-single go test ./internal/run -run 'TestK3d' -v
```

**Coverage**:
| Test | Features Verified |
|------|-------------------|
| `TestK3dRenderAndDryRun` | Render, dry-run, manifest validation |
| `TestK3dCronSchedulesCommandAndWorkflowJobs` | CronJob creation, schedule trigger, workflow mounting |
| `TestK3dRunInjectsProjectEnvForCommandAndWorkflow` | Project env injection, secret mounting |
| `TestK3dWorkflowDispatchWithEnvFileAndGitHubRepoAcrossNamedClusters` | Env file, repo clone, workflow execution, multi-cluster |
| `TestK3dResumePreservesPVCAndImageDigest` | Resume, PVC preservation, image immutability |
| `TestK3dCancelDeletesJobAndCascadesToPod` | Cancel, cascading deletion |

---

## Verification Checklist for New Features

When adding a new CLI feature, the following must be included in the PR:

- [ ] Unit tests for all validation and parsing logic
- [ ] Unit tests for error cases and edge cases
- [ ] Integration tests for cross-module interactions (if applicable)
- [ ] k3d test if the feature touches:
  - Kubernetes API
  - Job/CronJob lifecycle
  - Secret/ConfigMap operations
  - Pod execution
  - Resource cleanup
- [ ] Entry in this verification map document
- [ ] Updated acceptance criteria in the relevant spec

---

## Roadmap Items (Pre-verified)

The following planned features have pre-defined verification requirements:

| Feature | Unit Tests | k3d Check | Prod-Parity |
|---------|-----------|-----------|-------------|
| `fabrik cluster init` | Cluster config generation | Full cluster creation | Cloud provider validation |
| `fabrik cluster list` | Config parsing | N/A | Multi-context validation |
| `fabrik doctor` | Health check logic | k3d cluster health | Production cluster health |
| `fabrik schedule list` | CronJob listing | k3d schedule listing | Production schedules |
| `fabrik schedule delete` | CronJob deletion | k3d schedule deletion | Production deletion |
| `fabrik runs cleanup` | Job/PVC selection | k3d cleanup execution | Production cleanup |
| Alerting integration | Alert rule validation | N/A | AlertManager integration |

---

## Glossary

- **Unit Test**: Fast, deterministic test with no external dependencies
- **Integration Test**: Test that validates cross-module behavior, may use mocks
- **k3d Check**: Test against real k3d cluster (k3s-in-Docker)
- **Production-Parity Check**: Validation against real cloud cluster (EKS/GKE)
- **Acceptance Criterion**: Specific requirement from the spec
- **Verification Path**: Named test or check that validates a criterion
