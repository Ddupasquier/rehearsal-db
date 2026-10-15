/** Foreground-only serial polling of an explicitly declared application activity route. */
import { performance } from "node:perf_hooks";
import {
  emptyApplicationIdleWindow,
  observeApplicationActivity,
  parseApplicationActivitySample,
  validateApplicationActivityUrl,
  type ApplicationActivitySample,
} from "./activity_contract.mjs";

const MAXIMUM_ACTIVITY_BYTES = 4096;
const aborted = (): Error =>
  Object.assign(new Error("Application activity monitoring stopped."), {
    name: "AbortError",
  });
class ActivityTransportUnresponsive extends Error {
  constructor() {
    super(
      "Application activity transport did not stop within its bound; idle shutdown is disabled for this foreground session.",
    );
  }
}
const settleWithin = async (
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const wait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    const finish = (cancelled: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (cancelled) reject(aborted());
      else resolve();
    };
    const onAbort = (): void => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const readApplicationActivity = async ({
  url,
  signal,
  fetchImplementation = fetch,
  timeoutMs = 2000,
}: {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<ApplicationActivitySample | null> => {
  if (signal.aborted) throw aborted();
  const started = performance.now();
  const budget = Math.min(Math.max(timeoutMs, 1), 2000);
  const request = new AbortController();
  let rejectOwner: (error: Error) => void = () => undefined;
  const ownerAborted = new Promise<never>((_resolve, reject) => {
    rejectOwner = reject;
  });
  const onAbort = (): void => {
    request.abort();
    rejectOwner(aborted());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const abortTimer = setTimeout(
    () => request.abort(),
    Math.max(1, budget - 50),
  );
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      request.abort();
      reject(new ActivityTransportUnresponsive());
    }, budget);
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const read = async (): Promise<ApplicationActivitySample | null> => {
    try {
      const response = await fetchImplementation(url, {
        signal: request.signal,
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json", "cache-control": "no-store" },
      });
      if (request.signal.aborted) return null;
      if (
        response.status !== 200 ||
        response.redirected ||
        !/^application\/json(?:\s*;|$)/iu.test(
          response.headers.get("content-type") ?? "",
        ) ||
        !response.body
      )
        return null;
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^[0-9]+$/u.test(declared) ||
          Number(declared) > MAXIMUM_ACTIVITY_BYTES)
      )
        return null;
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        if (request.signal.aborted) return null;
        const result = await reader.read();
        if (request.signal.aborted) return null;
        if (result.done) break;
        length += result.value.byteLength;
        if (length > MAXIMUM_ACTIVITY_BYTES) return null;
        chunks.push(result.value);
      }
      const bytes = Buffer.concat(chunks, length);
      return parseApplicationActivitySample(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch {
      return null;
    }
  };
  try {
    return await Promise.race([read(), deadline, ownerAborted]);
  } finally {
    clearTimeout(abortTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", onAbort);
    request.abort();
    const cancelled = reader?.cancel().catch(() => undefined);
    const cancellationFinished =
      cancelled === undefined ||
      (await settleWithin(
        cancelled,
        Math.max(1, Math.min(50, budget - (performance.now() - started))),
      ));
    try {
      reader?.releaseLock();
    } catch {
      /* A stuck transport is disabled below. */
    }
    if (signal.aborted) throw aborted();
    if (!cancellationFinished) throw new ActivityTransportUnresponsive();
  }
};

export const waitForApplicationIdle = async ({
  url,
  readinessUrl,
  timeoutSeconds,
  signal,
  fetchImplementation = fetch,
  now = () => performance.now(),
  pollIntervalMs = 5000,
  requestTimeoutMs = 2000,
  onAvailability = () => undefined,
}: {
  readonly url: string;
  readonly readinessUrl: string;
  readonly timeoutSeconds: number;
  readonly signal: AbortSignal;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly onAvailability?: (available: boolean) => void;
}): Promise<Readonly<{ reason: "idle-timeout" }>> => {
  const endpoint = validateApplicationActivityUrl(url, readinessUrl);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
    throw new Error(
      "Application idle monitoring requires an explicit positive timeout.",
    );
  let window = emptyApplicationIdleWindow();
  let available: boolean | undefined;
  while (!signal.aborted) {
    let sample: ApplicationActivitySample | null;
    try {
      sample = await readApplicationActivity({
        url: endpoint,
        signal,
        fetchImplementation,
        timeoutMs: requestTimeoutMs,
      });
    } catch (error) {
      if (signal.aborted) throw aborted();
      if (!(error instanceof ActivityTransportUnresponsive)) throw error;
      onAvailability(false);
      // Do not accumulate new requests behind a transport that ignored abort/cancel.
      await new Promise<never>((_resolve, reject) => {
        const stop = (): void => reject(aborted());
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) {
          signal.removeEventListener("abort", stop);
          stop();
        }
      });
      throw aborted();
    }
    if (signal.aborted) throw aborted();
    const current = observeApplicationActivity({
      previous: window,
      sample,
      now: now(),
      timeoutMs: timeoutSeconds * 1000,
    });
    window = current.window;
    const nextAvailable =
      sample !== null &&
      (window.sequence === null ||
        sample.activitySequence >= window.sequence) &&
      window.lastObservedAt !== null;
    if (available !== nextAvailable) {
      available = nextAvailable;
      onAvailability(available);
    }
    if (current.idle) return { reason: "idle-timeout" };
    await wait(Math.max(1, pollIntervalMs), signal);
  }
  throw aborted();
};
