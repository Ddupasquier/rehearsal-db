/** Bound one graceful Colima CLI invocation, including exit-before-pipe-close. Never controls a VM PID. */
import { spawn, type ChildProcess } from "node:child_process";
import type { OwnedProcessResult } from "../shared/owned_process.mjs";

export const OWNED_COLIMA_SHUTDOWN_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 1000;
const OUTPUT_LIMIT = 65536;
export interface OwnedColimaStopResult extends OwnedProcessResult {
  readonly exitObserved: boolean;
  readonly closeObserved: boolean;
  readonly retired: boolean;
}
const fixedError = (code: string): NodeJS.ErrnoException =>
  Object.assign(
    new Error(
      "Owned Colima command did not complete with confirmed closed handles.",
    ),
    { code },
  );
export function runOwnedColimaStop(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    spawnImplementation?: typeof spawn;
    signalImplementation?: (
      child: ChildProcess,
      signal: NodeJS.Signals,
    ) => void;
  } = {},
): Promise<OwnedColimaStopResult> {
  const timeoutMs = options.timeoutMs ?? OWNED_COLIMA_SHUTDOWN_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > OWNED_COLIMA_SHUTDOWN_TIMEOUT_MS
  )
    throw new Error("Invalid owned Colima shutdown deadline.");
  const empty = {
    status: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutByteCount: 0,
    stderrByteCount: 0,
    exitObserved: false,
    closeObserved: false,
    retired: false,
  } as const;
  if (options.signal?.aborted)
    return Promise.resolve({ ...empty, error: fixedError("ABORT_ERR") });
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (options.spawnImplementation ?? spawn)("colima", ["stop"], {
        cwd,
        env: environment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        ...empty,
        error: error instanceof Error ? error : fixedError("UNCLASSIFIED"),
      });
      return;
    }
    let status: number | null = null,
      signal: NodeJS.Signals | null = null;
    let exitObserved = false,
      closeObserved = false,
      settled = false,
      stopping = false;
    let error: NodeJS.ErrnoException | undefined;
    let stdout = "",
      stderr = "",
      stdoutByteCount = 0,
      stderrByteCount = 0;
    let deadline: NodeJS.Timeout | undefined,
      grace: NodeJS.Timeout | undefined,
      retirement: NodeJS.Timeout | undefined;
    const clearTimers = () => {
      clearTimeout(deadline);
      clearTimeout(grace);
      clearTimeout(retirement);
    };
    const signalChild = (requested: NodeJS.Signals) => {
      if (exitObserved || closeObserved || settled || child.pid === undefined)
        return;
      try {
        if (options.signalImplementation)
          options.signalImplementation(child, requested);
        else if (process.platform === "win32") child.kill(requested);
        else process.kill(-child.pid, requested);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ESRCH")
          error ??= fixedError("ESIGNAL_UNCONFIRMED");
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      options.signal?.removeEventListener("abort", abort);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      if (!closeObserved) {
        error ??= fixedError("ECLOSE_UNCONFIRMED");
        // Retire our local pipes/handle only. An escaped holder is not a new kill target.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        child.on("error", () => {});
      }
      resolve({
        status,
        signal,
        stdout,
        stderr,
        stdoutByteCount,
        stderrByteCount,
        exitObserved,
        closeObserved,
        retired: !closeObserved,
        ...(error ? { error } : {}),
      });
    };
    const awaitClose = () => {
      clearTimeout(retirement);
      retirement = setTimeout(finish, CLOSE_GRACE_MS);
    };
    const interrupt = (code: string, requested: NodeJS.Signals = "SIGTERM") => {
      error ??= fixedError(code);
      if (stopping) return;
      stopping = true;
      clearTimeout(deadline);
      if (exitObserved || child.pid === undefined) {
        awaitClose();
        return;
      }
      signalChild(requested);
      if (exitObserved) {
        awaitClose();
        return;
      }
      grace = setTimeout(() => {
        signalChild("SIGKILL");
        awaitClose();
      }, CLOSE_GRACE_MS);
    };
    const abort = () => {
      const requested = (
        options.signal?.reason as { context?: { signal?: unknown } } | undefined
      )?.context?.signal;
      interrupt(
        "ABORT_ERR",
        requested === "SIGINT" || requested === "SIGHUP"
          ? requested
          : "SIGTERM",
      );
    };
    const append = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.byteLength(chunk);
      if (kind === "stdout") {
        stdoutByteCount += bytes;
        if (stdoutByteCount <= OUTPUT_LIMIT) stdout += chunk.toString();
      } else {
        stderrByteCount += bytes;
        if (stderrByteCount <= OUTPUT_LIMIT) stderr += chunk.toString();
      }
      if (stdoutByteCount > OUTPUT_LIMIT || stderrByteCount > OUTPUT_LIMIT)
        interrupt("ENOBUFS");
    };
    const onStdout = (chunk: Buffer | string) => append("stdout", chunk);
    const onStderr = (chunk: Buffer | string) => append("stderr", chunk);
    const onExit = (
      code: number | null,
      actualSignal: NodeJS.Signals | null,
    ) => {
      exitObserved = true;
      status = code;
      signal = actualSignal;
      clearTimers();
      awaitClose(); // No later deadline/grace handler may signal this exited leader/group.
    };
    const onClose = (
      code: number | null,
      actualSignal: NodeJS.Signals | null,
    ) => {
      closeObserved = true;
      status = code;
      signal = actualSignal;
      finish();
    };
    const onError = (failure: NodeJS.ErrnoException) => {
      error ??= failure;
      interrupt(failure.code ?? "UNCLASSIFIED");
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
    options.signal?.addEventListener("abort", abort, { once: true });
    deadline = setTimeout(() => interrupt("ETIMEDOUT"), timeoutMs);
    if (options.signal?.aborted) abort();
  });
}
