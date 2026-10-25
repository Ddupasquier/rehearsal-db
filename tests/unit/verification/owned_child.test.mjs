import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitOwnedFixtureCancellation,
  terminateOwnedFixtureChild,
} from "../../../scripts/verification/scenarios/owned_child.mjs";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const fixture = (onKill = () => {}) => {
  let resolve;
  const exit = new Promise((done) => {
    resolve = done;
  });
  const child = { kill: vi.fn((signal) => onKill(signal, resolve)) };
  return { child, exit, resolve };
};
it("returns the actual timely cancellation result without extra signals", async () => {
  const owned = fixture();
  const pending = awaitOwnedFixtureCancellation(owned);
  setTimeout(() => owned.resolve({ status: 130, signal: null }), 200);
  await vi.advanceTimersByTimeAsync(200);
  await expect(pending).resolves.toEqual({ status: 130, signal: null });
  expect(owned.child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("enforces ten seconds and escalates only its supplied child", async () => {
  const owned = fixture((signal, resolve) => {
    if (signal === "SIGKILL") resolve({ status: null, signal });
  });
  const foreign = { kill: vi.fn() };
  const assertion = expect(
    awaitOwnedFixtureCancellation(owned),
  ).rejects.toThrow("10000ms exit deadline");
  await vi.advanceTimersByTimeAsync(9_999);
  expect(owned.child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_001);
  await assertion;
  expect(owned.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(foreign.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds an unacknowledged kill and preserves cancellation and cleanup failures", async () => {
  const owned = fixture();
  const assertion = expect(
    awaitOwnedFixtureCancellation(owned),
  ).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: expect.stringContaining("10000ms") }),
      expect.objectContaining({
        message: expect.stringContaining("termination"),
      }),
    ],
  });
  await vi.advanceTimersByTimeAsync(12_000);
  await assertion;
  expect(owned.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(vi.getTimerCount()).toBe(0);
});
it("reaps a failure-path child after bounded graceful termination", async () => {
  const owned = fixture((signal, resolve) => {
    if (signal === "SIGTERM") resolve({ status: null, signal });
  });
  await expect(terminateOwnedFixtureChild(owned)).resolves.toEqual({
    status: null,
    signal: "SIGTERM",
  });
  expect(owned.child.kill.mock.calls).toEqual([["SIGTERM"]]);
  expect(vi.getTimerCount()).toBe(0);
});
