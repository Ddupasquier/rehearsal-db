/** Spawn, bound, interrupt, and reap one process group owned by Rehearsal. */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
  onSignalError,
}: {
  child: ChildProcess;
  signal?: AbortSignal;
  cancellationGraceMs?: number;
  onSignalError: (error: unknown) => void;
}): (() => void) => {
  if (!signal) return () => undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let interrupted = false;
  let exited = child.exitCode !== null && child.exitCode !== undefined;
  const onExit = () => {
    exited = true;
    if (forceTimer) clearTimeout(forceTimer);
  };
  child.once("exit", onExit);
  const send = (requested: NodeJS.Signals) => {
    try {
      signalOwnedProcessGroup(child, requested);
    } catch (error) {
      onSignalError(error);
    }
  };
  const interrupt = () => {
    if (interrupted || exited) return;
    interrupted = true;
    const requested = (signal.reason as { context?: { signal?: string } })
      ?.context?.signal as OperationCancellationSignal | undefined;
    const forwarded: NodeJS.Signals =
      requested === "SIGTSTP" ? "SIGTERM" : (requested ?? "SIGTERM");
    send(forwarded);
    forceTimer = setTimeout(() => {
      if (!exited) send("SIGKILL");
    }, cancellationGraceMs);
    forceTimer.unref();
  };
  const cleanup = () => {
    if (forceTimer) clearTimeout(forceTimer);
    signal.removeEventListener("abort", interrupt);
    child.removeListener("exit", onExit);
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
  closeTimeoutMilliseconds = 1_000,
  spawnImplementation = spawn,
}: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdin?: "inherit" | "ignore";
  input?: string | Uint8Array | AsyncIterable<string | Uint8Array>;
  maxOutputBytes?: number;
  cancellationGraceMs?: number;
  /** Retire local pipe handles after cancellation; this never proves backend cleanup. */
  closeTimeoutMilliseconds?: number;
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
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutByteCount = 0;
    let stderrByteCount = 0;
    let processError: NodeJS.ErrnoException | undefined;
    let settled = false;
    let childExited = false;
    const exited = () => {
      childExited = true;
      if (outputLimitForceTimer) clearTimeout(outputLimitForceTimer);
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      boundClose(0);
    };
    child.once("exit", exited);
    let inputFinished =
      input === undefined ||
      typeof input === "string" ||
      input instanceof Uint8Array;
    let outputLimitExceeded = false;
    let outputLimitForceTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    const boundClose = (graceMilliseconds = cancellationGraceMs) => {
      if (closeTimeoutMilliseconds === undefined || closeTimer || settled)
        return;
      closeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unbindCancellation();
        signal?.removeEventListener("abort", onAbort);
        child.removeListener("exit", exited);
        if (outputLimitForceTimer) clearTimeout(outputLimitForceTimer);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        reject(
          new AggregateError(
            processError ? [processError] : [],
            "Owned process closure is unconfirmed; recovery must be preserved.",
          ),
        );
      }, graceMilliseconds + closeTimeoutMilliseconds);
      closeTimer.unref();
    };

    const signalChild = (requested: NodeJS.Signals) => {
      if (settled || childExited) return;
      try {
        signalOwnedProcessGroup(child, requested);
      } catch (cause) {
        processError = new AggregateError(
          processError ? [processError, cause] : [cause],
          "Owned process signalling is unconfirmed; recovery must be preserved.",
        );
        boundClose(0);
      }
    };
    const append = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.byteLength(chunk);
      if (kind === "stdout") {
        stdoutByteCount += bytes;
        if (stdoutByteCount <= maxOutputBytes)
          stdout += stdoutDecoder.write(
            typeof chunk === "string" ? Buffer.from(chunk) : chunk,
          );
      } else {
        stderrByteCount += bytes;
        if (stderrByteCount <= maxOutputBytes)
          stderr += stderrDecoder.write(
            typeof chunk === "string" ? Buffer.from(chunk) : chunk,
          );
      }
      if (
        stdoutByteCount > maxOutputBytes ||
        stderrByteCount > maxOutputBytes
      ) {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          signalChild("SIGTERM");
          // An output flood is not an interactive cancellation request. Bound its
          // shutdown even when the child (or a pipe-owning descendant) ignores TERM.
          outputLimitForceTimer = setTimeout(() => {
            signalChild("SIGKILL");
          }, 1_000);
          outputLimitForceTimer.unref();
          boundClose(1_000);
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
      onSignalError: (cause) => {
        processError = new AggregateError(
          processError ? [processError, cause] : [cause],
          "Owned process signalling is unconfirmed; recovery must be preserved.",
        );
        boundClose(0);
      },
      ...(signal ? { signal } : {}),
    });
    const onAbort = () => boundClose();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) boundClose();
    if (input !== undefined) {
      child.stdin?.on("error", () => {
        processError ??= new Error(
          "Owned process input pipe failed; private input is withheld.",
        );
      });
      if (typeof input === "string" || input instanceof Uint8Array)
        child.stdin?.end(input);
      else
        void (async () => {
          const iterator = input[Symbol.asyncIterator]();
          let stopInput: () => void = () => undefined;
          const stopped = new Promise<never>((_done, fail) => {
            stopInput = () =>
              fail(new Error("Owned process input was interrupted."));
          });
          // A blocked producer cannot keep the pump attached after the owned child closes or cancellation.
          child.once("close", stopInput);
          signal?.addEventListener("abort", stopInput, { once: true });
          try {
            while (true) {
              const next = await Promise.race([iterator.next(), stopped]);
              if (next.done) break;
              const chunk = next.value;
              if (
                settled ||
                signal?.aborted ||
                child.stdin?.destroyed ||
                child.stdin?.writableEnded
              )
                throw new Error("Owned process input closed early.");
              if (!child.stdin?.write(chunk))
                await new Promise<void>((done, fail) => {
                  const cleanup = () => {
                    child.stdin?.removeListener("drain", drained);
                    child.removeListener("close", closed);
                    signal?.removeEventListener("abort", closed);
                  };
                  const drained = () => {
                    cleanup();
                    done();
                  };
                  const closed = () => {
                    cleanup();
                    fail(new Error("Owned process input closed early."));
                  };
                  child.stdin?.once("drain", drained);
                  child.once("close", closed);
                  signal?.addEventListener("abort", closed, { once: true });
                  if (signal?.aborted || settled) closed();
                });
            }
            inputFinished = true;
            child.stdin?.end();
          } finally {
            child.removeListener("close", stopInput);
            signal?.removeEventListener("abort", stopInput);
            // Do not await an arbitrary producer's return; its pending next may not cooperate.
            if (!inputFinished) void iterator.return?.().catch(() => undefined);
          }
        })().catch((cause: unknown) => {
          if (settled) return;
          processError ??= new Error(
            "Owned process input failed; private input is withheld.",
            { cause },
          );
          if (!signal?.aborted) signalChild("SIGTERM");
          if (!signal?.aborted)
            outputLimitForceTimer ??= setTimeout(() => {
              signalChild("SIGKILL");
            }, 1_000);
          outputLimitForceTimer?.unref();
          boundClose(1_000);
        });
    }

    child.once("close", (status, childSignal) => {
      unbindCancellation();
      child.removeListener("exit", exited);
      signal?.removeEventListener("abort", onAbort);
      if (closeTimer) clearTimeout(closeTimer);
      if (outputLimitForceTimer) clearTimeout(outputLimitForceTimer);
      if (settled) return;
      settled = true;
      if (outputLimitExceeded) {
        reject(new Error("Owned process output exceeded the safe byte limit."));
        return;
      }
      if (!inputFinished && !processError)
        processError = new Error(
          "Owned process input closed before completion; recovery must be preserved.",
        );
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
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
