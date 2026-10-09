/** Run identity discovery while an owned local application remains available. */

import type { EventEmitter } from "node:events";
import {
  summarizeProjectCommandFailure,
  type ApplicationDiagnostics,
  type ApplicationSession,
  type ApplicationSessionSignal,
} from "./session.mjs";

const SESSION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"] as const;
type SessionSignal = (typeof SESSION_SIGNALS)[number];
type SignalTarget = Pick<EventEmitter, "prependListener" | "removeListener">;

interface SessionInput {
  readonly isTTY?: boolean;
  prependListener(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
  removeListener(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
}

/**
 * A terminal interruption aborts the task and retires the owned process group.
 * A completed task leaves the session running so its caller can deliberately
 * stop, reuse, or hand it back to the persistent application holder.
 */
export const runApplicationSessionTask = async <Value,>({
  session,
  task,
  signalTarget = process,
  input = process.stdin,
  onReady = () => undefined,
}: {
  session: ApplicationSession;
  task: (signal: AbortSignal) => Promise<Value>;
  signalTarget?: SignalTarget;
  input?: SessionInput;
  onReady?: (ready: ApplicationSession["ready"]) => void;
}): Promise<
  | Readonly<{
      completed: true;
      value: Value;
      diagnostics: ApplicationDiagnostics;
    }>
  | Readonly<{
      completed: false;
      signal: ApplicationSessionSignal;
      diagnostics: ApplicationDiagnostics;
    }>
> => {
  if (
    !session ||
    typeof session.wait !== "function" ||
    typeof session.stop !== "function"
  ) {
    throw new Error("A started application session is required.");
  }
  type Interruption = { kind: "interrupted"; signal: SessionSignal };
  type ChildExit = Awaited<ReturnType<ApplicationSession["wait"]>>;
  let finishInterruption: (result: Interruption) => void = () => undefined;
  const interruption = new Promise<Interruption>((resolve) => {
    finishInterruption = resolve;
  });
  const handlers = new Map(
    SESSION_SIGNALS.map((signal) => [
      signal,
      () => finishInterruption({ kind: "interrupted", signal }),
    ]),
  );
  for (const [signal, handler] of handlers) {
    signalTarget.prependListener(signal, handler);
  }
  const onInput = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.includes(0x03)) {
      finishInterruption({ kind: "interrupted", signal: "SIGINT" });
    } else if (bytes.includes(0x1a)) {
      finishInterruption({ kind: "interrupted", signal: "SIGTSTP" });
    }
  };
  if (input?.isTTY) input.prependListener("data", onInput);
  const abortController = new AbortController();
  try {
    onReady(session.ready);
    const outcome:
      | Interruption
      | Readonly<{ kind: "completed"; value: Value }>
      | (Readonly<{ kind: "exited" }> & ChildExit) = await Promise.race([
      interruption,
      task(abortController.signal).then((value) => ({
        kind: "completed" as const,
        value,
      })),
      session.wait().then((exit) => ({ kind: "exited" as const, ...exit })),
    ]);
    if (outcome.kind === "exited") {
      throw new Error(
        `Application exited before identity connection finished (${summarizeProjectCommandFailure(
          {
            status: outcome.status,
            signal: outcome.signal,
            stdoutByteCount: session.diagnostics().stdoutBytes,
            stderrByteCount: session.diagnostics().stderrBytes,
          },
        )}).`,
      );
    }
    if (outcome.kind === "interrupted") {
      abortController.abort(
        new Error(`Identity connection was interrupted by ${outcome.signal}.`),
      );
      await session.stop();
      return Object.freeze({
        completed: false,
        signal: outcome.signal,
        diagnostics: session.diagnostics(),
      });
    }
    return Object.freeze({
      completed: true,
      value: outcome.value,
      diagnostics: session.diagnostics(),
    });
  } catch (error) {
    abortController.abort(error);
    await session.stop();
    throw error;
  } finally {
    for (const [signal, handler] of handlers) {
      signalTarget.removeListener(signal, handler);
    }
    if (input?.isTTY) input.removeListener("data", onInput);
  }
};
