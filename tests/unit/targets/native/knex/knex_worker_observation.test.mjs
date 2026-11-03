import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  KNEX_WORKER_FAILURE_OBSERVATION_PREFIX,
  KNEX_WORKER_REPORTED_CATEGORIES,
  classifyKnexWorkerReportedFailure,
  createKnexWorkerFailureObservation,
  createKnexWorkerHintCollector,
  drainKnexWorkerReportedHint,
  parseKnexWorkerFailureObservation,
  projectKnexWorkerContainerObservation,
  projectKnexWorkerReportedHint,
  readKnexWorkerFailureObservation,
  renderKnexWorkerFailureObservation,
} from "../../../../../dist/src/targets/native/knex/knex_worker_observation.mjs";
import { KNEX_WORKER_CHILD_SOURCE } from "../../../../../dist/src/targets/native/knex/knex_worker_bootstrap.mjs";

it.each([
  ["ECONNREFUSED", "connection-refused"],
  ["ECONNRESET", "connection-closed"],
  ["ETIMEDOUT", "connection-timeout"],
  ["28P01", "authentication"],
  ["42501", "permission"],
  ["57014", "query-canceled"],
  ["55P03", "lock"],
  ["42P07", "duplicate-object"],
  ["42P01", "missing-object"],
  ["23503", "constraint"],
])("projects the untrusted %s code to only %s", (code, category) => {
  const error = {
    code,
    get message() {
      throw Error("PRIVATE_MESSAGE");
    },
  };
  expect(
    KNEX_WORKER_REPORTED_CATEGORIES[classifyKnexWorkerReportedFailure(error)],
  ).toBe(category);
});
it("never retains arbitrary error names/codes or reads their messages", () => {
  expect(classifyKnexWorkerReportedFailure({ name: "KnexTimeoutError" })).toBe(
    10,
  );
  for (const error of [
    null,
    "PRIVATE",
    { code: "PRIVATE_SQL_PASSWORD" },
    { code: "08001" },
    { code: "__proto__" },
    {
      get code() {
        throw Error("PRIVATE");
      },
    },
  ])
    expect(classifyKnexWorkerReportedFailure(error)).toBe(0);
});

it("bounds split child hints and keeps the first failure when teardown also fails", () => {
  const collector = createKnexWorkerHintCollector();
  expect(collector.accept(Buffer.from([3]))).toBe(true);
  expect(collector.accept(Buffer.from([5, 4, 9]))).toBe(true);
  expect(projectKnexWorkerReportedHint(collector.result())).toEqual({
    trust: "untrusted",
    state: "reported",
    hint: "migrate",
    category: "permission",
  });
});
it.each(
  [[0, 0], [5, 0], [3, 12], [3], Array(17).fill(1)].map((bytes) => [bytes]),
)(
  "rejects malformed or overflowing child pipe data %j without copying it",
  (bytes) => {
    const collector = createKnexWorkerHintCollector();
    collector.accept(Buffer.from(bytes));
    expect(projectKnexWorkerReportedHint(collector.result())).toMatchObject({
      state: "invalid",
      hint: null,
      category: "unclassified",
    });
  },
);
it.each(["end", "close", "bound"])(
  "drains a failure hint after child exit until %s, once and within 25ms",
  (event) => {
    vi.useFakeTimers();
    try {
      const pipe = new EventEmitter(),
        done = vi.fn();
      drainKnexWorkerReportedHint(pipe, done);
      vi.advanceTimersByTime(24);
      expect(done).not.toHaveBeenCalled();
      if (event === "bound") vi.advanceTimersByTime(1);
      else pipe.emit(event);
      pipe.emit("end");
      pipe.emit("close");
      vi.advanceTimersByTime(100);
      expect(done).toHaveBeenCalledTimes(1);
      expect(pipe.listenerCount("end") + pipe.listenerCount("close")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
it("distinguishes unavailable hints from invalid frames", () => {
  expect(
    projectKnexWorkerReportedHint(createKnexWorkerHintCollector().result())
      .state,
  ).toBe("absent");
  expect(projectKnexWorkerReportedHint(Buffer.from([3, 5, 0])).state).toBe(
    "invalid",
  );
});

// Run the exact trusted child control flow with inert imports and a fake process.
// No SDK module, filesystem, socket, migration or OS process is executed here.
const childControl = new (Object.getPrototypeOf(
  async function () {},
).constructor)(
  "createRequire",
  "writeSync",
  "process",
  "Buffer",
  KNEX_WORKER_CHILD_SOURCE.replace(
    /^import .*from 'node:(?:module|fs)';\n/gmu,
    "",
  ),
);
const exerciseChild = async (
  failure,
  alsoDestroy = false,
  input = '{"knexDirectory":"/sdk/knex"}',
) => {
  const collector = createKnexWorkerHintCollector();
  const error = {
    code: failure === "migrate" ? "42501" : "ECONNREFUSED",
    get message() {
      throw Error("PRIVATE_MESSAGE");
    },
  };
  let destroyed = false;
  const process = {
    stdin: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(input);
      },
    },
    exitCode: undefined,
    exit(code) {
      this.exitCode = code;
      throw Error("synthetic process exit");
    },
  };
  await childControl(
    () => {
      if (failure === "load") throw error;
      return () => () => ({
        migrate: {
          async latest() {
            if (failure === "migrate") throw error;
          },
        },
        async destroy() {
          destroyed = true;
          if (failure === "destroy" || alsoDestroy) throw { code: "42P01" };
        },
      });
    },
    (fd, bytes) => {
      expect(fd).toBe(3);
      collector.accept(bytes);
    },
    process,
    Buffer,
  );
  return {
    process,
    destroyed,
    reported: projectKnexWorkerReportedHint(collector.result()),
  };
};
it.each([
  ["load", "load", "connection-refused", false],
  ["migrate", "migrate", "permission", true],
  ["destroy", "destroy", "missing-object", true],
])(
  "the exact child reports a fixed %s boundary without raw errors",
  async (failure, hint, category, destroyed) => {
    const result = await exerciseChild(failure);
    expect(result.process.exitCode).toBe(1);
    expect(result.destroyed).toBe(destroyed);
    expect(result.reported).toEqual({
      trust: "untrusted",
      state: "reported",
      hint,
      category,
    });
    expect(JSON.stringify(result.reported)).not.toMatch(/PRIVATE|42501|ECONN/);
  },
);
it("keeps the migration hint when both migrate and destroy fail", async () => {
  expect((await exerciseChild("migrate", true)).reported).toMatchObject({
    hint: "migrate",
    category: "permission",
  });
});
it("the exact child reports malformed input and emits no failure hint after success", async () => {
  expect(
    (await exerciseChild(null, false, "invalid JSON")).reported,
  ).toMatchObject({ hint: "input", category: "unclassified" });
  const success = await exerciseChild(null);
  expect(success.process.exitCode).toBeUndefined();
  expect(success.destroyed).toBe(true);
  expect(success.reported.state).toBe("absent");
});

it("projects only ownership-verified container outcomes, keeping unknowns null", () => {
  expect(
    projectKnexWorkerContainerObservation({
      Running: false,
      Status: "exited",
      ExitCode: 137,
      OOMKilled: true,
      get Error() {
        throw Error("PRIVATE_CONTAINER_ERROR");
      },
    }),
  ).toEqual({
    running: false,
    status: "exited",
    exitCode: 137,
    oomKilled: true,
  });
  expect(
    projectKnexWorkerContainerObservation({
      Running: true,
      Status: "running",
      ExitCode: "PRIVATE",
      OOMKilled: "PRIVATE",
    }),
  ).toEqual({
    running: true,
    status: "running",
    exitCode: null,
    oomKilled: null,
  });
});
it("round-trips one matching bounded private frame and removes it from prose", () => {
  const observation = createKnexWorkerFailureObservation(),
    nonce = "a".repeat(64);
  const frame = renderKnexWorkerFailureObservation(observation, nonce);
  expect(
    readKnexWorkerFailureObservation("before\n" + frame + "\nafter", nonce),
  ).toEqual({ output: "before\nafter", observation });
});
it.each([
  "foreign",
  "duplicate",
  "oversized",
  "unknown-field",
  "invalid-value",
  "malformed",
])(
  "strips %s frames without accepting observation or leaking their bytes",
  (kind) => {
    const observation = createKnexWorkerFailureObservation(),
      nonce = "a".repeat(64);
    let frame = renderKnexWorkerFailureObservation(observation, nonce);
    if (kind === "foreign")
      frame = renderKnexWorkerFailureObservation(observation, "b".repeat(64));
    if (kind === "duplicate") frame += "\n" + frame;
    if (kind === "oversized") frame += "PRIVATE".repeat(1000);
    if (kind === "unknown-field")
      frame =
        KNEX_WORKER_FAILURE_OBSERVATION_PREFIX +
        JSON.stringify({
          nonce,
          observation: { ...observation, raw: "PRIVATE_SQL" },
        });
    if (kind === "invalid-value") {
      observation.host.attachment.exitCode = 999;
      frame =
        KNEX_WORKER_FAILURE_OBSERVATION_PREFIX +
        JSON.stringify({ nonce, observation });
    }
    if (kind === "malformed")
      frame = KNEX_WORKER_FAILURE_OBSERVATION_PREFIX + "PRIVATE_SQL";
    expect(readKnexWorkerFailureObservation(frame + "\n", nonce)).toEqual({
      output: "",
    });
  },
);
it("refuses unknown nested fields and inconsistent untrusted hint states", () => {
  const observation = createKnexWorkerFailureObservation();
  observation.workerReported.category = "permission";
  expect(parseKnexWorkerFailureObservation(observation)).toBeNull();
  observation.workerReported.category = "unclassified";
  observation.host.container = {
    running: false,
    status: "exited",
    exitCode: 1,
    oomKilled: false,
    Error: "PRIVATE",
  };
  expect(parseKnexWorkerFailureObservation(observation)).toBeNull();
});
