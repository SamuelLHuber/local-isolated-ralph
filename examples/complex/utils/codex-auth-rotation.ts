import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { CodexAgent } from "smithers-orchestrator";

const DEFAULT_CODEX_DIR = resolve(process.env.HOME ?? "", ".codex");
const CODEX_AUTH_SOURCE_DIR = resolve(
  process.env.CODEX_AUTH_SOURCE_DIR ?? DEFAULT_CODEX_DIR,
);
export const CODEX_AUTH_HOME = resolve(
  process.env.CODEX_AUTH_HOME ?? resolve(tmpdir(), "codex-auth-pool"),
);
const NOTIFY_WEBHOOK_URL = process.env.CODEX_AUTH_NOTIFY_WEBHOOK_URL?.trim() ?? "";
const NOTIFY_CLUSTER = process.env.KUBERNETES_NAMESPACE?.trim() ?? "";
const NOTIFY_RUN_ID = process.env.SMITHERS_RUN_ID?.trim() ?? "";

const AUTH_ROTATE_PATTERN =
  /no last agent message|usage limit|quota|rate limit|insufficient (?:credits|balance|quota)|payment required|billing|exceeded.*(quota|limit)|not signed in|please run 'codex login'|unauthorized|authentication required|authentication failed|forbidden|invalid (?:api key|token|credentials)|expired (?:token|credentials)/i;
const AUTH_INVALID_PATTERN =
  /not signed in|please run 'codex login'|unauthorized|authentication required|authentication failed|forbidden|invalid (?:api key|token|credentials)|expired (?:token|credentials)/i;
const AUTH_USAGE_PATTERN =
  /no last agent message|usage limit|quota|rate limit|insufficient (?:credits|balance|quota)|payment required|billing|exceeded.*(quota|limit)/i;
const AUTH_REFRESH_REUSED_PATTERN =
  /refresh_token_reused|refresh token has already been used|could not be refreshed because your refresh token was already used/i;

const listAuthFiles = (): string[] => {
  if (!existsSync(CODEX_AUTH_SOURCE_DIR)) return [];
  const entries = readdirSync(CODEX_AUTH_SOURCE_DIR);
  return entries
    .filter((name) => name.endsWith(".auth.json") || name === "auth.json")
    .map((name) => resolve(CODEX_AUTH_SOURCE_DIR, name))
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
const authFailures = new Map<string, string>();

const setActiveAuth = (authPath: string, reason: string) => {
  ensureCodexHome();
  const authContents = readFileSync(authPath, "utf8");
  writeFileSync(resolve(CODEX_AUTH_HOME, "auth.json"), authContents, "utf8");
  const previous = activeAuth ? ` from ${basename(activeAuth)}` : "";
  activeAuth = authPath;
  console.error(
    `[smithers] Codex auth rotation${previous} -> ${basename(authPath)} (${reason})`,
  );
};

const initAuthPool = () => {
  ensureCodexHome();
  authPool = listAuthFiles();
  if (authPool.length === 0) return;
  if (activeAuth) return;
  const defaultAuth = resolve(CODEX_AUTH_SOURCE_DIR, "auth.json");
  if (existsSync(defaultAuth)) {
    setActiveAuth(defaultAuth, "initial");
  } else {
    setActiveAuth(authPool[0], "initial");
  }
};

const classifyAuthFailure = (message: string): string => {
  if (AUTH_REFRESH_REUSED_PATTERN.test(message)) return "refresh_token_reused";
  if (AUTH_USAGE_PATTERN.test(message)) return "usage_limit";
  if (AUTH_INVALID_PATTERN.test(message)) return "auth_invalid";
  return "unknown";
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
    `[smithers] Codex auth pool summary: total=${total} failed=${failedCount} remaining=${remaining} active=${active}`,
  );
  if (failed.length > 0) {
    console.error(`[smithers] Failed auths: ${failed.join(", ")}`);
  }
};

const rotateAuth = (reason: string): boolean => {
  authPool = listAuthFiles();
  if (authPool.length === 0) return false;
  for (let i = 0; i < authPool.length; i += 1) {
    const next = authPool[authIndex % authPool.length];
    authIndex += 1;
    if (next && next !== activeAuth) {
      setActiveAuth(next, reason);
      logAuthSummary();
      return true;
    }
  }
  console.error("[smithers] No auth.json left to rotate to.");
  logAuthSummary();
  return false;
};

export const withCodexAuthPoolEnv = (env: Record<string, string>) => ({
  ...env,
  CODEX_HOME: CODEX_AUTH_HOME,
});

export type AuthFailureKind =
  | "refresh_token_reused"
  | "usage_limit"
  | "auth_invalid"
  | "unknown";

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
  if (!NOTIFY_WEBHOOK_URL) {
    return;
  }
  try {
    const response = await fetch(NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      console.error(
        `[smithers] Codex auth notification failed: webhook status ${response.status}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[smithers] Codex auth notification failed: ${message}`);
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
        if (AUTH_REFRESH_REUSED_PATTERN.test(message)) {
          console.error("[smithers] Codex auth refresh token reused; re-auth required");
        }
        if (activeAuth) {
          const kind = classifyAuthFailure(message) as AuthFailureKind;
          authFailures.set(activeAuth, kind);
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
        if (!rotateAuth("no last agent message / auth / usage")) {
          break;
        }
      }
    }
    throw lastError ?? new Error("Codex auth pool exhausted");
  }
}
