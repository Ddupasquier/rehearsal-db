import { describe, expect, it } from "vitest";
import {
  assertCommand,
  assertDatabaseIdentifier,
  assertEnvironmentKey,
  assertEnvironmentReference,
  assertIdentifier,
  assertKnownKeys,
  assertLoopbackUrl,
  assertPort,
  assertPositiveInteger,
  assertRelativePath,
} from "../../../dist/src/project/configuration_validation.mjs";
import {
  RehearsalError,
  serializeRehearsalError,
} from "../../../dist/src/shared/diagnostics.mjs";

describe("configuration validators", () => {
  it.each([
    0,
    -1,
    false,
    true,
    "3",
    null,
    undefined,
    [],
    {},
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "classifies invalid positive-integer settings without baseline-name guessing (%j)",
    (value) => {
      try {
        assertPositiveInteger(
          value,
          "config.cleanup.retainBaselineGenerations",
        );
        throw new Error("Unexpected validation success.");
      } catch (error) {
        expect(error).toBeInstanceOf(RehearsalError);
        expect(error.exitCode).toBe(2);
        expect(serializeRehearsalError(error).error).toMatchObject({
          category: "configuration_invalid",
          code: "CONFIGURATION_INVALID",
          message:
            "config.cleanup.retainBaselineGenerations must be a positive integer.",
        });
      }
    },
  );

  it("accepts only positive safe integer boundaries", () => {
    for (const value of [1, Number.MAX_SAFE_INTEGER])
      expect(assertPositiveInteger(value, "config.limit")).toBe(value);
  });

  it("accepts project-owned paths, safe commands, and non-privileged ports", () => {
    expect(assertRelativePath("database/migrations", "path")).toBe(
      "database/migrations",
    );
    expect(assertCommand("npm run test", "command")).toBe("npm run test");
    expect(assertPort(58322, "port")).toBe(58322);
    expect(assertIdentifier("project-name", "name")).toBe("project-name");
    expect(assertDatabaseIdentifier("local_database", "database")).toBe(
      "local_database",
    );
    expect(assertEnvironmentKey("DATABASE_URL", "key")).toBe("DATABASE_URL");
    expect(
      assertEnvironmentReference("primary:DATABASE_URL", "reference"),
    ).toBe("primary:DATABASE_URL");
  });

  it("rejects escaping paths, control characters, and privileged ports", () => {
    expect(() => assertRelativePath("../outside", "path")).toThrow(
      "inside the project root",
    );
    expect(() => assertCommand("npm test\nrm", "command")).toThrow(
      "unsafe control character",
    );
    expect(() => assertPort(543, "port")).toThrow("non-privileged TCP port");
    expect(() => assertIdentifier("Project Name", "name")).toThrow(
      "lowercase letters",
    );
    expect(() => assertDatabaseIdentifier("bad-name", "database")).toThrow(
      "PostgreSQL identifier",
    );
    expect(() => assertEnvironmentKey("bad-key", "key")).toThrow(
      "environment variable name",
    );
    expect(() =>
      assertEnvironmentReference("DATABASE_URL", "reference"),
    ).toThrow("target:VARIABLE");
  });

  it("reports unknown keys with their complete schema path", () => {
    expect(() =>
      assertKnownKeys({ expected: true, typo: true }, ["expected"], "config"),
    ).toThrow("Unknown Rehearsal configuration property: config.typo");
  });

  it("accepts only explicitly supported loopback URLs", () => {
    const supported = new Set(["127.0.0.1", "localhost"]);
    expect(
      assertLoopbackUrl(
        "http://localhost:5175/",
        "url",
        ["localhost"],
        supported,
      ),
    ).toBe("http://localhost:5175");
    expect(() =>
      assertLoopbackUrl("https://example.com", "url", ["localhost"], supported),
    ).toThrow("explicitly allowed loopback host");
  });
});
