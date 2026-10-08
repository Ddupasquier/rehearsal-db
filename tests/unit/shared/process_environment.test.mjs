import { describe, expect, it } from "vitest";
import {
  assertLoopbackUrl,
  createCleanProcessEnvironment,
  isLoopbackUrl,
  pickEnvironmentVariables,
} from "../../../dist/src/shared/process_environment.mjs";

describe("process environment", () => {
  it("accepts loopback URLs and rejects remote or malformed values", () => {
    expect(isLoopbackUrl("http://localhost:5175/ready")).toBe(true);
    expect(isLoopbackUrl("https://127.0.0.1:54321")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3000")).toBe(true);
    expect(isLoopbackUrl("https://example.com")).toBe(false);
    expect(isLoopbackUrl("not-a-url")).toBe(false);
    expect(() =>
      assertLoopbackUrl("Application URL", "https://example.com"),
    ).toThrow("Application URL must use a loopback URL");
  });

  it("copies only named, defined environment values", () => {
    expect(
      pickEnvironmentVariables({ KEEP: "yes", OMIT: undefined, SECRET: "no" }, [
        "KEEP",
        "OMIT",
      ]),
    ).toEqual({ KEEP: "yes" });
  });

  it("builds a minimal environment and omits undefined overrides", () => {
    expect(
      createCleanProcessEnvironment({
        inheritedEnvironment: {
          PATH: "/usr/bin",
          SAFE_EXTRA: "copied",
          UNLISTED_SECRET: "hidden",
        },
        passthroughKeys: ["SAFE_EXTRA"],
        overrides: {
          DATABASE_URL: "postgresql://localhost/rehearsal",
          REMOVE_ME: undefined,
        },
      }),
    ).toEqual({
      PATH: "/usr/bin",
      SAFE_EXTRA: "copied",
      DATABASE_URL: "postgresql://localhost/rehearsal",
    });
  });
});
