/** Spawn, bound, interrupt, and reap one process group owned by Rehearsal. */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { OperationCancellationSignal } from "./cancellation.mjs";

export interface OwnedProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutByteCount: number;
  readonly stderrByteCount: number;
  readonly error?: NodeJS.ErrnoException;
}

export const signalOwnedProcessGroup = (
  child: ChildProcess,
  signal: NodeJS.Signals,
): void => {
  try {
    if (process.platform === "win32") child.kill(signal);
    else {
      if (child.pid === undefined) return;
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      throw error;
    }
  }
};

export const bindOwnedProcessCancellation = ({
  child,
  signal,
  cancellationGraceMs = 60_000,
}: {
  child: ChildProcess;
  signal?: AbortSignal;
  cancellationGraceMs?: number;
}): (() => void) => {
  if (!signal) return () => undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    const requested = (signal.reason as { context?: { signal?: string } })
      ?.context?.signal as OperationCancellationSignal | undefined;
    const forwarded: NodeJS.Signals =
      requested === "SIGTSTP" ? "SIGTERM" : (requested ?? "SIGTERM");
    signalOwnedProcessGroup(child, forwarded);
    forceTimer = setTimeout(() => {
      signalOwnedProcessGroup(child, "SIGKILL");
    }, cancellationGraceMs);
    forceTimer.unref();
  };
  const cleanup = () => {
    if (forceTimer) clearTimeout(forceTimer);
    signal.removeEventListener("abort", interrupt);
  };
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  return cleanup;
};

export const runOwnedProcess = ({
  command,
  args,
  cwd,
  env,
  signal,
  stdin = "inherit",
  input,
  maxOutputBytes = 16 * 1024 * 1024,
  cancellationGraceMs = 60_000,
  spawnImplementation = spawn,
}: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdin?: "inherit" | "ignore";
  input?: string | Uint8Array;
  maxOutputBytes?: number;
  cancellationGraceMs?: number;
  spawnImplementation?: typeof spawn;
}): Promise<OwnedProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawnImplementation(command, [...args], {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: [input === undefined ? stdin : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutByteCount = 0;
    let stderrByteCount = 0;
    let processError: NodeJS.ErrnoException | undefined;
    let settled = false;
    let outputLimitExceeded = false;

    const append = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
      const bytes = Buffer.byteLength(chunk);
      if (kind === "stdout") {
        stdoutByteCount += bytes;
        if (stdoutByteCount <= maxOutputBytes) stdout += chunk.toString();
      } else {
        stderrByteCount += bytes;
        if (stderrByteCount <= maxOutputBytes) stderr += chunk.toString();
      }
      if (
        stdoutByteCount > maxOutputBytes ||
        stderrByteCount > maxOutputBytes
      ) {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          signalOwnedProcessGroup(child, "SIGTERM");
        }
      }
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => {
      processError = error;
    });

    const unbindCancellation = bindOwnedProcessCancellation({
      child,
      cancellationGraceMs,
      ...(signal ? { signal } : {}),
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }

    child.once("close", (status, childSignal) => {
      unbindCancellation();
      if (settled) return;
      settled = true;
      if (outputLimitExceeded) {
        reject(new Error("Owned process output exceeded the safe byte limit."));
        return;
      }
      resolve({
        status,
        signal: childSignal,
        stdout,
        stderr,
        stdoutByteCount,
        stderrByteCount,
        ...(processError ? { error: processError } : {}),
      });
    });
  });
