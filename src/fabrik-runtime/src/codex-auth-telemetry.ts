import * as otel from "@opentelemetry/api";
import type { FailureKind } from "./credential-pool";

export type CodexAuthBlockedDetails = {
  total: number;
  failed: number;
  remaining: number;
  activeAuthName: string | null;
  failedAuths: Array<{ authName: string; kind: FailureKind }>;
};

export type CodexAuthTelemetryContext = {
  runId?: string;
  namespace?: string;
};

type CodexAuthTelemetrySink = {
  counter(name: string, value: number, attrs?: Record<string, unknown>): void;
  gauge(name: string, value: number, attrs?: Record<string, unknown>): void;
  event(name: string, attrs?: Record<string, unknown>): void;
};

const createOtelSink = (): CodexAuthTelemetrySink => {
  const meter = otel.metrics.getMeter("@dtechvision/fabrik-runtime/codex-auth");

  const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
  const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();

  const getCounter = (name: string) => {
    let counter = counters.get(name);
    if (!counter) {
      counter = meter.createCounter(name);
      counters.set(name, counter);
    }
    return counter;
  };

  const getGauge = (name: string) => {
    let gauge = gauges.get(name);
    if (!gauge) {
      gauge = meter.createGauge(name);
      gauges.set(name, gauge);
    }
    return gauge;
  };

  return {
    counter(name, value, attrs) {
      getCounter(name).add(value, attrs);
    },
    gauge(name, value, attrs) {
      getGauge(name).record(value, attrs);
    },
    event(name, attrs) {
      const span = otel.trace.getActiveSpan();
      if (span) {
        span.addEvent(name, attrs);
      }
    },
  };
};

let sink: CodexAuthTelemetrySink = createOtelSink();

export function __setCodexAuthTelemetrySinkForTests(next: CodexAuthTelemetrySink): void {
  sink = next;
}

export function __resetCodexAuthTelemetrySinkForTests(): void {
  sink = createOtelSink();
}

const baseAttrs = (ctx: CodexAuthTelemetryContext) => ({
  ...(ctx.runId ? { run_id: ctx.runId } : {}),
  ...(ctx.namespace ? { kubernetes_namespace: ctx.namespace } : {}),
});

const failureKindCounts = (details: CodexAuthBlockedDetails) => ({
  usage_limit: details.failedAuths.filter((entry) => entry.kind === "usage_limit").length,
  refresh_token_reused: details.failedAuths.filter((entry) => entry.kind === "refresh_token_reused").length,
  auth_invalid: details.failedAuths.filter((entry) => entry.kind === "auth_invalid").length,
});

export function recordCodexAuthPoolSnapshot(
  details: CodexAuthBlockedDetails,
  ctx: CodexAuthTelemetryContext,
): void {
  const attrs = baseAttrs(ctx);
  const counts = failureKindCounts(details);
  sink.gauge("fabrik.codex_auth.pool.total", details.total, attrs);
  sink.gauge("fabrik.codex_auth.pool.failed", details.failed, attrs);
  sink.gauge("fabrik.codex_auth.pool.remaining", details.remaining, attrs);
  sink.gauge("fabrik.codex_auth.pool.failed_usage_limit", counts.usage_limit, attrs);
  sink.gauge(
    "fabrik.codex_auth.pool.failed_refresh_token_reused",
    counts.refresh_token_reused,
    attrs,
  );
  sink.gauge("fabrik.codex_auth.pool.failed_auth_invalid", counts.auth_invalid, attrs);
}

export function recordCodexAuthFailure(
  failure: { authName: string; kind: FailureKind },
  details: CodexAuthBlockedDetails,
  ctx: CodexAuthTelemetryContext,
): void {
  const attrs = {
    ...baseAttrs(ctx),
    auth_name: failure.authName,
    failure_kind: failure.kind,
  };
  sink.counter("fabrik.codex_auth.failure_total", 1, attrs);
  sink.event("codex.auth.failure", {
    ...attrs,
    total: details.total,
    failed: details.failed,
    remaining: details.remaining,
  });
}

export function recordCodexAuthRotation(
  rotation: { fromAuthName?: string; toAuthName: string; reason: string },
  details: CodexAuthBlockedDetails,
  ctx: CodexAuthTelemetryContext,
): void {
  const attrs = {
    ...baseAttrs(ctx),
    ...(rotation.fromAuthName ? { from_auth_name: rotation.fromAuthName } : {}),
    to_auth_name: rotation.toAuthName,
    reason: rotation.reason,
  };
  sink.counter("fabrik.codex_auth.rotation_total", 1, attrs);
  sink.event("codex.auth.rotation", {
    ...attrs,
    total: details.total,
    failed: details.failed,
    remaining: details.remaining,
  });
}

export function recordCodexAuthExhausted(
  details: CodexAuthBlockedDetails,
  ctx: CodexAuthTelemetryContext,
): void {
  const attrs = baseAttrs(ctx);
  sink.counter("fabrik.codex_auth.exhausted_total", 1, attrs);
  sink.event("codex.auth.exhausted", {
    ...attrs,
    total: details.total,
    failed: details.failed,
    remaining: details.remaining,
  });
}
