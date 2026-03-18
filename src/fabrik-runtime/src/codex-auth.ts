import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { CodexAgent } from "smithers-orchestrator";
import {
  classifyFailure,
  getCredentialMountPath,
  type FailureKind,
} from "./credential-pool";

const DEFAULT_CODEX_DIR = resolve(process.env.HOME ?? "", ".codex");

function getCodexAuthSourceDir(): string {
  const sourceDir =
    process.env.CODEX_AUTH_SOURCE_DIR ??
    process.env.FABRIK_SHARED_CREDENTIALS_DIR ??
    (existsSync(getCredentialMountPath()) ? getCredentialMountPath() : DEFAULT_CODEX_DIR);
  return resolve(sourceDir);
}

export const CODEX_AUTH_HOME = resolve(
  process.env.CODEX_AUTH_HOME ?? resolve(tmpdir(), "codex-auth-pool"),
);

const NOTIFY_WEBHOOK_URL = process.env.CODEX_AUTH_NOTIFY_WEBHOOK_URL?.trim() ?? "";
const NOTIFY_CLUSTER = process.env.KUBERNETES_NAMESPACE?.trim() ?? "";
const NOTIFY_RUN_ID = process.env.SMITHERS_RUN_ID?.trim() ?? "";

const AUTH_ROTATE_PATTERN =
  /no last agent message|usage limit|quota|rate limit|insufficient (?:credits|balance|quota)|payment required|billing|exceeded.*(quota|limit)|not signed in|please run 'codex login'|unauthorized|authentication required|authentication failed|forbidden|invalid (?:api key|token|credentials)|expired (?:token|credentials)/i;
const AUTH_REFRESH_REUSED_PATTERN =
  /refresh_token_reused|refresh token has already been used|could not be refreshed because your refresh token was already used/i;

const listAuthFiles = (): string[] => {
  const sourceDir = getCodexAuthSourceDir();
  if (!existsSync(sourceDir)) return [];
  return readdirSync(sourceDir)
    .filter((name) => name.endsWith(".auth.json") || name === "auth.json")
    .map((name) => resolve(sourceDir, name))
    .sort();
};

const ensureCodexHome = () => {
  if (!existsSync(CODEX_AUTH_HOME)) {
    mkdirSync(CODEX_AUTH_HOME, { recursive: true });
  }
};

let authPool = listAuthFiles();
let authIndex = 0;
let activeAuth = "";
const authFailures = new Map<string, FailureKind>();

export function resetCodexAuthStateForTests(): void {
  authPool = [];
  authIndex = 0;
  activeAuth = "";
  authFailures.clear();
}

const setActiveAuth = (authPath: string, reason: string) => {
  ensureCodexHome();
  const authContents = readFileSync(authPath, "utf8");
  writeFileSync(resolve(CODEX_AUTH_HOME, "auth.json"), authContents, "utf8");
  const previous = activeAuth ? ` from ${basename(activeAuth)}` : "";
  activeAuth = authPath;
  console.error(
    `[fabrik-runtime] codex auth rotation${previous} -> ${basename(authPath)} (${reason})`,
  );
};

const initAuthPool = () => {
  ensureCodexHome();
  authPool = listAuthFiles();
  if (authPool.length === 0 || activeAuth) return;
  const defaultAuth = resolve(getCodexAuthSourceDir(), "auth.json");
  if (existsSync(defaultAuth)) {
    setActiveAuth(defaultAuth, "initial");
    return;
  }
  setActiveAuth(authPool[0]!, "initial");
};

const logAuthSummary = () => {
  const total = authPool.length;
  const failed = [...authFailures.entries()].map(
    ([path, status]) => `${basename(path)}:${status}`,
  );
  const failedCount = authFailures.size;
  const remaining = Math.max(total - failedCount, 0);
  const active = activeAuth ? basename(activeAuth) : "none";
  console.error(
    `[fabrik-runtime] codex auth pool summary: total=${total} failed=${failedCount} remaining=${remaining} active=${active}`,
  );
  if (failed.length > 0) {
    console.error(`[fabrik-runtime] failed auths: ${failed.join(", ")}`);
  }
};

const rotateAuth = (reason: string): boolean => {
  authPool = listAuthFiles();
  if (authPool.length === 0) return false;
  for (let i = 0; i < authPool.length; i += 1) {
    const next = authPool[authIndex % authPool.length];
    authIndex += 1;
    if (next && next !== activeAuth && !authFailures.has(next)) {
      setActiveAuth(next, reason);
      logAuthSummary();
      return true;
    }
  }
  console.error("[fabrik-runtime] no codex auth left to rotate to");
  logAuthSummary();
  return false;
};

export const withCodexAuthPoolEnv = (env: Record<string, string>) => ({
  ...env,
  CODEX_HOME: CODEX_AUTH_HOME,
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
  if (!NOTIFY_WEBHOOK_URL) return;
  try {
    const response = await fetch(NOTIFY_WEBHOOK_URL, {
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

  async generate(args: Parameters<CodexAgent["generate"]>[0]) {
    initAuthPool();
    const attempts = Math.max(authPool.length, 1);
    let lastError: unknown = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await this.inner.generate(args);
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!AUTH_ROTATE_PATTERN.test(message)) {
          throw err;
        }
        if (activeAuth) {
          const kind = classifyFailure(message);
          authFailures.set(activeAuth, kind);
          if (AUTH_REFRESH_REUSED_PATTERN.test(message)) {
            console.error("[fabrik-runtime] codex refresh token reused; re-auth required");
          }
          await notifyAuthFailure(
            {
              authPath: activeAuth,
              authName: basename(activeAuth),
              reason: "codex generate failed and rotation was requested",
              kind,
              message,
              clusterNamespace: NOTIFY_CLUSTER || undefined,
              runId: NOTIFY_RUN_ID || undefined,
            },
            this.onAuthFailure,
          );
        }
        if (!rotateAuth("codex auth / usage failure")) {
          break;
        }
      }
    }
    throw lastError ?? new Error("Codex auth pool exhausted");
  }
}
