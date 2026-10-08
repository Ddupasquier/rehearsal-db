/**
 * Purpose: Write, verify, and atomically activate immutable sanitized Rehearsal
 * baseline generations. Do not run directly; this module is reusable script
 * infrastructure.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  createMigrationReplayReceipt,
  type MigrationLedgerEntry,
  type MigrationSourceEntry,
} from "../runtime/migration_history.mjs";

type ByteChunk = string | Uint8Array;
type ByteStream = Iterable<ByteChunk> | AsyncIterable<ByteChunk>;

export interface BaselineRecord {
  readonly schema?: string;
  readonly table: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export interface BaselineMigrationFile {
  readonly filename: string;
  readonly content: string;
  readonly fileSha256?: string;
  readonly version?: string;
  readonly name?: string;
}

export interface BaselineStorageAsset {
  readonly bucket: string;
  readonly objectPath: string;
  readonly contentType?: string;
  readonly content: Buffer | ByteStream;
}

export interface BaselineMetadata extends Record<string, unknown> {
  readonly migrationCutoff: string;
  readonly migrationHistorySha256: string;
  readonly sanitizationPolicySha256: string;
  readonly sourceMigrationHistory?: readonly MigrationLedgerEntry[];
}

interface ContentReceipt {
  readonly sha256: string;
  readonly bytes: number;
}

interface StorageAssetReceipt extends ContentReceipt {
  readonly bucket: string;
  readonly objectPath: string;
  readonly contentType: string;
}

export interface BaselineManifest extends BaselineMetadata {
  readonly formatVersion: 1 | 2;
  readonly generationId: string;
  readonly rowCount: number;
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly files: Readonly<
    Record<string, Readonly<{ sha256: string; rows?: number; bytes?: number }>>
  >;
  readonly storageAssets: Readonly<Record<string, StorageAssetReceipt>>;
  readonly migrations: Readonly<Record<string, Readonly<{ sha256: string }>>>;
}

export interface ActiveBaselinePaths {
  readonly artifactRoot: string;
  readonly generationDirectory: string;
  readonly dataPath: string;
  readonly manifestPath: string;
  readonly migrationsDirectory: string;
  readonly schemaPath: string;
}

export interface BaselinePrunePlan {
  readonly retained: string[];
  readonly removed: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasErrorCode = (error: unknown, code: string): boolean =>
  isObject(error) && error.code === code;

const isBaselineRecord = (value: unknown): value is BaselineRecord =>
  isObject(value) &&
  (value.schema === undefined ||
    (typeof value.schema === "string" &&
      /^[a-z][a-z0-9_]{0,62}$/u.test(value.schema))) &&
  typeof value.table === "string" &&
  /^[a-z][a-z0-9_]{0,62}$/u.test(value.table) &&
  isObject(value.row);

const isByteStream = (value: unknown): value is ByteStream =>
  value !== null &&
  value !== undefined &&
  (Symbol.iterator in Object(value) || Symbol.asyncIterator in Object(value));

const parseManifest = (source: string): BaselineManifest => {
  const parsed: unknown = JSON.parse(source);
  if (!isObject(parsed)) {
    throw new Error("A Rehearsal baseline manifest must be an object.");
  }
  return parsed as unknown as BaselineManifest;
};

const generationPattern = /^\d{8}T\d{6}Z-[a-f0-9]{12}$/u;
const buildPrefix = ".building-";
const generationsDirectoryName = "generations";
const currentLinkName = "current";
const migrationNamePattern = /^\d{14}_[a-z0-9_]+\.sql$/u;
const storageBucketPattern = /^[a-z0-9][a-z0-9.-]{0,99}$/u;
const maximumAssetBytes = 50 * 1024 * 1024;
const maximumTotalAssetBytes = 2 * 1024 * 1024 * 1024;
const relationPattern = /^(?:[a-z][a-z0-9_]{0,62}\.)?[a-z][a-z0-9_]{0,62}$/u;
const relationKey = (schema: string, table: string): string =>
  schema === "public" ? table : `${schema}.${table}`;

const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(value, null, "\t")}\n`;

const assertGenerationId = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Invalid Rehearsal baseline generation identifier.");
  }
  if (!generationPattern.test(value)) {
    throw new Error(
      `Invalid Rehearsal baseline generation identifier: ${value}`,
    );
  }
  return value;
};

const assertArtifactRoot = (artifactRoot: string): string => {
  const resolved = resolve(artifactRoot);
  if (basename(resolved) !== ".rehearsal" || resolved === sep) {
    throw new Error(
      `Refusing an unsafe Rehearsal artifact root: ${artifactRoot}`,
    );
  }
  return resolved;
};

const pathInside = (parent: string, child: string): boolean => {
  const childRelative = relative(parent, child);
  return (
    childRelative !== "" &&
    !childRelative.startsWith(`..${sep}`) &&
    childRelative !== ".." &&
    !childRelative.startsWith(sep)
  );
};

const assertInsideRoot = (root: string, target: string): string => {
  if (!pathInside(root, target)) {
    throw new Error(`Rehearsal artifact path escaped its root: ${target}`);
  }
  return target;
};

const writeImmutableFile = async (
  path: string,
  content: string | Uint8Array,
): Promise<void> => {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o400);
};

const assetRelativePath = (bucket: string, objectPath: string): string => {
  if (!storageBucketPattern.test(bucket)) {
    throw new Error(`Invalid Rehearsal Storage bucket: ${bucket}.`);
  }
  const segments = objectPath.split("/");
  if (
    !objectPath ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid Rehearsal Storage object path: ${objectPath}.`);
  }
  return join(
    "storage",
    encodeURIComponent(bucket),
    ...segments.map(encodeURIComponent),
  );
};

const verifyNoSymlink = async (path: string, label: string): Promise<void> => {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} may not be a symbolic link.`);
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
};

const makeArtifactTreeWritable = async (path: string): Promise<void> => {
  await chmod(path, 0o700).catch(() => undefined);
  for (const entry of await readdir(path, { withFileTypes: true }).catch(
    () => [],
  )) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeArtifactTreeWritable(child);
    else if (!entry.isSymbolicLink()) await chmod(child, 0o600);
  }
};

export const createBaselineGenerationId = ({
  now = new Date(),
}: {
  now?: Date;
} = {}): string => {
  const timestamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");
  return `${timestamp}-${randomBytes(6).toString("hex")}`;
};

export const createAndActivateBaseline = async ({
  artifactRoot,
  generationId = createBaselineGenerationId(),
  records,
  metadata,
  expectedTables = [],
  migrationFiles = [],
  assets = [],
  schemaSql = null,
  activate = true,
}: {
  artifactRoot: string;
  generationId?: string;
  records: Iterable<unknown> | AsyncIterable<unknown>;
  metadata: BaselineMetadata;
  expectedTables?: readonly string[];
  migrationFiles?:
    | readonly BaselineMigrationFile[]
    | Promise<readonly BaselineMigrationFile[]>
    | (() =>
        | readonly BaselineMigrationFile[]
        | Promise<readonly BaselineMigrationFile[]>);
  assets?: Iterable<BaselineStorageAsset> | AsyncIterable<BaselineStorageAsset>;
  schemaSql?: string | null;
  activate?: boolean;
}): Promise<BaselineManifest> => {
  const root = assertArtifactRoot(artifactRoot);
  assertGenerationId(generationId);
  if (
    !Array.isArray(expectedTables) ||
    expectedTables.some((name) => !relationPattern.test(name)) ||
    new Set(expectedTables).size !== expectedTables.length
  ) {
    throw new Error(
      "Rehearsal expected table names are invalid or duplicated.",
    );
  }
  const expectedTableSet = new Set(expectedTables);
  await verifyNoSymlink(root, "The Rehearsal artifact root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const generationsRoot = assertInsideRoot(
    root,
    join(root, generationsDirectoryName),
  );
  await verifyNoSymlink(generationsRoot, "The Rehearsal generations directory");
  await mkdir(generationsRoot, { recursive: true, mode: 0o700 });

  const finalDirectory = assertInsideRoot(
    root,
    join(generationsRoot, generationId),
  );
  const buildDirectory = assertInsideRoot(
    root,
    join(
      root,
      `${buildPrefix}${generationId}-${randomBytes(4).toString("hex")}`,
    ),
  );
  const dataPath = join(buildDirectory, "sanitized-data.ndjson");
  let dataHandle: FileHandle | null = null;
  let finalCreated = false;
  let rowCount = 0;
  const tableCounts = new Map(expectedTables.map((name) => [name, 0]));
  const dataHash = createHash("sha256");

  try {
    await mkdir(buildDirectory, { mode: 0o700 });
    dataHandle = await open(dataPath, "wx", 0o600);
    for await (const record of records) {
      if (!isBaselineRecord(record)) {
        throw new Error("A sanitized baseline record has an invalid shape.");
      }
      const key = relationKey(record.schema ?? "public", record.table);
      if (expectedTableSet.size && !expectedTableSet.has(key)) {
        throw new Error(`The baseline stream exposed unexpected table ${key}.`);
      }
      const line = `${JSON.stringify(record)}\n`;
      dataHash.update(line);
      await dataHandle.write(line, null, "utf8");
      rowCount += 1;
      tableCounts.set(key, (tableCounts.get(key) ?? 0) + 1);
    }
    await dataHandle.sync();
    await dataHandle.close();
    dataHandle = null;
    await chmod(dataPath, 0o400);
    let schemaReceipt: ContentReceipt | undefined;
    if (schemaSql !== null) {
      if (typeof schemaSql !== "string" || schemaSql.length === 0) {
        throw new Error("A Rehearsal production schema snapshot is invalid.");
      }
      const schemaPath = join(buildDirectory, "production-schema.sql");
      await writeImmutableFile(schemaPath, schemaSql);
      schemaReceipt = {
        sha256: createHash("sha256").update(schemaSql).digest("hex"),
        bytes: Buffer.byteLength(schemaSql),
      };
    }

    const resolvedMigrationFiles =
      typeof migrationFiles === "function"
        ? await migrationFiles()
        : await migrationFiles;
    if (!Array.isArray(resolvedMigrationFiles)) {
      throw new Error("Rehearsal migration source must be an array.");
    }
    if (!/^[a-f0-9]{64}$/u.test(metadata.migrationHistorySha256 ?? "")) {
      throw new Error(
        "A Rehearsal baseline requires a migration-history SHA-256.",
      );
    }
    if (metadata.sourceMigrationHistory) {
      const migrationReceipt = createMigrationReplayReceipt({
        files: resolvedMigrationFiles as readonly MigrationSourceEntry[],
        ledger: metadata.sourceMigrationHistory,
      });
      if (migrationReceipt.historySha256 !== metadata.migrationHistorySha256) {
        throw new Error(
          "The Rehearsal baseline migration-history SHA-256 is invalid.",
        );
      }
    }
    const migrationDirectory = join(buildDirectory, "migrations");
    await mkdir(migrationDirectory, { mode: 0o700 });
    const migrationManifest: Record<string, { sha256: string }> = {};
    for (const migration of resolvedMigrationFiles) {
      if (
        !migration ||
        !migrationNamePattern.test(migration.filename) ||
        typeof migration.content !== "string" ||
        Object.hasOwn(migrationManifest, migration.filename)
      ) {
        throw new Error("A Rehearsal migration bundle entry is invalid.");
      }
      const contentHash = createHash("sha256")
        .update(migration.content)
        .digest("hex");
      if (migration.fileSha256 && migration.fileSha256 !== contentHash) {
        throw new Error(
          `Rehearsal migration source checksum mismatch for ${migration.filename}.`,
        );
      }
      await writeImmutableFile(
        join(migrationDirectory, migration.filename),
        migration.content,
      );
      migrationManifest[migration.filename] = { sha256: contentHash };
    }
    await chmod(migrationDirectory, 0o500);

    const assetManifest: Record<string, StorageAssetReceipt> = {};
    let totalAssetBytes = 0;
    for await (const asset of assets) {
      if (
        !asset ||
        typeof asset.bucket !== "string" ||
        typeof asset.objectPath !== "string" ||
        (!Buffer.isBuffer(asset.content) && !isByteStream(asset.content))
      ) {
        throw new Error("A Rehearsal Storage asset has an invalid shape.");
      }
      const relativePath = assetRelativePath(asset.bucket, asset.objectPath);
      if (Object.hasOwn(assetManifest, relativePath)) {
        throw new Error(`Duplicate Rehearsal Storage asset: ${relativePath}.`);
      }
      const target = assertInsideRoot(
        buildDirectory,
        join(buildDirectory, relativePath),
      );
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        const chunks = Buffer.isBuffer(asset.content)
          ? [asset.content]
          : asset.content;
        for await (const chunk of chunks) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          totalAssetBytes += buffer.length;
          if (
            bytes > maximumAssetBytes ||
            totalAssetBytes > maximumTotalAssetBytes
          ) {
            throw new Error(
              "The Rehearsal Storage asset boundary was exceeded.",
            );
          }
          hash.update(buffer);
          await handle.write(buffer);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(target, 0o400);
      assetManifest[relativePath] = {
        sha256: hash.digest("hex"),
        bytes,
        bucket: asset.bucket,
        objectPath: asset.objectPath,
        contentType: asset.contentType ?? "application/octet-stream",
      };
    }

    const manifest: BaselineManifest = {
      ...metadata,
      formatVersion: schemaReceipt ? 2 : 1,
      generationId,
      rowCount,
      tableCounts: Object.fromEntries([...tableCounts].sort()),
      files: {
        "sanitized-data.ndjson": {
          sha256: dataHash.digest("hex"),
          rows: rowCount,
        },
        ...(schemaReceipt ? { "production-schema.sql": schemaReceipt } : {}),
      },
      storageAssets: assetManifest,
      migrations: migrationManifest,
    };
    await writeImmutableFile(
      join(buildDirectory, "baseline-manifest.json"),
      canonicalJson(manifest),
    );
    await rename(buildDirectory, finalDirectory);
    finalCreated = true;
    await chmod(finalDirectory, 0o500);

    if (activate) {
      await activateBaselineGeneration({
        artifactRoot: root,
        generationId,
      });
    }
    return manifest;
  } catch (error) {
    let cleanupFailure: unknown;
    if (dataHandle) await dataHandle.close().catch(() => undefined);
    await makeArtifactTreeWritable(buildDirectory).catch(() => undefined);
    await rm(buildDirectory, { recursive: true, force: true }).catch(
      (cleanupError) => {
        cleanupFailure = cleanupError;
      },
    );
    if (finalCreated) {
      await makeArtifactTreeWritable(finalDirectory).catch(() => undefined);
      await rm(finalDirectory, { recursive: true, force: true }).catch(
        (cleanupError) => {
          cleanupFailure ??= cleanupError;
        },
      );
    }
    if (
      cleanupFailure &&
      error &&
      (typeof error === "object" || typeof error === "function")
    ) {
      try {
        Object.defineProperty(error, "cleanupError", {
          value: cleanupFailure,
          enumerable: false,
        });
      } catch {
        // Preserve the preparation failure even when its Error is immutable.
      }
    }
    throw error;
  }
};

export const activateBaselineGeneration = async ({
  artifactRoot,
  generationId,
}: {
  artifactRoot: string;
  generationId: string;
}): Promise<BaselineManifest> => {
  const root = assertArtifactRoot(artifactRoot);
  assertGenerationId(generationId);
  const generationDirectory = assertInsideRoot(
    root,
    join(root, generationsDirectoryName, generationId),
  );
  const manifest = parseManifest(
    await readFile(join(generationDirectory, "baseline-manifest.json"), "utf8"),
  );
  if (manifest.generationId !== generationId) {
    throw new Error(
      "The staged baseline identifier does not match its manifest.",
    );
  }
  const temporaryLink = assertInsideRoot(
    root,
    join(root, `.current-${randomBytes(4).toString("hex")}`),
  );
  await symlink(join(generationsDirectoryName, generationId), temporaryLink);
  await rename(temporaryLink, join(root, currentLinkName));
  return manifest;
};

export const removeStagedBaselineGeneration = async ({
  artifactRoot,
  generationId,
}: {
  artifactRoot: string;
  generationId: string;
}): Promise<void> => {
  const root = assertArtifactRoot(artifactRoot);
  assertGenerationId(generationId);
  try {
    const active = await resolveActiveBaselinePaths({ artifactRoot: root });
    if (basename(active.generationDirectory) === generationId) {
      throw new Error(
        "Refusing to remove the active Rehearsal baseline generation.",
      );
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const target = assertInsideRoot(
    root,
    join(root, generationsDirectoryName, generationId),
  );
  await verifyNoSymlink(target, "A staged Rehearsal baseline generation");
  await makeArtifactTreeWritable(target);
  await rm(target, { recursive: true, force: true });
};

export const resolveActiveBaselinePaths = async ({
  artifactRoot,
}: {
  artifactRoot: string;
}): Promise<ActiveBaselinePaths> => {
  const root = assertArtifactRoot(artifactRoot);
  const currentTarget = await readlink(join(root, currentLinkName));
  const generationDirectory = resolve(root, currentTarget);
  assertInsideRoot(root, generationDirectory);
  if (dirname(generationDirectory) !== join(root, generationsDirectoryName)) {
    throw new Error(
      "The active Rehearsal baseline points outside generations.",
    );
  }
  return {
    artifactRoot: root,
    generationDirectory,
    dataPath: join(generationDirectory, "sanitized-data.ndjson"),
    manifestPath: join(generationDirectory, "baseline-manifest.json"),
    migrationsDirectory: join(generationDirectory, "migrations"),
    schemaPath: join(generationDirectory, "production-schema.sql"),
  };
};

export const verifyActiveBaseline = async ({
  artifactRoot,
}: {
  artifactRoot: string;
}): Promise<BaselineManifest> => {
  const paths = await resolveActiveBaselinePaths({ artifactRoot });
  const { generationDirectory } = paths;
  const manifest = parseManifest(await readFile(paths.manifestPath, "utf8"));
  assertGenerationId(manifest.generationId);
  if (basename(generationDirectory) !== manifest.generationId) {
    throw new Error(
      "The active Rehearsal baseline identifier does not match its path.",
    );
  }
  const data = await readFile(paths.dataPath);
  const actualHash = createHash("sha256").update(data).digest("hex");
  if (actualHash !== manifest.files?.["sanitized-data.ndjson"]?.sha256) {
    throw new Error("The active Rehearsal baseline data checksum is invalid.");
  }
  if (manifest.files?.["production-schema.sql"]) {
    const schema = await readFile(paths.schemaPath);
    const receipt = manifest.files["production-schema.sql"];
    if (receipt === undefined || receipt.bytes === undefined) {
      throw new Error(
        "The active Rehearsal production schema receipt is invalid.",
      );
    }
    if (
      schema.length !== receipt.bytes ||
      createHash("sha256").update(schema).digest("hex") !== receipt.sha256
    ) {
      throw new Error(
        "The active Rehearsal production schema checksum is invalid.",
      );
    }
  }
  const migrationDirectory = paths.migrationsDirectory;
  const expectedMigrationNames = Object.keys(manifest.migrations ?? {}).sort();
  const actualMigrationNames = (await readdir(migrationDirectory)).sort();
  if (expectedMigrationNames.join("\0") !== actualMigrationNames.join("\0")) {
    throw new Error("The active Rehearsal migration bundle is not exact.");
  }
  for (const filename of expectedMigrationNames) {
    if (!migrationNamePattern.test(filename)) {
      throw new Error("The active Rehearsal migration manifest is invalid.");
    }
    const migrationHash = createHash("sha256")
      .update(await readFile(join(migrationDirectory, filename)))
      .digest("hex");
    if (migrationHash !== manifest.migrations[filename]?.sha256) {
      throw new Error(
        `The active Rehearsal migration checksum is invalid for ${filename}.`,
      );
    }
  }
  for (const [relativePath, receipt] of Object.entries(
    manifest.storageAssets ?? {},
  )) {
    if (
      relativePath !== assetRelativePath(receipt.bucket, receipt.objectPath)
    ) {
      throw new Error("The active Rehearsal Storage manifest path is invalid.");
    }
    const assetPath = assertInsideRoot(
      generationDirectory,
      join(generationDirectory, relativePath),
    );
    const asset = await readFile(assetPath);
    if (
      asset.length !== receipt.bytes ||
      createHash("sha256").update(asset).digest("hex") !== receipt.sha256
    ) {
      throw new Error(
        `The active Rehearsal Storage checksum is invalid for ${relativePath}.`,
      );
    }
  }
  return manifest;
};

export const listIncompleteBaselineBuilds = async ({
  artifactRoot,
}: {
  artifactRoot: string;
}): Promise<string[]> => {
  const root = assertArtifactRoot(artifactRoot);
  try {
    return (await readdir(root)).filter((name) => name.startsWith(buildPrefix));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
};

export const planBaselineGenerationPrune = async ({
  artifactRoot,
  retain = 2,
}: {
  artifactRoot: string;
  retain?: number;
}): Promise<BaselinePrunePlan> => {
  const root = assertArtifactRoot(artifactRoot);
  if (!Number.isSafeInteger(retain) || retain < 1) {
    throw new Error("Rehearsal baseline retention must be a positive integer.");
  }
  const active = await resolveActiveBaselinePaths({ artifactRoot: root });
  const generationsRoot = join(root, generationsDirectoryName);
  await verifyNoSymlink(generationsRoot, "The Rehearsal generations directory");
  const entries = await readdir(generationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !generationPattern.test(entry.name)
    ) {
      throw new Error(
        `Refusing to prune an unexpected Rehearsal generation entry: ${entry.name}`,
      );
    }
  }
  const activeName = basename(active.generationDirectory);
  const retained = new Set(
    [
      activeName,
      ...entries
        .map((entry) => entry.name)
        .sort()
        .reverse(),
    ]
      .filter((name, index, values) => values.indexOf(name) === index)
      .slice(0, retain),
  );
  const removed = entries
    .map((entry) => entry.name)
    .filter((name) => !retained.has(name))
    .sort();
  return { retained: [...retained], removed };
};

export const planBaselineReplacementPrune = async ({
  artifactRoot,
  retain = 2,
}: {
  artifactRoot: string;
  retain?: number;
}): Promise<{
  retainedAfterReplacement: string[];
  removedAfterReplacement: string[];
}> => {
  const root = assertArtifactRoot(artifactRoot);
  if (!Number.isSafeInteger(retain) || retain < 1) {
    throw new Error("Rehearsal baseline retention must be a positive integer.");
  }
  await resolveActiveBaselinePaths({ artifactRoot: root });
  const generationsRoot = join(root, generationsDirectoryName);
  await verifyNoSymlink(generationsRoot, "The Rehearsal generations directory");
  const entries = await readdir(generationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !generationPattern.test(entry.name)
    ) {
      throw new Error(
        `Refusing to plan replacement around an unexpected Rehearsal generation entry: ${entry.name}`,
      );
    }
  }
  const current = entries
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const retained = current.slice(0, Math.max(0, retain - 1));
  const retainedSet = new Set(retained);
  return {
    retainedAfterReplacement: retained,
    removedAfterReplacement: current
      .filter((name) => !retainedSet.has(name))
      .sort(),
  };
};

export const pruneBaselineGenerations = async ({
  artifactRoot,
  retain = 2,
  expectedRemoved,
}: {
  artifactRoot: string;
  retain?: number;
  expectedRemoved?: readonly string[];
}): Promise<BaselinePrunePlan> => {
  const root = assertArtifactRoot(artifactRoot);
  const plan = await planBaselineGenerationPrune({
    artifactRoot: root,
    retain,
  });
  const generationsRoot = join(root, generationsDirectoryName);
  if (
    expectedRemoved &&
    (expectedRemoved.length !== plan.removed.length ||
      expectedRemoved.some((name, index) => name !== plan.removed[index]))
  ) {
    throw new Error(
      "Rehearsal baseline generations changed after the cleanup preview.",
    );
  }
  for (const name of plan.removed) {
    const active = await resolveActiveBaselinePaths({ artifactRoot: root });
    if (basename(active.generationDirectory) === name) {
      throw new Error(
        "Refusing to prune the active Rehearsal baseline generation.",
      );
    }
    const target = assertInsideRoot(
      generationsRoot,
      join(generationsRoot, name),
    );
    await verifyNoSymlink(target, "A Rehearsal baseline generation");
    await makeArtifactTreeWritable(target);
    await rm(target, { recursive: true, force: true });
  }
  return plan;
};

export const removeBaselineArtifactRoot = async ({
  artifactRoot,
}: {
  artifactRoot: string;
}): Promise<void> => {
  const root = assertArtifactRoot(artifactRoot);
  await verifyNoSymlink(root, "The Rehearsal artifact root");
  await makeArtifactTreeWritable(root);
  await rm(root, { recursive: true, force: true });
};
