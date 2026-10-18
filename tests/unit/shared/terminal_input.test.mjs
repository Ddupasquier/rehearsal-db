import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  acquireTerminalInput,
  hasTerminalInputLease,
  reassertTerminalInputLease,
} from "../../../dist/src/shared/terminal_input.mjs";

const makeInput = ({ raw = false, flowing = null, tty = true } = {}) => {
  const input = new EventEmitter();
  input.isTTY = tty;
  input.isRaw = raw;
  input.readableFlowing = flowing;
  input.setRawMode = vi.fn((enabled) => {
    input.isRaw = enabled;
  });
  input.resume = vi.fn(() => {
    input.readableFlowing = true;
  });
  input.pause = vi.fn(() => {
    input.readableFlowing = false;
  });
  return input;
};

describe("owned terminal control input", () => {
  it.each([
    ["\u0003", "SIGINT"],
    [Buffer.from([0x1a]), "SIGTSTP"],
  ])(
    "handles control bytes and restores a previously non-consuming terminal",
    (bytes, signal) => {
      const input = makeInput();
      const interrupt = vi.fn();
      const release = acquireTerminalInput(input, interrupt);
      expect(input.isRaw).toBe(true);
      expect(input.readableFlowing).toBe(true);
      input.emit("data", bytes);
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(signal);
      release();
      release();
      expect(input.isRaw).toBe(false);
      expect(input.readableFlowing).toBe(false);
      expect(input.listenerCount("data")).toBe(0);
      expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    },
  );

  it.each([false, true])(
    "preserves already-raw input and its flowing=%s state",
    (flowing) => {
      const input = makeInput({ raw: true, flowing });
      const release = acquireTerminalInput(input, () => undefined);
      release();
      expect(input.setRawMode).not.toHaveBeenCalled();
      expect(input.isRaw).toBe(true);
      expect(input.readableFlowing).toBe(flowing);
    },
  );

  it("restores the original state only after the final overlapping lease", () => {
    const input = makeInput({ flowing: false });
    const first = acquireTerminalInput(input, () => undefined);
    const second = acquireTerminalInput(input, () => undefined);
    first();
    expect(input.isRaw).toBe(true);
    expect(input.readableFlowing).toBe(true);
    expect(input.listenerCount("data")).toBe(1);
    second();
    expect(input.isRaw).toBe(false);
    expect(input.readableFlowing).toBe(false);
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("dispatches each control byte only to the current surviving owner", () => {
    const input = makeInput();
    const outer = vi.fn();
    const inner = vi.fn();
    const first = acquireTerminalInput(input, outer);
    const second = acquireTerminalInput(input, inner);
    expect(first.isCurrentOwner()).toBe(false);
    expect(second.isCurrentOwner()).toBe(true);
    expect(input.listenerCount("data")).toBe(1);
    input.emit("data", "\u001a");
    expect(inner).toHaveBeenCalledExactlyOnceWith("SIGTSTP");
    expect(outer).not.toHaveBeenCalled();
    second();
    expect(first.isCurrentOwner()).toBe(true);
    input.emit("data", "\u0003");
    expect(outer).toHaveBeenCalledExactlyOnceWith("SIGINT");
    first();
  });

  it("does not deliver the same byte to an outer owner after synchronous inner release", () => {
    const input = makeInput();
    const outer = vi.fn();
    const first = acquireTerminalInput(input, outer);
    let second;
    const inner = vi.fn(() => second());
    second = acquireTerminalInput(input, inner);
    input.emit("data", "\u001a");
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    input.emit("data", "\u0003");
    expect(outer).toHaveBeenCalledOnce();
    first();
  });

  it("tracks distinct owners even when callbacks are identical and release is out of order", () => {
    const input = makeInput();
    const interrupt = vi.fn();
    const first = acquireTerminalInput(input, interrupt);
    const second = acquireTerminalInput(input, interrupt);
    first();
    expect(second.isCurrentOwner()).toBe(true);
    input.emit("data", "\u0003");
    expect(interrupt).toHaveBeenCalledOnce();
    second();
    expect(input.isRaw).toBe(false);
  });

  it("tracks non-TTY signal ownership without consuming or changing the stream", () => {
    const input = makeInput({ tty: false });
    const first = acquireTerminalInput(input, () => undefined);
    const second = acquireTerminalInput(input, () => undefined);
    expect(first.isCurrentOwner()).toBe(false);
    expect(second.isCurrentOwner()).toBe(true);
    reassertTerminalInputLease(input);
    second();
    expect(first.isCurrentOwner()).toBe(true);
    first();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.setRawMode).not.toHaveBeenCalled();
    expect(input.pause).not.toHaveBeenCalled();
    expect(input.resume).not.toHaveBeenCalled();
  });

  it("does not consume non-TTY input or change another listener", () => {
    const input = makeInput({ tty: false });
    const other = vi.fn();
    input.on("data", other);
    const interrupt = vi.fn();
    acquireTerminalInput(input, interrupt)();
    input.emit("data", "\u001a");
    expect(other).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
    expect(input.setRawMode).not.toHaveBeenCalled();
    expect(input.resume).not.toHaveBeenCalled();
    expect(input.pause).not.toHaveBeenCalled();
    expect(() => acquireTerminalInput(null, interrupt)()).not.toThrow();
  });

  it("ignores ordinary data and preserves pre-existing data listeners", () => {
    const input = makeInput({ flowing: true });
    const other = vi.fn();
    input.on("data", other);
    const interrupt = vi.fn();
    const release = acquireTerminalInput(input, interrupt);
    input.emit("data", "ordinary input");
    release();
    expect(interrupt).not.toHaveBeenCalled();
    expect(input.listeners("data")).toEqual([other]);
    expect(input.readableFlowing).toBe(true);
  });

  it("restores a partial acquisition failure and permits a later lease", () => {
    const input = makeInput();
    input.resume.mockImplementationOnce(() => {
      throw new Error("resume failed");
    });
    expect(() => acquireTerminalInput(input, () => undefined)).toThrow(
      "resume failed",
    );
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    acquireTerminalInput(input, () => undefined)();
    expect(input.isRaw).toBe(false);
  });

  it("reasserts a prompt-restored mode only while the input is still owned", () => {
    const input = makeInput();
    reassertTerminalInputLease(input);
    expect(input.setRawMode).not.toHaveBeenCalled();
    const release = acquireTerminalInput(input, () => undefined);
    expect(hasTerminalInputLease(input)).toBe(true);
    input.isRaw = false;
    input.readableFlowing = false;
    reassertTerminalInputLease(input);
    expect(input.isRaw).toBe(true);
    expect(input.readableFlowing).toBe(true);
    release();
    expect(hasTerminalInputLease(input)).toBe(false);
    reassertTerminalInputLease(input);
    expect(input.isRaw).toBe(false);
    expect(input.readableFlowing).toBe(false);
  });

  it("still restores non-consuming flow when raw restoration fails", () => {
    const input = makeInput();
    const release = acquireTerminalInput(input, () => undefined);
    input.setRawMode.mockImplementationOnce(() => {
      throw new Error("restore failed");
    });
    expect(release).toThrow("restore failed");
    expect(input.readableFlowing).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });
});
