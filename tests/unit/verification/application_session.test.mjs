import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnTerminal } = vi.hoisted(() => ({ spawnTerminal: vi.fn() }));
vi.mock("@lydell/node-pty", () => ({ spawn: spawnTerminal }));

import {
  cancelIdentityTerminalSession,
  connectIdentityTerminalSession,
  openApplicationTerminalSession,
} from "../../../scripts/verification/scenarios/application_session.mjs";

const cwd = "/synthetic/installed consumer";
const url = "http://127.0.0.1:54321";
const ready = `SANDBOX READY\r\nApplication: ${url}\r\n`;
const shutdown =
  "Application stopped after SIGINT.\r\nThe database and Storage changes were preserved.\r\n";

const mockTerminal = ({ initial = ready, write, earlyExit } = {}) => {
  let data;
  let exit;
  let exited = false;
  const emitExit = (exitCode = 0) => {
    if (exited) return;
    exited = true;
    exit({ exitCode, signal: 0 });
  };
  const emit = (text) => data(text);
  const terminal = {
    onData: vi.fn((listener) => {
      data = listener;
    }),
    onExit: vi.fn((listener) => {
      exit = listener;
      emit(initial);
      if (earlyExit !== undefined) emitExit(earlyExit);
    }),
    write: vi.fn((value) => {
      if (write) write(value, { emit, emitExit });
      else {
        emit(shutdown);
        emitExit();
      }
    }),
    kill: vi.fn(() => emitExit(1)),
  };
  spawnTerminal.mockReturnValue(terminal);
  return terminal;
};

beforeEach(() => {
  vi.useFakeTimers();
  spawnTerminal.mockReset();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValue(new Error("Synthetic application closed")),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("exact installed CLI PTY application lifecycle", () => {
  it("launches the local CLI without npm and requires Ctrl+C receipts and HTTP closure", async () => {
    const terminal = mockTerminal();
    await expect(openApplicationTerminalSession({ cwd, url })).resolves.toBe(
      ready + shutdown,
    );
    expect(spawnTerminal).toHaveBeenCalledWith(
      join(cwd, "node_modules/.bin/rehearsal"),
      ["open", "--plain"],
      expect.objectContaining({
        cwd,
        name: "xterm-256color",
        cols: 100,
        rows: 40,
      }),
    );
    expect(terminal.write).toHaveBeenCalledExactlyOnceWith("\u0003");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(terminal.kill).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP success alone", "starting\r\n", 200],
    ["ready text alone", ready, 503],
  ])(
    "keeps the 30-second readiness deadline for %s",
    async (_, initial, status) => {
      const terminal = mockTerminal({ initial });
      fetch.mockReset().mockResolvedValue({ status });
      const pending = openApplicationTerminalSession({ cwd, url });
      const assertion = expect(pending).rejects.toThrow(
        "Persistent application did not become ready",
      );
      await vi.advanceTimersByTimeAsync(29_900);
      expect(terminal.kill).not.toHaveBeenCalled();
      expect(terminal.write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(terminal.kill).toHaveBeenCalledOnce();
    },
  );

  it("refuses immediately when the CLI exits before readiness", async () => {
    const terminal = mockTerminal({ initial: "failed\r\n", earlyExit: 6 });
    await expect(openApplicationTerminalSession({ cwd, url })).rejects.toThrow(
      "Persistent application did not become ready: failed",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.kill).toHaveBeenCalledOnce();
  });

  it("keeps the 10-second Ctrl+C exit deadline", async () => {
    mockTerminal({ write: () => {} });
    const assertion = expect(
      openApplicationTerminalSession({ cwd, url }),
    ).rejects.toThrow("Terminal Ctrl+C timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it.each([
    ["nonzero exit", ready, shutdown, 1, "Terminal Ctrl+C exited 1"],
    ["missing URL receipt", "SANDBOX READY\r\n", shutdown, 0, "URL receipt"],
    ["missing shutdown receipt", ready, "closed\r\n", 0, "shutdown receipt"],
  ])("refuses %s", async (_, initial, receipt, code, message) => {
    mockTerminal({
      initial,
      write: (_, { emit, emitExit }) => {
        emit(receipt);
        emitExit(code);
      },
    });
    await expect(openApplicationTerminalSession({ cwd, url })).rejects.toThrow(
      message,
    );
  });

  it("refuses a still-reachable application after a successful exit", async () => {
    mockTerminal();
    fetch.mockResolvedValue({ status: 200 });
    await expect(openApplicationTerminalSession({ cwd, url })).rejects.toThrow(
      "Persistent application child remained reachable after exit",
    );
  });
});

describe("exact installed CLI PTY identity transport", () => {
  const identityArgs = [
    "identity",
    "connect",
    "--identity=approved-owner",
    "--plain",
  ];

  it("preserves the reviewed confirmation and Ctrl+C sequence", async () => {
    const terminal = mockTerminal({
      initial: "Connect my copied account using exactly this plan? (y/N)",
      write: (value, { emit, emitExit }) => {
        if (value === "y\r") emit("COPIED ACCOUNT — CONNECTED");
        else emitExit();
      },
    });
    const pending = connectIdentityTerminalSession({ cwd, url });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(spawnTerminal).toHaveBeenCalledWith(
      join(cwd, "node_modules/.bin/rehearsal"),
      identityArgs,
      expect.objectContaining({ cwd, cols: 110, rows: 40 }),
    );
    expect(terminal.write.mock.calls).toEqual([["y\r"], ["\u0003"]]);
  });

  it.each([
    ["c", "\u0003"],
    ["z", "\u001a"],
  ])(
    "preserves Ctrl+%s cancellation and its unchanged-data receipt",
    async (control, key) => {
      const terminal = mockTerminal({
        initial: "SIGN IN TO THE SANDBOX",
        write: (_, { emit, emitExit }) => {
          emit("COPIED ACCOUNT CONNECTION CANCELLED\r\nNothing was changed");
          emitExit();
        },
      });
      await cancelIdentityTerminalSession({ cwd, url, control });
      expect(spawnTerminal).toHaveBeenCalledWith(
        join(cwd, "node_modules/.bin/rehearsal"),
        identityArgs,
        expect.objectContaining({ cwd, cols: 110, rows: 40 }),
      );
      expect(terminal.write).toHaveBeenCalledExactlyOnceWith(key);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});
