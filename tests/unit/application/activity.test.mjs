import { describe, expect, it, vi, afterEach } from "vitest";
import {
  emptyApplicationIdleWindow,
  observeApplicationActivity,
  parseApplicationActivitySample,
  validateApplicationActivityUrl,
} from "../../../dist/src/application/activity_contract.mjs";
import {
  readApplicationActivity,
  waitForApplicationIdle,
} from "../../../dist/src/application/activity_monitor.mjs";

const sample = (activitySequence = 0, busy = false) => ({
  schemaVersion: 1,
  busy,
  activitySequence,
});
const response = (value = sample()) => Response.json(value);
const endpoint = "http://127.0.0.1:5175/activity";
afterEach(() => vi.useRealTimers());

describe("explicit application activity contract", () => {
  it("allows only a bounded same-origin loopback route without credentials or private URL components", () => {
    for (const origin of [
      "http://localhost:5175",
      "http://127.0.0.1:5175",
      "https://[::1]:5175",
    ])
      expect(
        validateApplicationActivityUrl(
          `${origin}/activity`,
          `${origin}/health`,
        ),
      ).toBe(`${origin}/activity`);
    for (const value of [
      "https://hosted.example:5175/activity",
      "http://127.0.0.1:5176/activity",
      "http://user:secret@127.0.0.1:5175/activity",
      `${endpoint}?token=secret`,
      `${endpoint}#secret`,
      "http://127.0.0.1/activity",
      "http://127.0.0.1:80/activity",
      "file:///private/activity",
      `${endpoint}\n`,
    ])
      expect(() =>
        validateApplicationActivityUrl(value, "http://127.0.0.1:5175/health"),
      ).toThrow(/loopback/u);
  });

  it("accepts only the three exact public schema fields", () => {
    expect(parseApplicationActivitySample(sample(0))).toEqual(sample(0));
    for (const value of [
      null,
      [],
      {},
      { ...sample(), token: "PRIVATE_CANARY" },
      { ...sample(), schemaVersion: 2 },
      { ...sample(), busy: "false" },
      sample(-1),
      sample(1.5),
      sample(Number.MAX_SAFE_INTEGER + 1),
    ])
      expect(parseApplicationActivitySample(value)).toBeNull();
  });

  it("requires two valid quiet samples over a full monotonic timeout", () => {
    let window = emptyApplicationIdleWindow();
    const observe = (value, now) => {
      const result = observeApplicationActivity({
        previous: window,
        sample: value,
        now,
        timeoutMs: 100,
      });
      window = result.window;
      return result.idle;
    };
    expect(observe(sample(), 1000)).toBe(false);
    expect(observe(sample(), 1099)).toBe(false);
    expect(observe(sample(), 1100)).toBe(true);
  });

  it("resets on real activity, busy work, missing evidence, regressed sequence and clock anomalies", () => {
    for (const invalid of [null, sample(4), sample(5, true), sample(6)]) {
      let window = observeApplicationActivity({
        previous: emptyApplicationIdleWindow(),
        sample: sample(5),
        now: 0,
        timeoutMs: 100,
      }).window;
      const disrupted = observeApplicationActivity({
        previous: window,
        sample: invalid,
        now: 100,
        timeoutMs: 100,
      });
      expect(disrupted.idle).toBe(false);
      window = disrupted.window;
      expect(
        observeApplicationActivity({
          previous: window,
          sample: sample(6),
          now: 101,
          timeoutMs: 100,
        }).idle,
      ).toBe(false);
    }
    const previous = observeApplicationActivity({
      previous: emptyApplicationIdleWindow(),
      sample: sample(10),
      now: 100,
      timeoutMs: 100,
    }).window;
    const regressed = observeApplicationActivity({
      previous,
      sample: sample(9),
      now: 200,
      timeoutMs: 100,
    }).window;
    expect(regressed.sequence).toBe(10);
    expect(
      observeApplicationActivity({
        previous: regressed,
        sample: sample(9),
        now: 10000,
        timeoutMs: 100,
      }).idle,
    ).toBe(false);
    expect(
      observeApplicationActivity({
        previous,
        sample: sample(10),
        now: 99,
        timeoutMs: 100,
      }).idle,
    ).toBe(false);
  });
});

describe("foreground application activity transport", () => {
  it("refuses redirects, private/unknown fields, malformed/oversized bodies and non-JSON/error responses", async () => {
    const controller = new AbortController();
    const controls = [
      response({ ...sample(), privateValue: "PRIVATE_CANARY" }),
      new Response("PRIVATE_CANARY", {
        headers: { "content-type": "application/json" },
      }),
      new Response(" ".repeat(4097), {
        headers: { "content-type": "application/json" },
      }),
      new Response("{}", {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      new Response("{}", { headers: { "content-type": "text/html" } }),
      new Response("{}", {
        status: 302,
        headers: { location: "https://private.example" },
      }),
    ];
    for (const value of controls)
      expect(
        await readApplicationActivity({
          url: endpoint,
          signal: controller.signal,
          fetchImplementation: async (_url, options) => {
            expect(options.redirect).toBe("error");
            return value;
          },
        }),
      ).toBeNull();
    expect(
      await readApplicationActivity({
        url: endpoint,
        signal: controller.signal,
        fetchImplementation: async () => response(sample(2)),
      }),
    ).toEqual(sample(2));
  });

  it("aborts bounded requests on timeout and owner cancellation without leaking error text", async () => {
    const fetchImplementation = (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("PRIVATE_NETWORK_CANARY")),
          { once: true },
        ),
      );
    const controller = new AbortController();
    expect(
      await readApplicationActivity({
        url: endpoint,
        signal: controller.signal,
        timeoutMs: 2,
        fetchImplementation,
      }),
    ).toBeNull();
    const pending = readApplicationActivity({
      url: endpoint,
      signal: controller.signal,
      fetchImplementation,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(
      "Application activity monitoring stopped",
    );
  });

  it("polls serially and stops only after unchanged non-busy observations cover the timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let active = 0;
    let maximumActive = 0;
    const fetchImplementation = vi.fn(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active--;
      return response();
    });
    const pending = waitForApplicationIdle({
      url: endpoint,
      readinessUrl: "http://127.0.0.1:5175/health",
      timeoutSeconds: 0.03,
      signal: controller.signal,
      fetchImplementation,
      pollIntervalMs: 10,
      now: () => Date.now(),
    });
    await vi.advanceTimersByTimeAsync(40);
    await expect(pending).resolves.toEqual({ reason: "idle-timeout" });
    expect(maximumActive).toBe(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an abort-ignoring body/cancel and never accumulates another request behind it", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise(() => undefined),
            cancel: () => new Promise(() => undefined),
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const unavailable = vi.fn();
    const pending = waitForApplicationIdle({
      url: endpoint,
      readinessUrl: "http://127.0.0.1:5175/health",
      timeoutSeconds: 0.01,
      signal: controller.signal,
      fetchImplementation,
      requestTimeoutMs: 5,
      pollIntervalMs: 5,
      onAvailability: unavailable,
    });
    const observed = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledWith(false);
    controller.abort();
    expect((await observed).name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the foreground session indefinitely when evidence is unavailable and disposes on abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitForApplicationIdle({
      url: endpoint,
      readinessUrl: "http://127.0.0.1:5175/health",
      timeoutSeconds: 0.03,
      signal: controller.signal,
      fetchImplementation: async () => response({ unknown: true }),
      pollIntervalMs: 10,
      now: () => Date.now(),
    });
    const observed = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(200);
    controller.abort();
    expect((await observed).name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });
});
