import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeRehearsalConfig } from "../../../dist/src/project/configuration_normalization.mjs";
import {
  applyStopStalePlan,
  createStopStalePlan,
  inspectStopStalePlan,
} from "../../../dist/src/runtime/stale_environment_plan.mjs";

const now = new Date("2026-10-13T12:00:00Z");
const engineIdentity = "e".repeat(64);
const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const config = (
  id = "primary-rehearsal",
  resources = { staleAfterSeconds: 3600 },
) =>
  normalizeRehearsalConfig({
    schemaVersion: 1,
    project: { name: "stale-test" },
    postgresql: { migrationDirectory: "database/migrations" },
    baseline: { sanitizationPolicy: "rehearsal/policy.json" },
    resources,
    application: { startCommand: "npm run dev", proofCommand: "npm test" },
    runtime: { target: "postgresql", projectId: id, databasePort: 58322 },
  });
const target = (name = "primary", id = "primary-rehearsal", resources) => ({
  name,
  configPath: `${name}.config.mjs`,
  config: config(id, resources),
});
const container = (
  id = "a".repeat(64),
  project = "primary-rehearsal",
  overrides = {},
) => ({
  Id: id,
  Config: { Labels: { "com.rehearsal-db.project": project } },
  State: {
    Running: true,
    StartedAt: "2026-10-13T09:00:00Z",
    FinishedAt: "0001-01-01T00:00:00Z",
  },
  ...overrides,
});
const plan = (overrides = {}) =>
  createStopStalePlan({
    projectRoot: "/tmp/synthetic-project",
    targets: [target()],
    containers: [container()],
    engineIdentity,
    now,
    ...overrides,
  });

describe("stop stale environment plan", () => {
  it("binds only long-running exact owned containers and explicitly preserves persistent data", () => {
    const preview = plan({
      containers: [container(), container("b".repeat(64), "another-project")],
    });
    expect(preview.targets).toHaveLength(1);
    expect(preview.targets[0].containers.map((entry) => entry.id)).toEqual([
      "a".repeat(64),
    ]);
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.activityLimitation).toContain(
      "does not prove application or database inactivity",
    );
    expect(preview.preserves).toContain("shared engine");
    expect(preview.digest).toBe(plan().digest);
    // Fixed before extracting the shared review evaluator: annotations must not change exact approval scope.
    expect(plan().digest).toBe(
      "6dc7d66ecde45ad5a9d51e4848f9eff560748dfa398d3c1727a15a2ff024fd74",
    );
  });
  it("omits disabled, fresh, absent, stopped, ambiguous, or unknown-activity environments", () => {
    expect(
      plan({ targets: [target("primary", "primary-rehearsal", {})] }).targets,
    ).toEqual([]);
    expect(plan({ containers: [] }).targets).toEqual([]);
    expect(
      plan({
        containers: [
          container(undefined, undefined, {
            State: { Running: false, FinishedAt: "2026-10-13T09:00:00Z" },
          }),
        ],
      }).targets,
    ).toEqual([]);
    expect(
      plan({
        containers: [
          container(undefined, undefined, {
            State: { Running: true, StartedAt: "2026-10-13T11:30:00Z" },
          }),
        ],
      }).targets,
    ).toEqual([]);
    expect(
      plan({
        containers: [
          container(undefined, undefined, { State: { Running: true } }),
        ],
      }).skipped[0].reason,
    ).toContain("unknown");
    expect(
      plan({
        containers: [
          container(undefined, undefined, {
            Config: {
              Labels: {
                "com.rehearsal-db.project": "primary-rehearsal",
                "com.supabase.cli.project": "another-project",
              },
            },
          }),
        ],
      }).skipped[0].reason,
    ).toContain("Conflicting ownership");
  });
  it("refuses incomplete IDs/state and duplicates rather than guessing ownership", () => {
    expect(() => plan({ containers: [container("truncated-id")] })).toThrow(
      "incomplete or conflicting",
    );
    expect(() => plan({ containers: [container(), container()] })).toThrow(
      "incomplete or conflicting",
    );
    expect(() =>
      plan({
        containers: [
          container(undefined, undefined, {
            State: { StartedAt: "2026-10-13T09:00:00Z" },
          }),
        ],
      }),
    ).not.toThrow();
    expect(() => plan({ engineIdentity: "unknown" })).toThrow(
      "cannot be verified",
    );
  });
  it("changes the digest for engine, configuration, target, or container restart changes", () => {
    expect(plan({ engineIdentity: "f".repeat(64) }).digest).not.toBe(
      plan().digest,
    );
    expect(
      plan({
        targets: [
          target("primary", "primary-rehearsal", { staleAfterSeconds: 7200 }),
        ],
      }).digest,
    ).not.toBe(plan().digest);
    expect(plan({ containers: [container("b".repeat(64))] }).digest).not.toBe(
      plan().digest,
    );
    expect(
      plan({
        containers: [
          container(undefined, undefined, {
            State: { Running: true, StartedAt: "2026-10-13T08:00:00Z" },
          }),
        ],
      }).digest,
    ).not.toBe(plan().digest);
  });
  it("applies only an exact confirmation in reverse configured order, rechecking each target", async () => {
    const targets = [target(), target("read-api", "read-api-rehearsal")];
    let containers = [
      container(),
      container("b".repeat(64), "read-api-rehearsal"),
    ];
    const preview = plan({ targets, containers });
    const stopped = [];
    const result = await applyStopStalePlan({
      preview,
      confirmation: preview.digest,
      refresh: async () => plan({ targets, containers }),
      stop: async (selected) => {
        stopped.push(selected.target);
        containers = containers.map((entry) =>
          selected.containers.some((item) => item.id === entry.Id)
            ? { ...entry, State: { ...entry.State, Running: false } }
            : entry,
        );
      },
    });
    expect(result).toEqual(["read-api", "primary"]);
    expect(stopped).toEqual(result);
  });
  it("refuses stale approvals and preserves remaining targets when later evidence changes", async () => {
    const preview = plan();
    let calls = 0;
    const stopped = [];
    await expect(
      applyStopStalePlan({
        preview,
        confirmation: "wrong",
        refresh: async () => preview,
        stop: async () => stopped.push("bad"),
      }),
    ).rejects.toThrow("confirmation");
    await expect(
      applyStopStalePlan({
        preview,
        confirmation: preview.digest,
        refresh: async () =>
          ++calls === 1 ? preview : plan({ engineIdentity: "f".repeat(64) }),
        stop: async () => stopped.push("bad"),
      }),
    ).rejects.toThrow("changed before stopping");
    expect(stopped).toEqual([]);
  });
  it("never starts a stopped engine or contacts a remote context", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-stale-plan-"));
    roots.push(root);
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      `export default ${JSON.stringify({ schemaVersion: 1, project: { name: "stale-test" }, postgresql: { migrationDirectory: "database/migrations" }, baseline: { sanitizationPolicy: "rehearsal/policy.json" }, resources: { staleAfterSeconds: 3600 }, application: { startCommand: "npm run dev", proofCommand: "npm test" }, runtime: { target: "postgresql", databasePort: 58322 } })};`,
    );
    const result = (status, stdout = "") => ({ status, stdout, stderr: "" });
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "context" && args[1] === "show")
        return result(0, "local");
      if (args[0] === "context" && args[1] === "inspect")
        return result(0, JSON.stringify("unix:///tmp/test-docker.sock"));
      if (args.at(-1) === "info") return result(1);
      throw new Error("Unexpected engine mutation");
    };
    await expect(
      inspectStopStalePlan({ projectRoot: root }, { run }),
    ).rejects.toThrow("never starts it");
    expect(calls).toHaveLength(3);
    await expect(
      inspectStopStalePlan(
        { projectRoot: root },
        {
          run: (command, args) =>
            args[1] === "show"
              ? result(0, "remote")
              : result(0, JSON.stringify("ssh://production.example")),
        },
      ),
    ).rejects.toThrow("local Docker endpoint");
  });
});
