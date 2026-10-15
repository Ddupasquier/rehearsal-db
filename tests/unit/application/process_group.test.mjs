import { describe, expect, it } from "vitest";
import {
  probeOwnedProcessGroup,
  stopOwnedPosixProcessGroup,
} from "../../../dist/src/application/process_group.mjs";

const failure = (code) =>
  Object.assign(new Error("private kernel detail omitted"), { code });
const fixture = (states) => {
  let clock = 0;
  const signals = [];
  let index = 0;
  return {
    signals,
    options: {
      pid: 12345,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
      gracefulTimeoutMs: 50,
      forceTimeoutMs: 50,
      signalGroup: (pid, signal) => {
        expect(pid).toBe(-12345);
        if (signal !== 0) {
          signals.push(signal);
          return;
        }
        const state = states[Math.min(index++, states.length - 1)];
        if (state !== "present")
          throw failure(state === "absent" ? "ESRCH" : "EPERM");
      },
    },
  };
};
describe("owned POSIX application process-group teardown", () => {
  it("does not confuse EPERM with absent permission or absent workloads", () => {
    expect(
      probeOwnedProcessGroup(12345, () => {
        throw failure("EPERM");
      }),
    ).toBe("unknown");
    expect(
      probeOwnedProcessGroup(12345, () => {
        throw failure("ESRCH");
      }),
    ).toBe("absent");
    expect(() =>
      probeOwnedProcessGroup(12345, () => {
        throw failure("EIO");
      }),
    ).toThrow();
  });
  it("accepts disappearance only after a transient unknown probe becomes ESRCH", async () => {
    const control = fixture(["unknown", "absent"]);
    await expect(
      stopOwnedPosixProcessGroup(control.options),
    ).resolves.toBeUndefined();
    expect(control.signals).toEqual(["SIGTERM"]);
  });
  it("rechecks a post-SIGKILL EPERM until absence is proven", async () => {
    const control = fixture([
      "present",
      "present",
      "present",
      "unknown",
      "absent",
    ]);
    await expect(
      stopOwnedPosixProcessGroup(control.options),
    ).resolves.toBeUndefined();
    expect(control.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
  it("refuses persistent unknown without sending another signal", async () => {
    const control = fixture(["unknown"]);
    await expect(stopOwnedPosixProcessGroup(control.options)).rejects.toThrow(
      "no further signal was sent while permission was unknown",
    );
    expect(control.signals).toEqual(["SIGTERM"]);
  });
  it("refuses persistent post-KILL unknown instead of claiming cleanup success", async () => {
    const control = fixture(["present", "present", "present", "unknown"]);
    await expect(stopOwnedPosixProcessGroup(control.options)).rejects.toThrow(
      "Resources may remain",
    );
    expect(control.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
