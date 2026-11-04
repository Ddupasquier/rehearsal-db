/** A separate SQLite format: fresh sanitized database, exact SQL history, private generations. */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { loadRehearsalConfig } from "../../project/configuration.mjs";
import { runtimeConfigurationSha256 } from "../../runtime/lifecycle/configuration_binding.mjs";
import { getOperationCancellationSignal } from "../../shared/cancellation.mjs";
import {
  sqliteError,
  sqliteFileIdentity,
  sqliteOwnedDirectory,
  sqliteProjectPath,
  sqliteSha256,
  readSqliteBytes,
  readSqliteJson,
  parseSqliteJson,
  writeSqliteJson,
  assertSqliteFile,
  type SqliteFileIdentity,
} from "../../targets/sqlite/sqlite_files.mjs";
import { runSqliteWorkerJob } from "../../targets/sqlite/sqlite_worker_process.mjs";
import type { SQLitePrivacyPolicy } from "../../targets/sqlite/sqlite_worker_contract.mjs";
type Loaded = Awaited<ReturnType<typeof loadRehearsalConfig>>;
export interface SqliteHistoryEntry {
  readonly filename: string;
  readonly sha256: string;
}
export interface SqliteMigrationEntry extends SqliteHistoryEntry {
  readonly sql: string;
  readonly version: string;
  readonly name: string;
}
export interface SqliteBaselineManifest {
  readonly formatVersion: 6;
  readonly engine: {
    readonly family: "sqlite";
    readonly service: "sqlite";
    readonly version: "3.53.4";
    readonly driverVersion: 1;
    readonly codecVersion: 1;
  };
  readonly generationId: string;
  readonly createdAt: string;
  readonly sanitizationPolicySha256: string;
  readonly databaseSha256: string;
  readonly databaseIdentity: SqliteFileIdentity;
  readonly schemaSha256: string;
  readonly rowCount: number;
  readonly tableCount: number;
  readonly history: readonly SqliteHistoryEntry[];
  readonly historyEvidence: "owner-declared-current-input-checksums";
}
const generationPattern = /^sqlite-[0-9]{13}-[a-f0-9-]{36}$/u;
const migrationPattern = /^([0-9]{14})_([a-z][a-z0-9_]*)\.sql$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
export const readSqliteMigrations = (
  loaded: Loaded,
): readonly SqliteMigrationEntry[] => {
  const path = sqliteProjectPath(
    loaded.projectRoot,
    loaded.paths.migrationDirectory,
  );
  const directoryBefore = fs.lstatSync(path, { bigint: true });
  const names: string[] = [];
  const directory = fs.opendirSync(path);
  try {
    for (
      let entry = directory.readSync();
      entry !== null;
      entry = directory.readSync()
    ) {
      names.push(entry.name);
      if (names.length > 1000)
        throw sqliteError(
          "SQLITE_INPUT_INVALID",
          "SQLite migration inventory exceeds 1,000 files.",
        );
    }
  } finally {
    directory.closeSync();
  }
  names.sort();
  if (names.length > 1000 || names.some((n) => !migrationPattern.test(n)))
    throw sqliteError(
      "SQLITE_INPUT_INVALID",
      "SQLite migrations require at most 1,000 ordered timestamp_name.sql files.",
    );
  const versions = new Set<string>();
  let totalBytes = 0;
  const entries = names.map((filename) => {
    const match = migrationPattern.exec(filename)!;
    if (versions.has(match[1]!))
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "SQLite migration versions must be unique.",
      );
    versions.add(match[1]!);
    const source = sqliteProjectPath(loaded.projectRoot, join(path, filename));
    const identity = sqliteFileIdentity(source);
    const s = fs.lstatSync(source);
    if (s.size > 2 * 1024 * 1024 || totalBytes + s.size > 6 * 1024 * 1024)
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "SQLite migrations exceed the 2 MiB file or 6 MiB inventory bound.",
      );
    const bytes = readSqliteBytes(source, 2 * 1024 * 1024);
    totalBytes += bytes.length;
    if (totalBytes > 6 * 1024 * 1024)
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "SQLite migration inventory exceeds 6 MiB.",
      );
    assertSqliteFile(source, identity);
    const sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      filename,
      sha256: sqliteSha256(bytes),
      sql,
      version: match[1]!,
      name: match[2]!,
    };
  });
  const directoryAfter = fs.lstatSync(path, { bigint: true });
  if (
    directoryBefore.dev !== directoryAfter.dev ||
    directoryBefore.ino !== directoryAfter.ino ||
    directoryBefore.birthtimeNs !== directoryAfter.birthtimeNs ||
    directoryBefore.ctimeNs !== directoryAfter.ctimeNs
  )
    throw sqliteError(
      "SQLITE_INPUT_INVALID",
      "The SQLite migration directory changed during inspection.",
    );
  return entries;
};

export const createSqliteBaseline = async (
  loaded: Loaded,
  { recordsPath, ledgerPath }: { recordsPath: string; ledgerPath: string },
): Promise<SqliteBaselineManifest> => {
  if (!loaded.config.sqlite || !loaded.paths.sqliteSourceDatabase)
    throw sqliteError(
      "SQLITE_INPUT_INVALID",
      "SQLite configuration is required.",
    );
  const source = sqliteProjectPath(
    loaded.projectRoot,
    resolve(loaded.projectRoot, recordsPath),
  );
  if (
    source !==
    sqliteProjectPath(loaded.projectRoot, loaded.paths.sqliteSourceDatabase)
  )
    throw sqliteError(
      "SQLITE_INPUT_INVALID",
      "The reviewed source must match config.sqlite.sourceDatabase exactly.",
    );
  const files = readSqliteMigrations(loaded);
  const ledger = readSqliteJson<unknown>(
    sqliteProjectPath(
      loaded.projectRoot,
      resolve(loaded.projectRoot, ledgerPath),
    ),
  );
  if (
    !Array.isArray(ledger) ||
    ledger.length > files.length ||
    ledger.length > 1000
  )
    throw sqliteError(
      "SQLITE_INPUT_INVALID",
      "SQLite baseline history is invalid.",
    );
  const history = ledger.map((value: unknown, index): SqliteHistoryEntry => {
    const v = value as Record<string, unknown> | null;
    if (
      !v ||
      Object.keys(v).sort().join() !== "filename,sha256" ||
      v.filename !== files[index]!.filename ||
      v.sha256 !== files[index]!.sha256
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "SQLite baseline history must match an exact ordered current-file prefix.",
      );
    return { filename: files[index]!.filename, sha256: files[index]!.sha256 };
  });
  const policyPath = sqliteProjectPath(
    loaded.projectRoot,
    loaded.paths.sanitizationPolicy,
  );
  const policyIdentity = sqliteFileIdentity(policyPath);
  const policyBytes = readSqliteBytes(policyPath, 256 * 1024);
  if (policyBytes.length > 256 * 1024)
    throw sqliteError(
      "SQLITE_INPUT_INVALID",
      "SQLite privacy policy exceeds its limit.",
    );
  const policy = parseSqliteJson<SQLitePrivacyPolicy>(policyBytes);
  assertSqliteFile(policyPath, policyIdentity);
  const owner = sqliteOwnedDirectory(
    loaded.projectRoot,
    join(loaded.paths.artifactDirectory, "sqlite"),
    loaded.config,
    true,
  );
  const generationId = `sqlite-${Date.now()}-${randomUUID()}`;
  let generation: ReturnType<typeof sqliteOwnedDirectory> | undefined;
  try {
    const free = fs.statfsSync(owner.path, { bigint: true });
    if (
      free.bavail * free.bsize <
      BigInt(loaded.config.sqlite.maximumBytes * 4 + 16 * 1024 * 1024)
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "Insufficient free storage for a bounded SQLite snapshot.",
      );
    generation = sqliteOwnedDirectory(
      loaded.projectRoot,
      join(owner.path, "generations", generationId),
      loaded.config,
      true,
    );
    const database = join(generation.path, "baseline.sqlite");
    const result = await runSqliteWorkerJob(
      {
        operation: "snapshot",
        sourceDatabase: source,
        destinationDatabase: database,
        policy,
        maximumBytes: loaded.config.sqlite.maximumBytes,
        history,
      },
      {
        timeoutMs: loaded.config.sqlite.timeoutSeconds * 1000,
        ...(getOperationCancellationSignal()
          ? { signal: getOperationCancellationSignal()! }
          : {}),
      },
    );
    owner.assertOwned();
    generation.assertOwned();
    assertSqliteFile(policyPath, policyIdentity);
    if (
      sqliteSha256(readSqliteBytes(policyPath, 256 * 1024)) !==
      sqliteSha256(policyBytes)
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "The SQLite privacy policy changed during snapshot creation.",
      );
    if (
      JSON.stringify(
        readSqliteMigrations(loaded).map(({ filename, sha256 }) => ({
          filename,
          sha256,
        })),
      ) !==
      JSON.stringify(
        files.map(({ filename, sha256 }) => ({ filename, sha256 })),
      )
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "SQLite migration inputs changed during snapshot creation.",
      );
    const manifest: SqliteBaselineManifest = {
      formatVersion: 6,
      engine: {
        family: "sqlite",
        service: "sqlite",
        version: "3.53.4",
        driverVersion: 1,
        codecVersion: 1,
      },
      generationId,
      createdAt: new Date().toISOString(),
      sanitizationPolicySha256: sqliteSha256(policyBytes),
      databaseSha256: sqliteSha256(
        readSqliteBytes(database, loaded.config.sqlite.maximumBytes),
      ),
      databaseIdentity: sqliteFileIdentity(database),
      schemaSha256: result.schemaSha256,
      rowCount: result.rowCount,
      tableCount: result.tableCount,
      history,
      historyEvidence: "owner-declared-current-input-checksums",
    };
    const manifestPath = join(generation.path, "baseline-manifest.json");
    writeSqliteJson(manifestPath, manifest, true);
    writeSqliteJson(join(owner.path, "active.json"), {
      version: 1,
      engine: "sqlite",
      generationId,
      manifestSha256: sqliteSha256(readSqliteBytes(manifestPath, 512 * 1024)),
      manifestIdentity: sqliteFileIdentity(manifestPath),
    });
    return manifest;
  } finally {
    generation?.close();
    owner.close();
  }
};

export const readSqliteBaseline = (
  loaded: Loaded,
): { manifest: SqliteBaselineManifest; database: string } => {
  const owner = sqliteOwnedDirectory(
    loaded.projectRoot,
    join(loaded.paths.artifactDirectory, "sqlite"),
    loaded.config,
  );
  let generation: ReturnType<typeof sqliteOwnedDirectory> | undefined;
  try {
    const active = readSqliteJson<{
      version: number;
      engine: string;
      generationId: string;
      manifestSha256: string;
      manifestIdentity: SqliteFileIdentity;
    }>(join(owner.path, "active.json"));
    if (
      !active ||
      typeof active !== "object" ||
      active.version !== 1 ||
      active.engine !== "sqlite" ||
      typeof active.generationId !== "string" ||
      !generationPattern.test(active.generationId) ||
      !shaPattern.test(active.manifestSha256)
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "SQLite active baseline reference is invalid.",
      );
    generation = sqliteOwnedDirectory(
      loaded.projectRoot,
      join(owner.path, "generations", active.generationId),
      loaded.config,
    );
    const manifestPath = join(generation.path, "baseline-manifest.json");
    assertSqliteFile(manifestPath, active.manifestIdentity);
    const manifest = readSqliteJson<SqliteBaselineManifest>(manifestPath);
    if (
      !manifest ||
      typeof manifest !== "object" ||
      sqliteSha256(readSqliteBytes(manifestPath, 512 * 1024)) !==
        active.manifestSha256 ||
      manifest.formatVersion !== 6 ||
      manifest.engine?.family !== "sqlite" ||
      manifest.engine.service !== "sqlite" ||
      manifest.engine.version !== "3.53.4" ||
      manifest.engine.driverVersion !== 1 ||
      manifest.engine.codecVersion !== 1 ||
      manifest.generationId !== active.generationId ||
      !Array.isArray(manifest.history) ||
      manifest.history.length > 1000 ||
      !shaPattern.test(manifest.databaseSha256) ||
      !shaPattern.test(manifest.schemaSha256) ||
      !Number.isSafeInteger(manifest.rowCount) ||
      manifest.rowCount < 0 ||
      manifest.rowCount > 100000 ||
      !Number.isSafeInteger(manifest.tableCount) ||
      manifest.tableCount < 0 ||
      manifest.tableCount > 256 ||
      manifest.historyEvidence !== "owner-declared-current-input-checksums" ||
      manifest.history.some(
        (x) =>
          !x ||
          typeof x.filename !== "string" ||
          !migrationPattern.test(x.filename) ||
          typeof x.sha256 !== "string" ||
          !shaPattern.test(x.sha256),
      )
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "The SQLite baseline format or checksum is invalid.",
      );
    const database = join(generation.path, "baseline.sqlite");
    assertSqliteFile(database, manifest.databaseIdentity);
    if (
      sqliteSha256(
        readSqliteBytes(database, loaded.config.sqlite!.maximumBytes),
      ) !== manifest.databaseSha256
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "The immutable SQLite baseline database changed.",
      );
    const policy = sqliteProjectPath(
      loaded.projectRoot,
      loaded.paths.sanitizationPolicy,
    );
    if (
      sqliteSha256(readSqliteBytes(policy, 256 * 1024)) !==
      manifest.sanitizationPolicySha256
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "SQLite privacy policy differs from the active baseline.",
      );
    owner.assertOwned();
    generation.assertOwned();
    return { manifest, database };
  } finally {
    generation?.close();
    owner.close();
  }
};

export const sqliteCandidatePlan = (loaded: Loaded) => {
  const baseline = readSqliteBaseline(loaded).manifest;
  const files = readSqliteMigrations(loaded);
  for (let i = 0; i < baseline.history.length; i++)
    if (
      files[i]?.filename !== baseline.history[i]!.filename ||
      files[i]?.sha256 !== baseline.history[i]!.sha256
    )
      throw sqliteError(
        "SQLITE_INPUT_INVALID",
        "The SQLite baseline migration prefix drifted.",
      );
  const candidates = files.slice(baseline.history.length);
  const candidateSha256 = sqliteSha256(
    JSON.stringify({
      formatVersion: 1,
      family: "sqlite",
      engine: baseline.engine,
      baselineGenerationId: baseline.generationId,
      baselineSha256: baseline.databaseSha256,
      policySha256: baseline.sanitizationPolicySha256,
      configurationSha256: runtimeConfigurationSha256(loaded.config),
      files: files.map(({ filename, sha256 }) => ({ filename, sha256 })),
    }),
  );
  return { baseline, files, candidates, candidateSha256 };
};
