import { describe, expect, it, vi } from "vitest";
import {
  assertApplicationPortAvailable,
  parseLocalApplicationEndpoint,
} from "../../../dist/src/application/port_preflight.mjs";

describe("safe local application endpoint preflight", () => {
  it.each([
    ["http://localhost/health?private=hidden", { host: "localhost", port: 80 }],
    ["https://[::1]/ready", { host: "::1", port: 443 }],
    ["http://127.0.0.1:5175/", { host: "127.0.0.1", port: 5175 }],
  ])(
    "keeps effective HTTP(S) ports without retaining paths or queries",
    (url, endpoint) => {
      expect(parseLocalApplicationEndpoint(url)).toEqual(endpoint);
    },
  );

  it.each([
    "https://production.invalid/?private=hidden",
    "http://user:secret@localhost:5175/?private=hidden",
    "ftp://localhost:5175/private",
    "http://localhost:0",
    "http://localhost:65536",
    null,
  ])(
    "refuses unknown, credentialed and non-HTTP endpoints without exposing their values",
    (url) => {
      let failure;
      try {
        parseLocalApplicationEndpoint(url);
      } catch (error) {
        failure = error.message;
      }
      expect(failure).toMatch(/endpoint/u);
      expect(failure).not.toMatch(/private|hidden|secret|production\.invalid/u);
    },
  );

  it("checks both localhost aliases and refuses either occupied listener", async () => {
    const probe = vi.fn(async (host) => (host === "::1" ? "occupied" : "free"));
    await expect(
      assertApplicationPortAvailable({
        url: "http://localhost:5175/health?private=hidden",
        probe,
      }),
    ).rejects.toThrow("port 5175 is already in use");
    expect(probe.mock.calls).toEqual([
      ["127.0.0.1", 5175],
      ["::1", 5175],
    ]);
  });

  it("handles absent IPv6 honestly and refuses timeouts, failures and unknown results", async () => {
    await expect(
      assertApplicationPortAvailable({
        url: "http://localhost:5175",
        probe: async (host) => (host === "::1" ? "unsupported" : "free"),
      }),
    ).resolves.toBeUndefined();
    for (const state of ["unavailable", "unsupported", "guessed-free"])
      await expect(
        assertApplicationPortAvailable({
          url: "http://[::1]:5175",
          probe: async () => state,
        }),
      ).rejects.toThrow("could not be proved");
    await expect(
      assertApplicationPortAvailable({
        url: "https://localhost/?private=hidden",
        probe: async () => {
          throw new Error("private probe failure");
        },
      }),
    ).rejects.toThrow("could not be proved");
    await expect(
      assertApplicationPortAvailable({
        url: "https://localhost/?private=hidden",
        probe: async () => {
          throw new Error("private probe failure");
        },
      }),
    ).rejects.not.toThrow("private");
  });
});
