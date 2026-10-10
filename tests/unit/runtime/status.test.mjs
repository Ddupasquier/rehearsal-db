import { describe, expect, it } from "vitest";
import {
  parseRuntimeStatusSnapshot,
  renderRuntimeStatusSnapshot,
} from "../../../dist/src/runtime/status.mjs";

const runningSupabase = {
  schemaVersion: 1,
  state: "running",
  reason: null,
  runtimeTarget: "supabase",
  projectId: "fixture-rehearsal",
  endpoint: { kind: "http", url: "http://127.0.0.1:54321" },
  baselineGenerationId: "20261009T120000Z-example",
  candidateSha256: "a".repeat(64),
  candidates: ["20261009000100_add_widget.sql"],
};

describe("structured runtime status", () => {
  it("accepts and renders a running loopback runtime", () => {
    const status = parseRuntimeStatusSnapshot(runningSupabase);

    expect(status).toEqual(runningSupabase);
    expect(renderRuntimeStatusSnapshot(status)).toContain(
      "Local Rehearsal Supabase: running at http://127.0.0.1:54321",
    );
    expect(renderRuntimeStatusSnapshot(status)).toContain(
      "20261009000100_add_widget.sql",
    );
  });

  it.each([
    ["stopped", "runtime_not_running"],
    ["unavailable", "container_engine_unavailable"],
    ["unhealthy", "health_check_failed"],
  ])("accepts the %s state without an endpoint", (state, reason) => {
    expect(
      parseRuntimeStatusSnapshot({
        ...runningSupabase,
        state,
        reason,
        endpoint: null,
      }),
    ).toMatchObject({ state, reason, endpoint: null });
  });

  it("refuses remote endpoints before they reach public JSON", () => {
    expect(() =>
      parseRuntimeStatusSnapshot({
        ...runningSupabase,
        endpoint: { kind: "http", url: "https://database.example.com" },
      }),
    ).toThrow("non-loopback");
  });

  it("requires endpoints only for running runtimes", () => {
    expect(() =>
      parseRuntimeStatusSnapshot({ ...runningSupabase, endpoint: null }),
    ).toThrow("must include its local endpoint");
    expect(() =>
      parseRuntimeStatusSnapshot({
        ...runningSupabase,
        state: "stopped",
        reason: "runtime_not_running",
      }),
    ).toThrow("Only a running runtime status");
  });

  it("requires each state to use its exact public reason", () => {
    expect(() =>
      parseRuntimeStatusSnapshot({
        ...runningSupabase,
        state: "unhealthy",
        reason: "runtime_not_running",
        endpoint: null,
      }),
    ).toThrow("reason does not match");
  });

  it("accepts a credential-free PostgreSQL endpoint", () => {
    expect(
      parseRuntimeStatusSnapshot({
        ...runningSupabase,
        runtimeTarget: "postgresql",
        endpoint: {
          kind: "postgresql",
          host: "127.0.0.1",
          port: 55432,
          database: "postgres",
        },
      }).endpoint,
    ).toEqual({
      kind: "postgresql",
      host: "127.0.0.1",
      port: 55432,
      database: "postgres",
    });
  });

  it("refuses an endpoint kind that does not match the runtime target", () => {
    expect(() =>
      parseRuntimeStatusSnapshot({
        ...runningSupabase,
        runtimeTarget: "postgresql",
      }),
    ).toThrow("endpoint does not match");
  });
});
