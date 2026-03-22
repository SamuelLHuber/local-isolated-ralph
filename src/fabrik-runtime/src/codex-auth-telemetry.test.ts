import { beforeEach, describe, expect, it } from "bun:test";
import {
  __resetCodexAuthTelemetrySinkForTests,
  __setCodexAuthTelemetrySinkForTests,
  recordCodexAuthExhausted,
  recordCodexAuthFailure,
  recordCodexAuthPoolSnapshot,
  recordCodexAuthRotation,
} from "./codex-auth-telemetry";

const sampleDetails = {
  total: 3,
  failed: 2,
  remaining: 1,
  activeAuthName: "backup.auth.json",
  failedAuths: [
    { authName: "auth.json", kind: "usage_limit" as const },
    { authName: "other.auth.json", kind: "refresh_token_reused" as const },
  ],
};

describe("codex-auth telemetry", () => {
  const state = {
    counters: [] as Array<{ name: string; value: number; attrs?: Record<string, unknown> }>,
    gauges: [] as Array<{ name: string; value: number; attrs?: Record<string, unknown> }>,
    events: [] as Array<{ name: string; attrs?: Record<string, unknown> }>,
  };

  beforeEach(() => {
    state.counters.length = 0;
    state.gauges.length = 0;
    state.events.length = 0;
    __setCodexAuthTelemetrySinkForTests({
      counter(name, value, attrs) {
        state.counters.push({ name, value, attrs });
      },
      gauge(name, value, attrs) {
        state.gauges.push({ name, value, attrs });
      },
      event(name, attrs) {
        state.events.push({ name, attrs });
      },
    });
  });

  it("records pool snapshot gauges", () => {
    recordCodexAuthPoolSnapshot(sampleDetails, {
      runId: "run-1",
      namespace: "fabrik-runs",
    });

    expect(state.gauges).toEqual([
      { name: "fabrik.codex_auth.pool.total", value: 3, attrs: expect.any(Object) },
      { name: "fabrik.codex_auth.pool.failed", value: 2, attrs: expect.any(Object) },
      { name: "fabrik.codex_auth.pool.remaining", value: 1, attrs: expect.any(Object) },
      { name: "fabrik.codex_auth.pool.failed_usage_limit", value: 1, attrs: expect.any(Object) },
      { name: "fabrik.codex_auth.pool.failed_refresh_token_reused", value: 1, attrs: expect.any(Object) },
      { name: "fabrik.codex_auth.pool.failed_auth_invalid", value: 0, attrs: expect.any(Object) },
    ]);
  });

  it("records auth failures as counters and events", () => {
    recordCodexAuthFailure(
      { authName: "auth.json", kind: "usage_limit" },
      sampleDetails,
      { runId: "run-1", namespace: "fabrik-runs" },
    );

    expect(state.counters).toEqual([
      {
        name: "fabrik.codex_auth.failure_total",
        value: 1,
        attrs: expect.objectContaining({ failure_kind: "usage_limit", auth_name: "auth.json" }),
      },
    ]);
    expect(state.events).toEqual([
      {
        name: "codex.auth.failure",
        attrs: expect.objectContaining({ failure_kind: "usage_limit", auth_name: "auth.json", total: 3 }),
      },
    ]);
  });

  it("records rotations as counters and events", () => {
    recordCodexAuthRotation(
      { fromAuthName: "auth.json", toAuthName: "backup.auth.json", reason: "codex auth / usage failure" },
      sampleDetails,
      { runId: "run-1", namespace: "fabrik-runs" },
    );

    expect(state.counters).toEqual([
      {
        name: "fabrik.codex_auth.rotation_total",
        value: 1,
        attrs: expect.objectContaining({ from_auth_name: "auth.json", to_auth_name: "backup.auth.json" }),
      },
    ]);
    expect(state.events).toEqual([
      {
        name: "codex.auth.rotation",
        attrs: expect.objectContaining({ from_auth_name: "auth.json", to_auth_name: "backup.auth.json", total: 3 }),
      },
    ]);
  });

  it("records auth exhaustion as counters and events", () => {
    recordCodexAuthExhausted(sampleDetails, {
      runId: "run-1",
      namespace: "fabrik-runs",
    });

    expect(state.counters).toEqual([
      {
        name: "fabrik.codex_auth.exhausted_total",
        value: 1,
        attrs: expect.any(Object),
      },
    ]);
    expect(state.events).toEqual([
      {
        name: "codex.auth.exhausted",
        attrs: expect.objectContaining({ remaining: 1, failed: 2, total: 3 }),
      },
    ]);
  });

  it("can reset the test sink back to the default implementation", () => {
    __resetCodexAuthTelemetrySinkForTests();
    // The important contract is that reset does not throw and leaves the module usable.
    recordCodexAuthExhausted(sampleDetails, {
      runId: "run-1",
      namespace: "fabrik-runs",
    });
  });
});
