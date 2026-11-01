/** Private, project-bound telemetry storage; independent of task trackers or recovery context. */
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseMigrationFailureDiagnostic,
  type MigrationFailureDiagnostic,
} from "../runtime/migrations/migration_failure.mjs";
import {
  MAX_RECENT_OPERATION_PROGRESS,
  parseOperationProgressSnapshot,
  type OperationProgressSnapshot,
  type RecentOperationProgress,
} from "./operation_progress_contract.mjs";

const HISTORY_ROOT = join(tmpdir(), "rehearsal-db-operation-activity");
const MAX_PROGRESS_BYTES = 32 * 1024;
const MAX_HISTORY_BYTES = 1024 * 1024;
interface StoredOperationProgress extends RecentOperationProgress {
  readonly migrationFailure?: MigrationFailureDiagnostic;
}
export interface RecentOperationFailure {
  readonly operationId: string;
  readonly diagnostic: MigrationFailureDiagnostic;
}
interface OwnedOperationProgress {
  readonly progress: OperationProgressSnapshot;
  readonly migrationFailure?: MigrationFailureDiagnostic;
}
const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const requireProjectHash = (projectHash: string): void => {
  if (!/^[a-f0-9]{64}$/u.test(projectHash))
    throw new Error("Operation history project identity is invalid.");
};

const readPrivateJson = async (
  path: string,
  maximumBytes: number,
): Promise<unknown> => {
  const details = await lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > maximumBytes ||
    (details.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && details.uid !== process.getuid())
  )
    throw new Error(
      "Private operation telemetry is unsafe or exceeds its size bound.",
    );
  return JSON.parse(await readFile(path, "utf8"));
};

const writePrivateJson = async (
  path: string,
  value: unknown,
  maximumBytes: number,
): Promise<void> => {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes) > maximumBytes)
    throw new Error("Operation telemetry exceeds its size bound.");
  try {
    const details = await lstat(path);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      (details.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && details.uid !== process.getuid())
    )
      throw new Error("Refusing to replace unsafe operation telemetry.");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const writeOwnedOperationProgress = async ({
  lockDirectory,
  token,
  operationId,
  progress,
  migrationFailure,
}: {
  readonly lockDirectory: string;
  readonly token: string;
  readonly operationId: string;
  readonly progress: OperationProgressSnapshot;
  readonly migrationFailure?: MigrationFailureDiagnostic;
}): Promise<void> => {
  const validated = parseOperationProgressSnapshot(progress);
  if (validated.operationId !== operationId)
    throw new Error("Operation telemetry belongs to another owner.");
  const failure =
    migrationFailure === undefined
      ? {}
      : { migrationFailure: parseMigrationFailureDiagnostic(migrationFailure) };
  if (migrationFailure !== undefined && validated.state !== "failed")
    throw new Error("Migration failure evidence requires a failed operation.");
  await writePrivateJson(
    join(lockDirectory, "progress.json"),
    { formatVersion: 1, ownerToken: token, progress: validated, ...failure },
    MAX_PROGRESS_BYTES,
  );
};

export const readOwnedOperationProgressRecord = async ({
  lockDirectory,
  token,
  operationId,
  startedAt,
}: {
  readonly lockDirectory: string;
  readonly token: string;
  readonly operationId: string;
  readonly startedAt: string;
}): Promise<OwnedOperationProgress | null> => {
  try {
    const value = (await readPrivateJson(
      join(lockDirectory, "progress.json"),
      MAX_PROGRESS_BYTES,
    )) as Record<string, unknown>;
    if (
      value.formatVersion !== 1 ||
      value.ownerToken !== token ||
      Object.keys(value).some(
        (key) =>
          ![
            "formatVersion",
            "ownerToken",
            "progress",
            "migrationFailure",
          ].includes(key),
      )
    )
      return null;
    const snapshot = parseOperationProgressSnapshot(value.progress);
    const failure =
      value.migrationFailure === undefined
        ? {}
        : {
            migrationFailure: parseMigrationFailureDiagnostic(
              value.migrationFailure,
            ),
          };
    if (value.migrationFailure !== undefined && snapshot.state !== "failed")
      return null;
    return snapshot.operationId === operationId &&
      snapshot.startedAt === startedAt
      ? { progress: snapshot, ...failure }
      : null;
  } catch {
    return null;
  }
};

export const readOwnedOperationProgress = async (
  input: Parameters<typeof readOwnedOperationProgressRecord>[0],
): Promise<OperationProgressSnapshot | null> =>
  (await readOwnedOperationProgressRecord(input))?.progress ?? null;

const assertHistoryRoot = async (): Promise<void> => {
  await mkdir(HISTORY_ROOT, { recursive: true, mode: 0o700 });
  const details = await lstat(HISTORY_ROOT);
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    (details.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && details.uid !== process.getuid())
  )
    throw new Error("Operation history directory is not private.");
};

const readStoredOperationProgress = async ({
  projectHash,
  operationKinds,
}: {
  readonly projectHash: string;
  readonly operationKinds: ReadonlySet<string>;
}): Promise<readonly StoredOperationProgress[] | null> => {
  requireProjectHash(projectHash);
  try {
    const root = await lstat(HISTORY_ROOT);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (root.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && root.uid !== process.getuid())
    )
      return null;
    const value = (await readPrivateJson(
      join(HISTORY_ROOT, `${projectHash}.json`),
      MAX_HISTORY_BYTES,
    )) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      value.projectHash !== projectHash ||
      !Array.isArray(value.recent) ||
      value.recent.length > MAX_RECENT_OPERATION_PROGRESS ||
      Object.keys(value).some(
        (key) => !["schemaVersion", "projectHash", "recent"].includes(key),
      )
    )
      return null;
    const recent = value.recent.map((entry: unknown) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("Invalid history entry.");
      const record = entry as Record<string, unknown>;
      if (
        typeof record.kind !== "string" ||
        !operationKinds.has(record.kind) ||
        (record.rehearsalVersion !== null &&
          (typeof record.rehearsalVersion !== "string" ||
            record.rehearsalVersion.length > 64 ||
            !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(
              record.rehearsalVersion,
            ))) ||
        Object.keys(record).some(
          (key) =>
            ![
              "kind",
              "rehearsalVersion",
              "progress",
              "migrationFailure",
            ].includes(key),
        )
      )
        throw new Error("Invalid history metadata.");
      const progress = parseOperationProgressSnapshot(record.progress);
      if (progress.state === "running")
        throw new Error(
          "An unfinished operation cannot be reported as completed history.",
        );
      const failure =
        record.migrationFailure === undefined
          ? {}
          : {
              migrationFailure: parseMigrationFailureDiagnostic(
                record.migrationFailure,
              ),
            };
      if (record.migrationFailure !== undefined && progress.state !== "failed")
        throw new Error("Migration failure history contradicts its outcome.");
      return Object.freeze({
        kind: record.kind,
        rehearsalVersion: record.rehearsalVersion as string | null,
        progress,
        ...failure,
      });
    });
    if (
      new Set(recent.map((entry) => entry.progress.operationId)).size !==
      recent.length
    )
      return null;
    return Object.freeze(recent);
  } catch (error) {
    return missing(error) ? Object.freeze([]) : null;
  }
};

export const readRecentOperationHistory = async (
  input: Parameters<typeof readStoredOperationProgress>[0],
): Promise<{
  readonly recent: readonly RecentOperationProgress[] | null;
  readonly recentFailures: readonly RecentOperationFailure[] | null;
}> => {
  const stored = await readStoredOperationProgress(input);
  if (stored === null) return { recent: null, recentFailures: null };
  return {
    recent: Object.freeze(
      stored.map(({ kind, rehearsalVersion, progress }) =>
        Object.freeze({ kind, rehearsalVersion, progress }),
      ),
    ),
    recentFailures: Object.freeze(
      stored.flatMap(({ progress, migrationFailure }) =>
        migrationFailure === undefined
          ? []
          : [
              Object.freeze({
                operationId: progress.operationId,
                diagnostic: migrationFailure,
              }),
            ],
      ),
    ),
  };
};

export const readRecentOperationProgress = async (
  input: Parameters<typeof readStoredOperationProgress>[0],
): Promise<readonly RecentOperationProgress[] | null> =>
  (await readRecentOperationHistory(input)).recent;

export const archiveOperationProgress = async ({
  projectHash,
  operationKinds,
  kind,
  rehearsalVersion,
  progress,
  migrationFailure,
}: {
  readonly projectHash: string;
  readonly operationKinds: ReadonlySet<string>;
  readonly kind: string;
  readonly rehearsalVersion: string | null;
  readonly progress: OperationProgressSnapshot;
  readonly migrationFailure?: MigrationFailureDiagnostic;
}): Promise<void> => {
  requireProjectHash(projectHash);
  if (progress.state === "running") return;
  await assertHistoryRoot();
  const previous = await readStoredOperationProgress({
    projectHash,
    operationKinds,
  });
  if (previous === null || !operationKinds.has(kind))
    throw new Error(
      "Existing operation history is unavailable; it was preserved.",
    );
  const entry = {
    kind,
    rehearsalVersion,
    progress: parseOperationProgressSnapshot(progress),
    ...(migrationFailure === undefined
      ? {}
      : {
          migrationFailure: parseMigrationFailureDiagnostic(migrationFailure),
        }),
  };
  if (migrationFailure !== undefined && progress.state !== "failed")
    throw new Error("Migration failure history requires a failed operation.");
  const recent = [
    ...previous.filter(
      (item) => item.progress.operationId !== progress.operationId,
    ),
    entry,
  ].slice(-MAX_RECENT_OPERATION_PROGRESS);
  await writePrivateJson(
    join(HISTORY_ROOT, `${projectHash}.json`),
    { schemaVersion: 1, projectHash, recent },
    MAX_HISTORY_BYTES,
  );
};
