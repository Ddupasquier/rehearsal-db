/** Bounded teardown of one POSIX group created by this application session. */
import { performance } from "node:perf_hooks";

export type OwnedProcessGroupState = "present" | "absent" | "unknown";
type Signal = 0 | "SIGTERM" | "SIGKILL";
type SignalGroup = (pid: number, signal: Signal) => unknown;
const errorCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

export const probeOwnedProcessGroup = (
  pid: number,
  signalGroup: SignalGroup = process.kill,
): OwnedProcessGroupState => {
  try {
    signalGroup(-pid, 0);
    return "present";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "absent";
    // Darwin can transiently return EPERM during group retirement. It proves
    // neither absence nor permission to send another signal.
    if (errorCode(error) === "EPERM") return "unknown";
    throw error;
  }
};

export const stopOwnedPosixProcessGroup = async ({
  pid,
  signalGroup = process.kill,
  now = () => performance.now(),
  wait = (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  gracefulTimeoutMs = 5000,
  forceTimeoutMs = 1000,
}: {
  readonly pid: number;
  readonly signalGroup?: SignalGroup;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly gracefulTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
}): Promise<void> => {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error(
      "Owned application process group identity is unavailable; no process was signaled.",
    );
  const send = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      signalGroup(-pid, signal);
    } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error;
    }
  };
  const observeUntil = async (
    deadline: number,
  ): Promise<OwnedProcessGroupState> => {
    let state = probeOwnedProcessGroup(pid, signalGroup);
    while (state !== "absent" && now() < deadline) {
      await wait(Math.min(25, Math.max(1, deadline - now())));
      state = probeOwnedProcessGroup(pid, signalGroup);
    }
    return state;
  };
  const refuseUnknown = (): never => {
    throw new Error(
      "Owned application process group state could not be verified within its shutdown bound. Resources may remain; no further signal was sent while permission was unknown.",
    );
  };
  send("SIGTERM");
  const gracefulState = await observeUntil(now() + gracefulTimeoutMs);
  if (gracefulState === "absent") return;
  if (gracefulState === "unknown") refuseUnknown();
  send("SIGKILL");
  const forcedState = await observeUntil(now() + forceTimeoutMs);
  if (forcedState === "absent") return;
  if (forcedState === "unknown") refuseUnknown();
  throw new Error(
    "Owned application process group did not stop within its shutdown bound. No unrelated process was targeted.",
  );
};
