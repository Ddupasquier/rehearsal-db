/** Explicit application-owned activity; never infer use from container or editor age. */
export interface ApplicationActivity {
  readonly url: string;
}
export interface ApplicationActivitySample {
  readonly schemaVersion: 1;
  readonly busy: boolean;
  readonly activitySequence: number;
}
export interface ApplicationIdleWindow {
  readonly sequence: number | null;
  readonly quietSince: number | null;
  readonly lastObservedAt: number | null;
  readonly validSamples: number;
}
export const emptyApplicationIdleWindow = (): ApplicationIdleWindow => ({
  sequence: null,
  quietSince: null,
  lastObservedAt: null,
  validSamples: 0,
});

export const validateApplicationActivityUrl = (
  value: unknown,
  readinessUrl: string | null,
): string => {
  const message =
    "Application activity requires a bounded credential-free loopback HTTP(S) URL on the exact readiness origin, with an explicit non-privileged port and no query or fragment.";
  if (
    typeof value !== "string" ||
    value.length > 500 ||
    /[\x00-\x20\x7f]/u.test(value)
  )
    throw new Error(message);
  let url: URL;
  let readiness: URL;
  try {
    url = new URL(value);
    readiness = new URL(readinessUrl ?? "");
  } catch {
    throw new Error(message);
  }
  if (
    !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+(?:\/|$)/iu.test(
      value,
    ) ||
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    Number(url.port) < 1024 ||
    Number(url.port) > 65535 ||
    readiness.username ||
    readiness.password ||
    url.origin !== readiness.origin
  )
    throw new Error(message);
  return url.href;
};

export const parseApplicationActivitySample = (
  value: unknown,
): ApplicationActivitySample | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sample = value as Record<string, unknown>;
  if (
    Object.keys(sample).length !== 3 ||
    Object.keys(sample).some(
      (key) => !["schemaVersion", "busy", "activitySequence"].includes(key),
    ) ||
    sample.schemaVersion !== 1 ||
    typeof sample.busy !== "boolean" ||
    typeof sample.activitySequence !== "number" ||
    !Number.isSafeInteger(sample.activitySequence) ||
    sample.activitySequence < 0
  )
    return null;
  return {
    schemaVersion: 1,
    busy: sample.busy,
    activitySequence: sample.activitySequence,
  };
};

/** `now` is a monotonic clock; missing evidence cannot carry a previous quiet window. */
export const observeApplicationActivity = ({
  previous,
  sample,
  now,
  timeoutMs,
}: {
  readonly previous: ApplicationIdleWindow;
  readonly sample: ApplicationActivitySample | null;
  readonly now: number;
  readonly timeoutMs: number;
}): { readonly window: ApplicationIdleWindow; readonly idle: boolean } => {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    (previous.lastObservedAt !== null && now < previous.lastObservedAt) ||
    !sample ||
    (previous.sequence !== null && sample.activitySequence < previous.sequence)
  )
    return {
      window: { ...previous, quietSince: null, validSamples: 0 },
      idle: false,
    };
  const changed =
    previous.sequence === null || sample.activitySequence > previous.sequence;
  const reset = changed || sample.busy || previous.quietSince === null;
  const quietSince = sample.busy ? null : reset ? now : previous.quietSince;
  const validSamples = sample.busy
    ? 0
    : reset
      ? 1
      : Math.min(previous.validSamples + 1, 2);
  return {
    window: {
      sequence: sample.activitySequence,
      quietSince,
      validSamples,
      lastObservedAt: now,
    },
    idle:
      quietSince !== null && validSamples >= 2 && now - quietSince >= timeoutMs,
  };
};
