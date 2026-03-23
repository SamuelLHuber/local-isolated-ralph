import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { CodexAgent } from "smithers-orchestrator";
import {
  classifyFailure,
  getCredentialMountPath,
  type FailureKind,
} from "./credential-pool";
import {
  recordCodexAuthExhausted,
  recordCodexAuthFailure,
  recordCodexAuthPoolSnapshot,
  recordCodexAuthRotation,
  type CodexAuthBlockedDetails,
} from "./codex-auth-telemetry";

export type { CodexAuthBlockedDetails } from "./codex-auth-telemetry";

const DEFAULT_CODEX_DIR = resolve(process.env.HOME ?? "", ".codex");

// Resolution order:
// 1. CODEX_AUTH_SOURCE_DIR — test/dev override
// 2. FABRIK_SHARED_CREDENTIALS_DIR — production (set by fabrik-cli dispatch)
// 3. credential mount path — fallback if directory exists
// 4. ~/.codex — local dev default
function getCodexAuthSourceDir(): string {
  const sourceDir =
    process.env.CODEX_AUTH_SOURCE_DIR ??
    process.env.FABRIK_SHARED_CREDENTIALS_DIR ??
    (existsSync(getCredentialMountPath()) ? getCredentialMountPath() : DEFAULT_CODEX_DIR);
  return resolve(sourceDir);
}

export function getCodexAuthHome(): string {
  return resolve(process.env.CODEX_AUTH_HOME ?? resolve(tmpdir(), "codex-auth-pool"));
}


const getNotifyWebhookUrl = () => process.env.CODEX_AUTH_NOTIFY_WEBHOOK_URL?.trim() ?? "";
const getNotifyCluster = () => process.env.KUBERNETES_NAMESPACE?.trim() ?? "";
const getNotifyRunID = () => process.env.SMITHERS_RUN_ID?.trim() ?? "";

type AuthEntry = {
  path: string;
  authName: string;
  contents: string;
};

const listAuthFiles = (): string[] => {
  const sourceDir = getCodexAuthSourceDir();
  if (!existsSync(sourceDir)) return [];
  return readdirSync(sourceDir)
    .filter((name) => name.endsWith(".auth.json") || name === "auth.json")
    .map((name) => resolve(sourceDir, name))
    .sort();
};

const ensureDir = (dir: string) => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

export class CodexAuthBlockedError extends Error {
  readonly code = "CODEX_AUTH_BLOCKED" as const;
  readonly reason = "auth_pool_exhausted" as const;
  readonly details: CodexAuthBlockedDetails;
  readonly runId?: string;
  readonly namespace?: string;

  constructor(args: {
    message?: string;
    details: CodexAuthBlockedDetails;
    runId?: string;
    namespace?: string;
    cause?: unknown;
  }) {
    super(args.message ?? "Codex auth pool exhausted", { cause: args.cause });
    this.name = "CodexAuthBlockedError";
    this.details = args.details;
    this.runId = args.runId;
    this.namespace = args.namespace;
  }
}

const telemetryContext = () => ({
  runId: getNotifyRunID() || undefined,
  namespace: getNotifyCluster() || undefined,
});

const writeBlockerArtifact = (details: CodexAuthBlockedDetails) => {
  const smithersHome = resolve(process.env.SMITHERS_HOME ?? ".");
  const blockerPath = resolve(smithersHome, ".smithers", "blockers", "codex-auth.json");
  mkdirSync(resolve(blockerPath, ".."), { recursive: true });
  writeFileSync(
    blockerPath,
    JSON.stringify(
      {
        kind: "auth_pool_exhausted",
        resumable: true,
        runId: getNotifyRunID() || undefined,
        namespace: getNotifyCluster() || undefined,
        details,
      },
      null,
      2,
    ),
    "utf8",
  );
};

export const withCodexAuthPoolEnv = (env: Record<string, string>) => ({
  ...env,
  CODEX_HOME: getCodexAuthHome(),
});

export type AuthFailureKind = FailureKind;

export type AuthFailureEvent = {
  authPath: string;
  authName: string;
  reason: string;
  kind: AuthFailureKind;
  message: string;
  clusterNamespace?: string;
  runId?: string;
};

export type RotatingCodexAgentOptions = {
  onAuthFailure?: (event: AuthFailureEvent) => void | Promise<void>;
};

const notifyAuthFailure = async (
  event: AuthFailureEvent,
  onAuthFailure?: RotatingCodexAgentOptions["onAuthFailure"],
) => {
  if (onAuthFailure) {
    await onAuthFailure(event);
  }
  const webhookUrl = getNotifyWebhookUrl();
  if (!webhookUrl) return;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      console.error(
        `[fabrik-runtime] codex auth notification failed: webhook status ${response.status}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fabrik-runtime] codex auth notification failed: ${message}`);
  }
};

export const createCodexAgentWithPool = (
  opts: ConstructorParameters<typeof CodexAgent>[0],
  rotationOpts: RotatingCodexAgentOptions = {},
) =>
  new RotatingCodexAgent(
    new CodexAgent({
      ...opts,
      env: withCodexAuthPoolEnv(opts.env ?? {}),
    }),
    rotationOpts,
  );

export class RotatingCodexAgent {
  private readonly inner: CodexAgent;
  private readonly onAuthFailure?: RotatingCodexAgentOptions["onAuthFailure"];
  private authPool: AuthEntry[] = [];
  private authIndex = 0;
  private activeAuth: AuthEntry | null = null;
  private readonly authFailures = new Map<string, FailureKind>();

  constructor(inner: CodexAgent, opts: RotatingCodexAgentOptions = {}) {
    this.inner = inner;
    this.onAuthFailure = opts.onAuthFailure;
  }

  get id() {
    return this.inner.id;
  }

  get tools() {
    return this.inner.tools;
  }

  private failureKey(entry: AuthEntry): string {
    return `${entry.path}:${entry.contents.length}:${Bun.hash(entry.contents)}`;
  }

  private scanAuthPool(): AuthEntry[] {
    return listAuthFiles().map((path) => ({
      path,
      authName: basename(path),
      contents: readFileSync(path, "utf8"),
    }));
  }

  private refreshAuthPool(): void {
    this.authPool = this.scanAuthPool();
    if (!this.activeAuth) return;
    const nextActive = this.authPool.find((entry) => entry.path === this.activeAuth?.path) ?? null;
    this.activeAuth = nextActive;
  }

  private getBlockedDetails(): CodexAuthBlockedDetails {
    this.refreshAuthPool();
    const failedAuths = this.authPool
      .filter((entry) => this.authFailures.has(this.failureKey(entry)))
      .map((entry) => ({
        authName: entry.authName,
        kind: this.authFailures.get(this.failureKey(entry))!,
      }));
    return {
      total: this.authPool.length,
      failed: failedAuths.length,
      remaining: Math.max(this.authPool.length - failedAuths.length, 0),
      activeAuthName: this.activeAuth?.authName ?? null,
      failedAuths,
    };
  }

  private logAuthSummary(): void {
    const details = this.getBlockedDetails();
    recordCodexAuthPoolSnapshot(details, telemetryContext());
    const failed = details.failedAuths.map(({ authName, kind }) => `${authName}:${kind}`);
    const active = details.activeAuthName ?? "none";
    console.error(
      `[fabrik-runtime] codex auth pool summary: total=${details.total} failed=${details.failed} remaining=${details.remaining} active=${active}`,
    );
    if (failed.length > 0) {
      console.error(`[fabrik-runtime] failed auths: ${failed.join(", ")}`);
    }
  }

  /** Write the active auth file to the codex auth home dir without emitting telemetry or logs. */
  private syncActiveAuthFile(entry: AuthEntry): void {
    const home = getCodexAuthHome();
    ensureDir(home);
    writeFileSync(resolve(home, "auth.json"), entry.contents, "utf8");
  }

  /** Activate a credential: write file, update state, emit telemetry + log. */
  private setActiveAuth(entry: AuthEntry, reason: string): void {
    this.syncActiveAuthFile(entry);
    const previousAuth = this.activeAuth?.authName;
    const previous = previousAuth ? ` from ${previousAuth}` : "";
    this.activeAuth = entry;
    recordCodexAuthRotation(
      {
        fromAuthName: previousAuth,
        toAuthName: entry.authName,
        reason,
      },
      this.getBlockedDetails(),
      telemetryContext(),
    );
    console.error(
      `[fabrik-runtime] codex auth rotation${previous} -> ${entry.authName} (${reason})`,
    );
  }

  private ensureActiveAuth(): void {
    const home = getCodexAuthHome();
    ensureDir(home);
    this.refreshAuthPool();
    if (this.authPool.length === 0) return;
    const currentFailed =
      this.activeAuth && this.authFailures.has(this.failureKey(this.activeAuth));
    if (this.activeAuth && !currentFailed) {
      // Re-sync file if contents changed on disk (operator rotated credentials),
      // or if the file doesn't exist yet. No telemetry — this is not a rotation.
      const authFile = resolve(home, "auth.json");
      const onDisk = existsSync(authFile) ? readFileSync(authFile, "utf8") : null;
      if (onDisk !== this.activeAuth.contents) {
        this.syncActiveAuthFile(this.activeAuth);
      }
      return;
    }
    const defaultAuth = resolve(getCodexAuthSourceDir(), "auth.json");
    const initial =
      this.authPool.find((entry) => entry.path === defaultAuth && !this.authFailures.has(this.failureKey(entry))) ??
      this.authPool.find((entry) => !this.authFailures.has(this.failureKey(entry)));
    if (!initial) {
      this.activeAuth = this.authPool.find((entry) => entry.path === this.activeAuth?.path) ?? null;
      return;
    }
    const reason = this.activeAuth ? "refresh" : "initial";
    this.setActiveAuth(initial, reason);
    this.authIndex = this.authPool.findIndex((entry) => entry.path === initial.path) + 1;
  }

  private rotateAuth(reason: string): boolean {
    this.refreshAuthPool();
    if (this.authPool.length === 0) return false;
    for (let i = 0; i < this.authPool.length; i += 1) {
      const next = this.authPool[this.authIndex % this.authPool.length];
      this.authIndex += 1;
      if (
        next &&
        next.path !== this.activeAuth?.path &&
        !this.authFailures.has(this.failureKey(next))
      ) {
        this.setActiveAuth(next, reason);
        this.logAuthSummary();
        return true;
      }
    }
    console.error("[fabrik-runtime] no codex auth left to rotate to");
    this.logAuthSummary();
    return false;
  }

  async generate(args: Parameters<CodexAgent["generate"]>[0]) {
    this.ensureActiveAuth();
    const attempts = Math.max(this.authPool.length, 1);
    let lastError: unknown = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await this.inner.generate(args);
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        const kind = classifyFailure(message);
        if (kind === "unknown") {
          throw err;
        }
        if (this.activeAuth) {
          this.authFailures.set(this.failureKey(this.activeAuth), kind);
          recordCodexAuthFailure(
            { authName: this.activeAuth.authName, kind },
            this.getBlockedDetails(),
            telemetryContext(),
          );
          if (kind === "refresh_token_reused") {
            console.error("[fabrik-runtime] codex refresh token reused; re-auth required");
          }
          await notifyAuthFailure(
            {
              authPath: this.activeAuth.path,
              authName: this.activeAuth.authName,
              reason: "codex generate failed and rotation was requested",
              kind,
              message,
              clusterNamespace: getNotifyCluster() || undefined,
              runId: getNotifyRunID() || undefined,
            },
            this.onAuthFailure,
          );
        }
        if (!this.rotateAuth("codex auth / usage failure")) {
          const details = this.getBlockedDetails();
          recordCodexAuthExhausted(details, telemetryContext());
          writeBlockerArtifact(details);
          throw new CodexAuthBlockedError({
            message: "Codex auth pool exhausted",
            details,
            runId: getNotifyRunID() || undefined,
            namespace: getNotifyCluster() || undefined,
            cause: err,
          });
        }
      }
    }
    const details = this.getBlockedDetails();
    recordCodexAuthExhausted(details, telemetryContext());
    writeBlockerArtifact(details);
    throw new CodexAuthBlockedError({
      message: "Codex auth pool exhausted",
      details,
      runId: getNotifyRunID() || undefined,
      namespace: getNotifyCluster() || undefined,
      cause: lastError,
    });
  }
}
