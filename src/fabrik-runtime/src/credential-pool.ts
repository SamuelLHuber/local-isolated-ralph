/**
 * Generic credential pool for Fabrik workflow pods.
 *
 * Credentials are managed by operators via kubectl and mounted into pods
 * at /etc/fabrik/credentials as a Kubernetes Secret directory mount.
 * This module reads from that mount, provides pool rotation for agents
 * that support multiple credential files, and emits structured failure
 * notifications without exposing secret contents.
 *
 * Architecture:
 * - Operators create/update `fabrik-credentials` secret in `fabrik-system`
 *   via kubectl (e.g. `kubectl create secret generic fabrik-credentials
 *   --from-file=ANTHROPIC_API_KEY=./key.txt --from-literal=OPENAI_API_KEY=sk-...`)
 * - Fabrik CLI mirrors the secret into the run namespace at dispatch time
 * - The secret is directory-mounted (no subPath) at CREDENTIAL_MOUNT_PATH
 *   so running pods observe file replacements for rotation
 * - This module reads credential files from that mount directory
 *
 * Supported credential layouts:
 * - Flat env-var keys: /etc/fabrik/credentials/ANTHROPIC_API_KEY (file contains the value)
 * - Codex auth pool: /etc/fabrik/credentials/codex-auth.json,
 *   /etc/fabrik/credentials/codex-auth-2.json, etc.
 * - Claude Code: /etc/fabrik/credentials/ANTHROPIC_API_KEY
 * - Pi: /etc/fabrik/credentials/FIREWORKS_API_KEY or provider config files
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Default mount path for the fabrik-credentials directory. */
export function getCredentialMountPath(): string {
  return process.env.FABRIK_CREDENTIAL_PATH ?? "/etc/fabrik/credentials";
}

/** @deprecated Use getCredentialMountPath() for dynamic resolution. */
export const CREDENTIAL_MOUNT_PATH = "/etc/fabrik/credentials";

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type FailureKind =
  | "refresh_token_reused"
  | "usage_limit"
  | "auth_invalid"
  | "unknown";

export type FailureEvent = {
  credentialName: string;
  kind: FailureKind;
  message: string;
  agent: string;
  namespace?: string;
  runId?: string;
};

const REFRESH_REUSED =
  /refresh_token_reused|refresh token has already been used|could not be refreshed because your refresh token was already used/i;
const USAGE_LIMIT =
  /no last agent message|usage limit|quota|rate limit|insufficient (?:credits|balance|quota)|payment required|billing|exceeded.*(quota|limit)/i;
const AUTH_INVALID =
  /not signed in|please run.*login|unauthorized|authentication required|authentication failed|forbidden|invalid (?:api key|token|credentials)|expired (?:token|credentials)|Not logged in/i;

export function classifyFailure(message: string): FailureKind {
  if (REFRESH_REUSED.test(message)) return "refresh_token_reused";
  if (AUTH_INVALID.test(message)) return "auth_invalid";
  if (USAGE_LIMIT.test(message)) return "usage_limit";
  return "unknown";
}

/** Returns true if the error message indicates an auth/credential problem
 * that credential rotation might fix. */
export function isRotatableFailure(message: string): boolean {
  return classifyFailure(message) !== "unknown";
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

const NOTIFY_WEBHOOK = process.env.FABRIK_CREDENTIAL_NOTIFY_WEBHOOK?.trim() ?? "";

export async function notifyFailure(event: FailureEvent): Promise<void> {
  console.error(
    `[fabrik-runtime] credential failure: ${event.credentialName} kind=${event.kind} agent=${event.agent}`,
  );
  if (!NOTIFY_WEBHOOK) return;
  try {
    const resp = await fetch(NOTIFY_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!resp.ok) {
      console.error(`[fabrik-runtime] notification webhook returned ${resp.status}`);
    }
  } catch (err) {
    console.error(`[fabrik-runtime] notification failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Credential reading from mounted directory
// ---------------------------------------------------------------------------

/** Read a single credential value from the mounted directory. */
export function readCredential(name: string): string | null {
  const mountPath = getCredentialMountPath();
  const path = resolve(mountPath, name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim();
}

/** List all credential file names in the mounted directory. */
export function listCredentials(): string[] {
  const mountPath = getCredentialMountPath();
  if (!existsSync(mountPath)) return [];
  return readdirSync(mountPath)
    .filter((name) => !name.startsWith(".") && name !== "..timestamp_of_last_update")
    .sort();
}

/** Read all credentials as a key→value map. */
export function readAllCredentials(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of listCredentials()) {
    const value = readCredential(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// File pool rotation (for agents that use auth files like Codex)
// ---------------------------------------------------------------------------

export type PoolOptions = {
  /** Glob pattern to match pool files, e.g. "codex-auth" matches codex-auth*.json */
  prefix: string;
  /** Extension to match, e.g. ".json" */
  extension?: string;
  /** Directory to write the active credential file to */
  activeDir: string;
  /** Filename for the active credential, e.g. "auth.json" */
  activeFilename: string;
  /** Agent name for failure events */
  agent: string;
};

export class CredentialFilePool {
  private pool: string[] = [];
  private index = 0;
  private active = "";
  private failures = new Map<string, FailureKind>();
  private readonly opts: PoolOptions;

  constructor(opts: PoolOptions) {
    this.opts = opts;
  }

  /** Scan the credential mount for pool files and activate the first one. */
  init(): void {
    this.pool = this.scanPool();
    if (this.pool.length === 0) return;
    if (this.active && this.pool.includes(this.active)) return;
    this.activate(this.pool[0]!, "initial");
  }

  /** Number of available (non-failed) credentials. */
  get available(): number {
    return this.pool.filter((p) => !this.failures.has(p)).length;
  }

  get activeName(): string {
    return this.active ? basename(this.active) : "";
  }

  /** Try to rotate to the next unfailed credential. Returns false if exhausted. */
  rotate(reason: string): boolean {
    this.pool = this.scanPool();
    if (this.pool.length === 0) return false;
    for (let i = 0; i < this.pool.length; i++) {
      const next = this.pool[this.index % this.pool.length]!;
      this.index++;
      if (next !== this.active && !this.failures.has(next)) {
        this.activate(next, reason);
        return true;
      }
    }
    console.error(`[fabrik-runtime] ${this.opts.agent} credential pool exhausted`);
    return false;
  }

  /** Mark the current credential as failed and optionally notify. */
  async markFailed(message: string): Promise<void> {
    if (!this.active) return;
    const kind = classifyFailure(message);
    this.failures.set(this.active, kind);
    await notifyFailure({
      credentialName: basename(this.active),
      kind,
      message,
      agent: this.opts.agent,
      namespace: process.env.KUBERNETES_NAMESPACE?.trim(),
      runId: process.env.SMITHERS_RUN_ID?.trim(),
    });
  }

  /** Handle an agent error: mark failed, try rotate, throw if exhausted. */
  async handleError(err: unknown): Promise<boolean> {
    const message = err instanceof Error ? err.message : String(err);
    if (!isRotatableFailure(message)) return false;
    await this.markFailed(message);
    return this.rotate("credential failure");
  }

  private scanPool(): string[] {
    const mountPath = getCredentialMountPath();
    if (!existsSync(mountPath)) return [];
    const ext = this.opts.extension ?? ".json";
    return readdirSync(mountPath)
      .filter((name) => name.startsWith(this.opts.prefix) && name.endsWith(ext))
      .map((name) => resolve(mountPath, name))
      .sort();
  }

  private activate(path: string, reason: string): void {
    mkdirSync(this.opts.activeDir, { recursive: true });
    const contents = readFileSync(path, "utf8");
    writeFileSync(resolve(this.opts.activeDir, this.opts.activeFilename), contents, "utf8");
    const prev = this.active ? ` from ${basename(this.active)}` : "";
    this.active = path;
    console.error(
      `[fabrik-runtime] ${this.opts.agent} credential${prev} -> ${basename(path)} (${reason})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Env-var credential helpers for agents that use env vars
// ---------------------------------------------------------------------------

/**
 * Read a credential from the mounted directory and set it as an env var.
 * This is the standard pattern for agents that use env vars for auth
 * (Claude Code ANTHROPIC_API_KEY, Pi FIREWORKS_API_KEY, etc.)
 */
export function injectCredentialEnv(credentialName: string, envVar?: string): boolean {
  const value = readCredential(credentialName);
  if (value === null) return false;
  process.env[envVar ?? credentialName] = value;
  return true;
}

/**
 * Inject all credentials from the mounted directory as env vars.
 * File names become env var names, file contents become values.
 */
export function injectAllCredentialEnvs(): string[] {
  const injected: string[] = [];
  for (const name of listCredentials()) {
    if (injectCredentialEnv(name)) {
      injected.push(name);
    }
  }
  return injected;
}
