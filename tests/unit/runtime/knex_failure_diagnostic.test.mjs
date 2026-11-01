import { expect, it } from "vitest";
import {
  markKnexFailure,
  markKnexFailureBoundary,
  preserveKnexFailure,
  readKnexFailure,
  readKnexFailureFrame,
  renderKnexFailureFrame,
  withKnexFailureBoundary,
} from "../../../dist/src/runtime/knex_failure_diagnostic.mjs";
const origin = {
  phase: "verify",
  stage: "sql",
  reason: "execution-unconfirmed",
};
const cleanup = {
  phase: "verify",
  stage: "cleanup",
  reason: "cleanup-unconfirmed",
};
const nonce = "a".repeat(64);

it("brands only host-owned evidence and preserves thrown identity without raw values", async () => {
  const error = Object.assign(new Error("PRIVATE_SQL_PASSWORD_PATH"), {
    nativeFailure: { primary: origin },
  });
  expect(readKnexFailure(error)).toBeUndefined();
  await expect(
    withKnexFailureBoundary(
      { phase: "application", stage: "role", reason: "unclassified" },
      async () => {
        throw error;
      },
    ),
  ).rejects.toBe(error);
  const evidence = readKnexFailure(error);
  expect(evidence.primary).toEqual({
    phase: "application",
    stage: "role",
    reason: "unclassified",
  });
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
  markKnexFailure(error, origin);
  expect(readKnexFailure(error)).toEqual(evidence);
});

it("keeps the original failure before secondary cleanup and surviving sanitizing replacement", () => {
  const first = markKnexFailure(new Error("private first"), origin);
  const aggregate = markKnexFailure(
    new AggregateError([first], "private cleanup"),
    cleanup,
  );
  const replacement = preserveKnexFailure(
    aggregate,
    new Error("fixed sanitized text"),
  );
  expect(readKnexFailure(replacement)).toMatchObject({
    primary: origin,
    cleanup,
  });
});

it("does not turn a cleanup wrapper into the cause when the original error was unclassified", () => {
  const original = new Error("private original");
  const aggregate = markKnexFailure(new AggregateError([original]), cleanup);
  markKnexFailureBoundary(aggregate, {
    phase: "verify",
    stage: "role",
    reason: "unclassified",
  });
  expect(readKnexFailure(aggregate)).toMatchObject({
    primary: { phase: "verify", stage: "role", reason: "unclassified" },
    cleanup,
  });
});

it("rejects cyclic, excessive-depth and oversized aggregate evidence without invoking errors getters", () => {
  const cyclic = new AggregateError([]);
  cyclic.errors.push(cyclic);
  markKnexFailure(cyclic, origin);
  expect(readKnexFailure(cyclic)).toBeUndefined();
  let deep = markKnexFailure(new Error(), origin);
  for (let i = 0; i < 10; i++) deep = new AggregateError([deep]);
  expect(readKnexFailure(deep)).toBeUndefined();
  expect(
    readKnexFailure(
      new AggregateError(Array.from({ length: 33 }, () => new Error())),
    ),
  ).toBeUndefined();
  const accessor = new AggregateError([]);
  Object.defineProperty(accessor, "errors", {
    get() {
      throw new Error("must not execute");
    },
  });
  expect(readKnexFailure(accessor)).toBeUndefined();
});

it("accepts a single nonce-bound closed frame and removes its transport bytes", () => {
  const frame = renderKnexFailureFrame(
    markKnexFailure(new Error("PRIVATE"), origin),
    nonce,
  );
  const parsed = readKnexFailureFrame(
    frame + "\nError: existing failure",
    nonce,
  );
  expect(parsed.nativeFailure.primary).toEqual(origin);
  expect(parsed.output).toBe("Error: existing failure");
  expect(parsed.output).not.toContain(nonce);
});

it("refuses foreign, duplicated, conflicting, malformed and unknown frames without leaking payload", () => {
  const frame = renderKnexFailureFrame(
    markKnexFailure(new Error(), origin),
    nonce,
  );
  const invalid = [
    frame.replace(nonce, "b".repeat(64)),
    frame + "\n" + frame,
    frame + "\n" + frame.replace('"verify"', '"restore"'),
    frame.replace('"sql"', '"PRIVATE_SQL_PASSWORD_PATH"'),
    frame.replace('"schemaVersion":1', '"schemaVersion":2'),
    "Rehearsal native failure: {PRIVATE_SQL_PASSWORD_PATH}",
    "Rehearsal native failure: " + "x".repeat(2049),
  ];
  for (const candidate of invalid) {
    const result = readKnexFailureFrame(
      candidate + "\nError: original remains",
      nonce,
    );
    expect(result.nativeFailure).toBeUndefined();
    expect(result.output).toBe("Error: original remains");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain(nonce);
  }
});

it("does not brand forged error properties or manufacture SQLSTATE", () => {
  expect(
    renderKnexFailureFrame({ nativeFailure: { primary: origin } }, nonce),
  ).toBeUndefined();
  expect(
    renderKnexFailureFrame(
      markKnexFailure(new Error(), origin),
      "private-invalid-nonce",
    ),
  ).toBeUndefined();
  expect(
    JSON.stringify(readKnexFailure(markKnexFailure(new Error(), origin))),
  ).not.toMatch(/sqlState|message|cause/);
});

it("keeps a newly branded cleanup wrapper alongside inherited original evidence", () => {
  const first = markKnexFailure(new Error("private"), origin);
  const replacement = preserveKnexFailure(
    first,
    markKnexFailure(new AggregateError([]), cleanup),
  );
  expect(readKnexFailure(replacement)).toMatchObject({
    primary: origin,
    cleanup,
  });
});

it("diagnostic reflection cannot replace a hostile thrown proxy", async () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  expect(readKnexFailure(proxy)).toBeUndefined();
  await expect(
    withKnexFailureBoundary(
      { phase: "application", stage: "execution", reason: "unclassified" },
      async () => {
        throw proxy;
      },
    ),
  ).rejects.toBe(proxy);
});

it("preserves a stateful Proxy when a later boundary reflection fails", async () => {
  let reads = 0;
  const original = new Proxy(new AggregateError([]), {
    getOwnPropertyDescriptor(target, key) {
      if (key === "errors" && ++reads >= 3)
        throw new Error("PRIVATE_LATE_TRAP");
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  await expect(
    withKnexFailureBoundary(
      { phase: "application", stage: "execution", reason: "unclassified" },
      async () => {
        throw original;
      },
    ),
  ).rejects.toBe(original);
  expect(reads).toBeGreaterThanOrEqual(3);
});
