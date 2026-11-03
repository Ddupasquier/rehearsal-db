/** Retained PostgreSQL container bindings and adapter-driven reconstruction protocol. */
import { captureRuntimeStartupOwnership } from "../../runtime/lifecycle/runtime_startup_ownership.mjs";
import { assertDockerResourceLabels } from "../docker_resource_ownership.mjs";

export interface PostgresqlRetainedContainerReceipt {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly containerName: string;
  readonly volumeName: string;
  readonly volumeCreatedAt: string;
  readonly volumeDriver: string;
  readonly image: string;
  readonly imageId: string;
  readonly engineIdentity: string;
  readonly generationId: string;
  readonly dataSha256: string;
}
export interface PostgresqlResumeMarker {
  readonly target: "postgresql";
  readonly generationId: string;
  readonly dataSha256: string;
  readonly image: string;
  readonly databasePassword: string;
}
export interface PostgresqlResumeSnapshot {
  readonly engineIdentity: string;
  readonly image:
    | {
        readonly state: "present";
        readonly id: string;
        readonly reference: string;
      }
    | { readonly state: "absent" | "unknown" };
  readonly volume:
    | {
        readonly state: "present";
        readonly name: string;
        readonly createdAt: string;
        readonly driver: string;
        readonly labels: unknown;
      }
    | { readonly state: "absent" | "unknown" };
  /** Absence must come from a successful complete exact-name listing, never inspect failure. */
  readonly container:
    | { readonly state: "absent" }
    | { readonly state: "unknown" }
    | {
        readonly state: "present";
        readonly id: string;
        readonly name: string;
        readonly imageId: string;
        readonly labels: unknown;
        readonly running: boolean;
        readonly mounts: readonly {
          readonly type: string;
          readonly name: string;
          readonly destination: string;
          readonly writable: boolean;
        }[];
      };
}
export interface PostgresqlResumeAdapter {
  /** Each callback must use the pinned engine and honor both signal and timeoutMilliseconds. */
  inspect(options: {
    readonly signal: AbortSignal;
    readonly timeoutMilliseconds: number;
  }): Promise<PostgresqlResumeSnapshot>;
  create(
    args: readonly string[],
    options: {
      readonly signal: AbortSignal;
      readonly timeoutMilliseconds: number;
    },
  ): Promise<void>;
  waitUntilReady(options: {
    readonly signal: AbortSignal;
    readonly timeoutMilliseconds: number;
  }): Promise<void>;
}
const refused = () =>
  new Error(
    "Retained PostgreSQL container cannot be resumed safely. Preserve its volume, runtime marker and retirement receipt; no baseline reset or data deletion was attempted.",
  );
const identifier = /^[a-z_][a-z0-9_]*$/u;
const digest = /^[a-f0-9]{64}$/u;
const assertReceipt = (
  receipt: PostgresqlRetainedContainerReceipt,
  marker: PostgresqlResumeMarker,
) => {
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    !/^[-a-z0-9]{2,63}$/u.test(receipt.projectId) ||
    receipt.containerName !== receipt.projectId + "-postgresql" ||
    receipt.volumeName !== receipt.containerName + "-data" ||
    !/^postgres:\d+(?:\.\d+)?-alpine$/u.test(receipt.image) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.imageId) ||
    !digest.test(receipt.engineIdentity) ||
    typeof receipt.volumeDriver !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(receipt.volumeDriver) ||
    !receipt.volumeCreatedAt ||
    !Number.isFinite(Date.parse(receipt.volumeCreatedAt)) ||
    !receipt.generationId ||
    !digest.test(receipt.dataSha256) ||
    !marker ||
    marker.target !== "postgresql" ||
    marker.generationId !== receipt.generationId ||
    marker.dataSha256 !== receipt.dataSha256 ||
    marker.image !== receipt.image ||
    typeof marker.databasePassword !== "string" ||
    marker.databasePassword.length < 32 ||
    marker.databasePassword.length > 256 ||
    /[\r\n\0]/u.test(marker.databasePassword)
  )
    throw refused();
};
const assertRetainedBindings = (
  snapshot: PostgresqlResumeSnapshot,
  receipt: PostgresqlRetainedContainerReceipt,
) => {
  if (
    snapshot.engineIdentity !== receipt.engineIdentity ||
    snapshot.image.state !== "present" ||
    snapshot.image.id !== receipt.imageId ||
    snapshot.image.reference !== receipt.image ||
    snapshot.volume.state !== "present" ||
    snapshot.volume.name !== receipt.volumeName ||
    snapshot.volume.createdAt !== receipt.volumeCreatedAt ||
    snapshot.volume.driver !== receipt.volumeDriver
  )
    throw refused();
  try {
    assertDockerResourceLabels({
      labels: snapshot.volume.labels,
      expectedLabel: "com.rehearsal-db.project",
      projectId: receipt.projectId,
    });
  } catch {
    throw refused();
  }
};
const assertCreatedContainer = (
  snapshot: PostgresqlResumeSnapshot,
  receipt: PostgresqlRetainedContainerReceipt,
) => {
  assertRetainedBindings(snapshot, receipt);
  if (
    snapshot.container.state !== "present" ||
    !digest.test(snapshot.container.id) ||
    snapshot.container.name !== receipt.containerName ||
    snapshot.container.imageId !== receipt.imageId ||
    !snapshot.container.running ||
    snapshot.container.mounts.length !== 1
  )
    throw refused();
  try {
    assertDockerResourceLabels({
      labels: snapshot.container.labels,
      expectedLabel: "com.rehearsal-db.project",
      projectId: receipt.projectId,
    });
  } catch {
    throw refused();
  }
  const mount = snapshot.container.mounts[0]!;
  if (
    mount.type !== "volume" ||
    mount.name !== receipt.volumeName ||
    mount.destination !== "/var/lib/postgresql/data" ||
    !mount.writable
  )
    throw refused();
  return snapshot.container;
};
export const retainedPostgresqlCreateArguments = ({
  receipt,
  password,
  port,
  user,
  database,
}: {
  readonly receipt: PostgresqlRetainedContainerReceipt;
  readonly password: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
}): readonly string[] => {
  if (
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !identifier.test(user) ||
    !identifier.test(database) ||
    typeof password !== "string" ||
    password.length < 32 ||
    password.length > 256 ||
    /[\r\n\0]/u.test(password)
  )
    throw refused();
  return Object.freeze([
    "run",
    "--detach",
    "--pull=never",
    "--name",
    receipt.containerName,
    "--label",
    "com.rehearsal-db.project=" + receipt.projectId,
    "--publish",
    `127.0.0.1:${port}:5432`,
    "--env",
    "POSTGRES_PASSWORD=" + password,
    "--env",
    "POSTGRES_DB=" + database,
    "--env",
    "POSTGRES_USER=" + user,
    "--volume",
    receipt.volumeName + ":/var/lib/postgresql/data",
    receipt.imageId,
  ]);
};
/** Caller holds the existing lifecycle/operation lease and has verified the private marker/receipt files. */
export const resumeRetainedPostgresqlContainer = async ({
  receipt,
  marker,
  port,
  user,
  database,
  adapter,
  signal: providedSignal,
}: {
  readonly receipt: PostgresqlRetainedContainerReceipt;
  readonly marker: PostgresqlResumeMarker;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly adapter: PostgresqlResumeAdapter;
  readonly signal?: AbortSignal;
}) => {
  assertReceipt(receipt, marker);
  const controller = new AbortController();
  const parentAbort = () => controller.abort();
  providedSignal?.addEventListener("abort", parentAbort, { once: true });
  if (providedSignal?.aborted) controller.abort();
  const signal = controller.signal;
  const deadline = setTimeout(() => controller.abort(), 180000);
  deadline.unref();
  try {
    signal.throwIfAborted();
    const args = retainedPostgresqlCreateArguments({
      receipt,
      password: marker.databasePassword,
      port,
      user,
      database,
    });
    const first = await adapter.inspect({ signal, timeoutMilliseconds: 10000 });
    signal.throwIfAborted();
    assertRetainedBindings(first, receipt);
    if (first.container.state !== "absent") throw refused();
    // Recheck after review immediately before the sole creation; foreign replacements never become reset requests.
    const current = await adapter.inspect({
      signal,
      timeoutMilliseconds: 10000,
    });
    signal.throwIfAborted();
    assertRetainedBindings(current, receipt);
    if (current.container.state !== "absent") throw refused();
    // Resume creates a new shell too: capture before mutation so the shared
    // startup controller can stop this exact shell after readiness failure or cancellation.
    captureRuntimeStartupOwnership();
    await adapter.create(args, { signal, timeoutMilliseconds: 120000 });
    signal.throwIfAborted();
    const created = await adapter.inspect({
      signal,
      timeoutMilliseconds: 10000,
    });
    signal.throwIfAborted();
    const createdContainer = assertCreatedContainer(created, receipt);
    await adapter.waitUntilReady({ signal, timeoutMilliseconds: 60000 });
    signal.throwIfAborted();
    const ready = await adapter.inspect({ signal, timeoutMilliseconds: 10000 });
    signal.throwIfAborted();
    const readyContainer = assertCreatedContainer(ready, receipt);
    if (
      readyContainer.id !== createdContainer.id ||
      JSON.stringify(readyContainer.mounts) !==
        JSON.stringify(createdContainer.mounts)
    )
      throw refused();
    return Object.freeze({
      state: "resumed" as const,
      containerId: createdContainer.id,
      volumeName: receipt.volumeName,
      volumeCreatedAt: receipt.volumeCreatedAt,
      imageId: receipt.imageId,
      generationId: receipt.generationId,
      dataSha256: receipt.dataSha256,
      dataPreserved: true as const,
    });
  } catch {
    throw refused();
  } finally {
    clearTimeout(deadline);
    providedSignal?.removeEventListener("abort", parentAbort);
  }
};

export {
  assertReceipt as assertPostgresqlRetainedReceipt,
  assertRetainedBindings as assertPostgresqlRetainedBindings,
  digest as POSTGRESQL_RESUME_DIGEST_PATTERN,
  refused as postgresqlResumeRefusal,
};
