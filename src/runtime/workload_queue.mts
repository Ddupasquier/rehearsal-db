/** Cooperative local-user lifecycle admission. Not a host-memory or container limit. */
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { RehearsalError } from "../shared/diagnostics.mjs";
import { workloadQueueDirectory } from "./workload_queue_location.mjs";
import {
  WorkloadQueueStore,
  type WorkloadTicket,
  type StoredWorkloadTicket,
} from "./workload_queue_store.mjs";

interface QueueOptions {
  stateDirectory?: string;
}
export const withWorkloadDiagnostics = async <Result,>(
  task: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await task();
  } catch (error) {
    if (error instanceof RehearsalError) throw error;
    throw new RehearsalError({
      category: "runtime_dependency_failure",
      code: "WORKLOAD_QUEUE_REFUSED",
      message:
        error instanceof Error
          ? error.message
          : "Local workload coordination was refused.",
      refused:
        "No new guarded runtime phase or foreign workload was started, stopped or recovered by this refusal.",
      suggestions: [
        "Run rehearsal workloads to inspect participating owners.",
        "Cancel a waiting request or let its owner finish. Before recovering a dead holder, check its owned commands and descendants; never delete live queue state.",
      ],
    });
  }
};
const openStore = async (options: QueueOptions, create: boolean) => {
  const store = new WorkloadQueueStore(
    await workloadQueueDirectory(options.stateDirectory),
  );
  return (await store.initialize(create)) ? store : null;
};
const earlier = (left: WorkloadTicket, right: WorkloadTicket) =>
  left.number < right.number ||
  (left.number === right.number && left.token < right.token);
const digest = (entries: StoredWorkloadTicket[]): string | null => {
  const stale = entries.filter(
    ({ alive, ticket }) => !alive && ticket.phase === "held",
  );
  return stale.length
    ? createHash("sha256")
        .update(
          JSON.stringify(
            stale
              .map(({ file, identity, ticket }) => ({ file, identity, ticket }))
              .sort((a, b) => a.file.localeCompare(b.file)),
          ),
        )
        .digest("hex")
    : null;
};
const snapshot = (entries: StoredWorkloadTicket[]) => ({
  schemaVersion: 1 as const,
  scope: "local-user-boot-process-namespace" as const,
  capacity: "not-measured" as const,
  recoveryDigest: digest(entries),
  entries: entries
    .map(({ ticket, alive }) => ({
      id: ticket.token,
      command: ticket.command,
      pid: ticket.pid,
      phase: ticket.phase,
      owner: alive ? ("alive" as const) : ("dead" as const),
      createdAt: ticket.createdAt,
      recoveryRequired: !alive && ticket.phase === "held",
    }))
    .sort((a, b) => a.id.localeCompare(b.id)),
});

export const inspectWorkloads = async (options: QueueOptions = {}) => {
  const store = await openStore(options, false);
  return snapshot(store ? await store.list() : []);
};

/** Explicitly reviewed metadata recovery only; never stops processes or removes data. */
export const recoverWorkloads = async (
  confirmation: string,
  options: QueueOptions = {},
) => {
  const store = await openStore(options, false);
  if (!store)
    throw new Error("No stale workload holder is available to recover.");
  const entries = await store.list();
  const expected = digest(entries);
  if (!expected || confirmation !== expected)
    throw new Error(
      "Workload recovery confirmation changed or is missing. Run rehearsal workloads --json and review again.",
    );
  // A dead parent is not proof that its children are gone. The operator must check
  // owned commands first; age, wait expiry and liveness never authorize auto-steal.
  const eligible = entries.filter(
    ({ alive, ticket }) => !alive && ticket.phase === "held",
  );
  for (const entry of eligible) {
    const current = await store.read(entry.file);
    if (!current || current.alive || current.identity !== entry.identity)
      throw new Error(
        "Workload recovery state changed; no live owner was removed.",
      );
  }
  for (const entry of eligible) await store.remove(entry);
  return {
    schemaVersion: 1 as const,
    recovered: eligible.length,
    databasesChanged: false as const,
  };
};

export const acquireWorkload = async ({
  command,
  waitTimeoutSeconds,
  signal,
  onWaiting,
  ...options
}: QueueOptions & {
  command: WorkloadTicket["command"];
  waitTimeoutSeconds: number;
  signal?: AbortSignal;
  onWaiting?: () => void;
}) => {
  if (
    !Number.isInteger(waitTimeoutSeconds) ||
    waitTimeoutSeconds < 0 ||
    waitTimeoutSeconds > 300
  )
    throw new Error(
      "Workload wait timeout must be an integer from 0 to 300 seconds.",
    );
  signal?.throwIfAborted();
  const store = (await openStore(options, true))!;
  if ((await store.list()).length >= 64)
    throw new Error("Workload queue is full; no workload was started.");
  const ticket: WorkloadTicket = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    command,
    phase: "choosing",
    number: 0,
    createdAt: new Date().toISOString(),
  };
  const file = `ticket-${ticket.token}.json`;
  const removeOwned = async () => {
    const entry = await store.read(file);
    if (entry) {
      if (
        entry.ticket.pid !== process.pid ||
        entry.ticket.token !== ticket.token
      )
        throw new Error(
          "Workload ownership changed; no foreign ticket was removed.",
        );
      await store.remove(entry);
    }
  };
  const started = performance.now();
  let notified = false;
  let held = false;
  try {
    // Choosing + number ordering follows the bakery protocol. Each participant
    // writes only its unique record; no stale-reclaimer can rename a new owner.
    await store.write(ticket, true);
    const entries = await store.list();
    ticket.number =
      1 + Math.max(0, ...entries.map(({ ticket: entry }) => entry.number));
    if (!Number.isSafeInteger(ticket.number))
      throw new Error("Workload ticket number limit reached.");
    ticket.phase = "queued";
    await store.write(ticket);
    for (;;) {
      signal?.throwIfAborted();
      const current = await store.list();
      const own = current.find((entry) => entry.file === file);
      if (
        !own ||
        own.ticket.phase !== "queued" ||
        own.ticket.number !== ticket.number
      )
        throw new Error(
          "Workload ticket changed or disappeared; no workload was started.",
        );
      let blocked = false;
      for (const entry of current) {
        if (entry.file === file) continue;
        if (!entry.alive && entry.ticket.phase !== "held") {
          await store.remove(entry); // This owner never began guarded work.
          continue;
        }
        if (
          entry.ticket.phase === "choosing" ||
          entry.ticket.phase === "held" ||
          earlier(entry.ticket, ticket)
        )
          blocked = true;
      }
      if (!blocked) {
        signal?.throwIfAborted();
        ticket.phase = "held";
        await store.write(ticket);
        held = true;
        break;
      }
      if (!notified) {
        onWaiting?.();
        notified = true;
      }
      if (performance.now() - started >= waitTimeoutSeconds * 1000)
        throw new Error(
          "Local workload queue wait expired. No queued runtime phase was started. Run rehearsal workloads; a dead holder requires reviewed recovery, not a forced stop.",
        );
      try {
        await delay(
          Math.min(
            100,
            Math.max(
              1,
              waitTimeoutSeconds * 1000 - (performance.now() - started),
            ),
          ),
          undefined,
          { signal },
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw error;
      }
    }
  } finally {
    if (!held) await removeOwned();
  }
  let released = false;
  return {
    release: async () => {
      if (!released) {
        await removeOwned();
        released = true;
      }
    },
  };
};

export const withWorkloadAdmission = async <Result,>({
  enabled,
  execute,
  ...options
}: Parameters<typeof acquireWorkload>[0] & {
  enabled: boolean;
  execute: () => Promise<Result>;
}): Promise<Result> => {
  if (!enabled) return execute();
  const lease = await withWorkloadDiagnostics(() => acquireWorkload(options));
  let result: Result;
  try {
    options.signal?.throwIfAborted();
    result = await execute();
  } catch (error) {
    try {
      await lease.release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "The runtime phase and its workload metadata release both failed.",
      );
    }
    throw error;
  }
  await withWorkloadDiagnostics(() => lease.release());
  return result;
};
