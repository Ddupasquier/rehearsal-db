/** Private bounded diagnostics, never execution, provider-cause or cleanup authority. */
export const KNEX_WORKER_FAILURE_OBSERVATION_PREFIX =
  "Knex isolated worker failure observation: ";
export const KNEX_WORKER_REPORTED_CATEGORIES = [
  "unclassified",
  "connection-refused",
  "connection-closed",
  "connection-timeout",
  "authentication",
  "permission",
  "query-canceled",
  "lock",
  "duplicate-object",
  "missing-object",
  "pool",
  "constraint",
] as const;
type Check = "not-checked" | "confirmed" | "unconfirmed";
export const createKnexWorkerFailureObservation = () => ({
  schemaVersion: 1 as const,
  kind: "knex-worker-failure-observation" as const,
  scope: "diagnostic-only" as const,
  workerId: null as string | null,
  host: {
    result: null as 0 | 1 | null,
    attachment: {
      closed: false,
      exitCode: null as number | null,
      signal: null as "SIGINT" | "SIGTERM" | "SIGKILL" | "other" | null,
    },
    cancellation: {
      inputAborted: false,
      interrupted: false,
      executionDeadlineExceeded: null as boolean | null,
    },
    broker: {
      health: "not-checked" as "not-checked" | "healthy" | "refused",
      cleanup: "not-checked" as Check,
    },
    container: null as null | {
      running: boolean;
      status: "created" | "running" | "exited";
      exitCode: number | null;
      oomKilled: boolean | null;
    },
    cleanup: {
      attachment: "not-started" as "not-started" | "confirmed" | "unconfirmed",
      worker: "not-created" as "not-created" | "confirmed" | "unconfirmed",
    },
  },
  workerReported: {
    trust: "untrusted" as const,
    state: "absent" as "absent" | "reported" | "invalid",
    hint: null as "input" | "load" | "migrate" | "destroy" | null,
    category:
      "unclassified" as (typeof KNEX_WORKER_REPORTED_CATEGORIES)[number],
  },
});
export type KnexWorkerFailureObservation = ReturnType<
  typeof createKnexWorkerFailureObservation
>;
export const knexObservedExitCode = (value: unknown): number | null =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255
    ? Number(value)
    : null;
/** Call only after the existing full container ownership/isolation assertion. */
export const projectKnexWorkerContainerObservation = (state: any) => ({
  running: state.Running as boolean,
  status: state.Status as "created" | "running" | "exited",
  exitCode: knexObservedExitCode(state.ExitCode),
  oomKilled: typeof state.OOMKilled === "boolean" ? state.OOMKilled : null,
});
/** Copied into the trusted child; arbitrary error strings are never retained. */
export function classifyKnexWorkerReportedFailure(error: unknown): number {
  try {
    if (!error || typeof error !== "object") return 0;
    const value = error as { code?: unknown; name?: unknown };
    const code = value.code;
    const categories: Record<string, number> = {
      ECONNREFUSED: 1,
      ECONNRESET: 2,
      EPIPE: 2,
      "08003": 2,
      "08006": 2,
      "57P01": 2,
      "57P02": 2,
      ETIMEDOUT: 3,
      "28P01": 4,
      "28000": 4,
      "42501": 5,
      "57014": 6,
      "55P03": 7,
      "40P01": 7,
      "42P07": 8,
      "42710": 8,
      "42701": 8,
      "42P01": 9,
      "42703": 9,
      "42883": 9,
      "3F000": 9,
      "3D000": 9,
      "23502": 11,
      "23503": 11,
      "23505": 11,
      "23514": 11,
    };
    if (typeof code === "string" && Object.hasOwn(categories, code))
      return categories[code]!;
    return value.name === "KnexTimeoutError" ? 10 : 0;
  } catch {
    return 0;
  }
}
/** At most eight fixed pairs, including split chunks; first reported failure wins. */
export function createKnexWorkerHintCollector() {
  let count = 0,
    pending = 0,
    hint = 0,
    category = 0,
    invalid = false;
  return {
    accept(bytes: Buffer): boolean {
      if (!Buffer.isBuffer(bytes) || (count += bytes.length) > 16) {
        invalid = true;
        return false;
      }
      for (const byte of bytes) {
        if (!pending) {
          if (byte < 1 || byte > 4) invalid = true;
          pending = byte;
        } else {
          if (byte > 11) invalid = true;
          if (!hint && !invalid) {
            hint = pending;
            category = byte;
          }
          pending = 0;
        }
      }
      return !invalid;
    },
    result(): Buffer {
      return Buffer.from(invalid || pending ? [5, 0] : [hint, category]);
    },
  };
}
/** Exit can precede pipe EOF. Diagnostics get at most 25ms inside the existing deadline. */
export function drainKnexWorkerReportedHint(
  pipe: {
    readableEnded?: boolean;
    destroyed?: boolean;
    once: (event: string, listener: () => void) => unknown;
    removeListener: (event: string, listener: () => void) => unknown;
  },
  done: () => void,
) {
  if (pipe.readableEnded || pipe.destroyed) {
    done();
    return;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    pipe.removeListener("end", finish);
    pipe.removeListener("close", finish);
    done();
  };
  const timer = setTimeout(finish, 25);
  timer.unref();
  pipe.once("end", finish);
  pipe.once("close", finish);
}
export const projectKnexWorkerReportedHint = (
  bytes: Buffer,
): KnexWorkerFailureObservation["workerReported"] => {
  const absent = {
    trust: "untrusted" as const,
    state: "absent" as const,
    hint: null,
    category: "unclassified" as const,
  };
  if (bytes.length === 2 && bytes[0] === 0 && bytes[1] === 0) return absent;
  if (bytes.length !== 2 || bytes[0]! < 1 || bytes[0]! > 4 || bytes[1]! > 11)
    return { ...absent, state: "invalid" };
  return {
    trust: "untrusted",
    state: "reported",
    hint: (["input", "load", "migrate", "destroy"] as const)[bytes[0]! - 1]!,
    category: KNEX_WORKER_REPORTED_CATEGORIES[bytes[1]!]!,
  };
};
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: unknown, expected: string) =>
  object(value) && Object.keys(value).sort().join(",") === expected;
const one = (value: unknown, allowed: readonly unknown[]) =>
  allowed.includes(value);
/** Closed serialized boundary. No arbitrary strings/fields cross the CLI process. */
export const parseKnexWorkerFailureObservation = (
  value: unknown,
): KnexWorkerFailureObservation | null => {
  if (!keys(value, "host,kind,schemaVersion,scope,workerId,workerReported"))
    return null;
  const r = value as KnexWorkerFailureObservation;
  if (
    r.schemaVersion !== 1 ||
    r.kind !== "knex-worker-failure-observation" ||
    r.scope !== "diagnostic-only" ||
    !(
      r.workerId === null ||
      (typeof r.workerId === "string" && /^[a-f0-9]{64}$/u.test(r.workerId))
    ) ||
    !keys(r.host, "attachment,broker,cancellation,cleanup,container,result") ||
    !one(r.host.result, [null, 0, 1]) ||
    !keys(r.host.attachment, "closed,exitCode,signal") ||
    typeof r.host.attachment.closed !== "boolean" ||
    !(
      r.host.attachment.exitCode === null ||
      knexObservedExitCode(r.host.attachment.exitCode) !== null
    ) ||
    !one(r.host.attachment.signal, [
      null,
      "SIGINT",
      "SIGTERM",
      "SIGKILL",
      "other",
    ]) ||
    !keys(
      r.host.cancellation,
      "executionDeadlineExceeded,inputAborted,interrupted",
    ) ||
    typeof r.host.cancellation.inputAborted !== "boolean" ||
    typeof r.host.cancellation.interrupted !== "boolean" ||
    !one(r.host.cancellation.executionDeadlineExceeded, [null, false, true]) ||
    !keys(r.host.broker, "cleanup,health") ||
    !one(r.host.broker.health, ["not-checked", "healthy", "refused"]) ||
    !one(r.host.broker.cleanup, ["not-checked", "confirmed", "unconfirmed"]) ||
    !keys(r.host.cleanup, "attachment,worker") ||
    !one(r.host.cleanup.attachment, [
      "not-started",
      "confirmed",
      "unconfirmed",
    ]) ||
    !one(r.host.cleanup.worker, ["not-created", "confirmed", "unconfirmed"]) ||
    !keys(r.workerReported, "category,hint,state,trust") ||
    r.workerReported.trust !== "untrusted" ||
    !one(r.workerReported.state, ["absent", "reported", "invalid"]) ||
    !one(r.workerReported.hint, [
      null,
      "input",
      "load",
      "migrate",
      "destroy",
    ]) ||
    !one(r.workerReported.category, KNEX_WORKER_REPORTED_CATEGORIES)
  )
    return null;
  if (
    r.workerReported.state === "reported"
      ? r.workerReported.hint === null
      : r.workerReported.hint !== null ||
        r.workerReported.category !== "unclassified"
  )
    return null;
  const c = r.host.container;
  if (
    c !== null &&
    (!keys(c, "exitCode,oomKilled,running,status") ||
      typeof c.running !== "boolean" ||
      !one(c.status, ["created", "running", "exited"]) ||
      !(c.exitCode === null || knexObservedExitCode(c.exitCode) !== null) ||
      !one(c.oomKilled, [null, false, true]))
  )
    return null;
  return r;
};
const noncePattern = /^[a-f0-9]{64}$/u;
export const renderKnexWorkerFailureObservation = (
  observation: KnexWorkerFailureObservation,
  nonce: unknown,
) =>
  typeof nonce === "string" &&
  noncePattern.test(nonce) &&
  parseKnexWorkerFailureObservation(observation)
    ? KNEX_WORKER_FAILURE_OBSERVATION_PREFIX +
      JSON.stringify({ nonce, observation })
    : undefined;
export const readKnexWorkerFailureObservation = (
  output: string,
  nonce: string,
) => {
  let count = 0,
    observation: KnexWorkerFailureObservation | undefined;
  const cleaned = output.replace(
    /^Knex isolated worker failure observation: [^\r\n]*(?:\r?\n|$)/gmu,
    (line) => {
      count++;
      if (line.length <= 4096 && noncePattern.test(nonce))
        try {
          const r = JSON.parse(
            line.slice(KNEX_WORKER_FAILURE_OBSERVATION_PREFIX.length),
          );
          if (keys(r, "nonce,observation") && r.nonce === nonce)
            observation =
              parseKnexWorkerFailureObservation(r.observation) ?? undefined;
        } catch {
          /* Private/unknown frame bytes are always removed. */
        }
      return "";
    },
  );
  return {
    output: cleaned,
    ...(count === 1 && observation ? { observation } : {}),
  };
};
