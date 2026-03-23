/**
 * fabrik-runtime — shared TypeScript utilities for Fabrik workflow pods.
 *
 * This package provides:
 * - Credential pool management (read from mounted K8s secrets, rotate, notify)
 * - K8s job helpers (dispatch child verification jobs)
 * - Deterministic JJ/Git shell operations
 */

export {
  CREDENTIAL_MOUNT_PATH,
  getCredentialMountPath,
  classifyFailure,
  isRotatableFailure,
  notifyFailure,
  readCredential,
  listCredentials,
  readAllCredentials,
  injectCredentialEnv,
  injectAllCredentialEnvs,
  CredentialFilePool,
  type FailureKind,
  type FailureEvent,
  type PoolOptions,
} from "./credential-pool";

export {
  getCodexAuthHome,
  withCodexAuthPoolEnv,
  createCodexAgentWithPool,
  RotatingCodexAgent,
  CodexAuthBlockedError,
  type AuthFailureKind,
  type AuthFailureEvent,
  type RotatingCodexAgentOptions,
  type CodexAuthBlockedDetails,
} from "./codex-auth";

export {
  runVerificationJob,
  buildVerificationJobManifest,
  type VerificationResult,
} from "./k8s-jobs";

export {
  prepareWorkspaces,
  snapshotChange,
  pushBookmark,
  type ReportOutput,
} from "./jj-shell";
