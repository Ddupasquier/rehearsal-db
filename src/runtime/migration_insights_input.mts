/** Exact, bounded project-local SQL input. Contents never enter public findings. */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMigrationFileInventory } from "./migration_history.mjs";
import { readPrismaMigrationInventory } from "./prisma_history.mjs";
import { RehearsalError } from "../shared/diagnostics.mjs";
import {
  holdPathAncestry,
  type HeldPathAncestry,
} from "../shared/held_path_ancestry.mjs";

export const MIGRATION_INSIGHTS_LIMITS = Object.freeze({
  maximumFiles: 10000,
  maximumDirectoryEntries: 10000,
  maximumCandidates: 1000,
  maximumFileBytes: 2 * 1024 * 1024,
  maximumTotalBytes: 16 * 1024 * 1024,
  maximumFindings: 5000,
});

const inside = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return !value.startsWith("..") && !isAbsolute(value);
};
const inputError = () =>
  new RehearsalError({
    category: "configuration_invalid",
    code: "CONFIGURATION_INVALID",
    message:
      "Migration Insights requires bounded, unchanged regular SQL files inside the project; symlinks and unsafe filenames are refused.",
    refused: "No SQL was executed and no database or engine was contacted.",
    suggestions: [
      "Review project-local migration files and the documented Insights input limits, then request a fresh inspection.",
    ],
  });

export const createMigrationInsightsInput = (projectRoot: string) => {
  const contents = new Map<string, { sha256: string; text: string }>();
  let totalBytes = 0;
  let totalFiles = 0;
  const readInventory: typeof readMigrationFileInventory = async (
    directory,
  ) => {
    let ancestry: HeldPathAncestry | undefined;
    try {
      const lexicalRoot = resolve(projectRoot);
      const lexicalDirectory = resolve(fileURLToPath(directory));
      if (!inside(lexicalRoot, lexicalDirectory)) throw inputError();
      const root = await realpath(lexicalRoot);
      const canonicalDirectory = await realpath(lexicalDirectory);
      if (
        canonicalDirectory !==
        resolve(root, relative(lexicalRoot, lexicalDirectory))
      )
        throw inputError();
      const held = await holdPathAncestry(canonicalDirectory);
      ancestry = held;
      await held.assertUnchanged();
      const parentBefore = await lstat(canonicalDirectory);
      if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink())
        throw inputError();
      const inventory = await readMigrationFileInventory(
        pathToFileURL(`${held.path}${sep}`),
        {
          maximumFiles: MIGRATION_INSIGHTS_LIMITS.maximumFiles,
          maximumDirectoryEntries:
            MIGRATION_INSIGHTS_LIMITS.maximumDirectoryEntries,
          readBytes: async (url, filename) => {
            if (
              ++totalFiles > MIGRATION_INSIGHTS_LIMITS.maximumFiles ||
              Buffer.byteLength(filename) > 255 ||
              /[\\/%:#?\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(
                filename,
              )
            )
              throw inputError();
            const suppliedPath = fileURLToPath(url);
            if (
              suppliedPath !== join(held.path, filename) ||
              basename(suppliedPath) !== filename
            )
              throw inputError();
            // Read through the canonical directory, never a caller's root alias.
            const path = join(canonicalDirectory, filename);
            try {
              await held.assertUnchanged();
              const leafBefore = await lstat(path);
              if (!leafBefore.isFile() || leafBefore.isSymbolicLink())
                throw inputError();
              const handle = await open(
                path,
                constants.O_RDONLY |
                  constants.O_NOFOLLOW |
                  constants.O_NONBLOCK,
              );
              try {
                const before = await handle.stat();
                if (
                  !before.isFile() ||
                  before.dev !== leafBefore.dev ||
                  before.ino !== leafBefore.ino ||
                  before.size > MIGRATION_INSIGHTS_LIMITS.maximumFileBytes ||
                  totalBytes + before.size >
                    MIGRATION_INSIGHTS_LIMITS.maximumTotalBytes
                )
                  throw inputError();
                const buffer = Buffer.alloc(before.size + 1);
                let offset = 0;
                while (offset < buffer.length) {
                  const { bytesRead } = await handle.read(
                    buffer,
                    offset,
                    buffer.length - offset,
                    offset,
                  );
                  if (!bytesRead) break;
                  offset += bytesRead;
                }
                const after = await handle.stat();
                const leafAfter = await lstat(path);
                const parentAfter = await lstat(canonicalDirectory);
                if (
                  offset !== before.size ||
                  before.dev !== after.dev ||
                  before.ino !== after.ino ||
                  before.size !== after.size ||
                  before.mtimeMs !== after.mtimeMs ||
                  before.ctimeMs !== after.ctimeMs ||
                  !leafAfter.isFile() ||
                  leafAfter.isSymbolicLink() ||
                  before.dev !== leafAfter.dev ||
                  before.ino !== leafAfter.ino ||
                  before.ctimeMs !== leafAfter.ctimeMs ||
                  parentAfter.isSymbolicLink() ||
                  parentBefore.dev !== parentAfter.dev ||
                  parentBefore.ino !== parentAfter.ino ||
                  (await realpath(dirname(path))) !== canonicalDirectory
                )
                  throw inputError();
                await held.assertUnchanged();
                const bytes = buffer.subarray(0, offset);
                const text = new TextDecoder("utf-8", { fatal: true }).decode(
                  bytes,
                );
                const sha256 = createHash("sha256").update(bytes).digest("hex");
                const prior = contents.get(path);
                if (prior && prior.sha256 !== sha256) throw inputError();
                totalBytes += offset;
                contents.set(path, { sha256, text });
                return bytes;
              } finally {
                await handle.close();
              }
            } catch {
              throw inputError();
            }
          },
        },
      );
      await held.assertUnchanged();
      return inventory;
    } catch {
      throw inputError();
    } finally {
      try {
        await ancestry?.close();
      } catch {
        throw inputError();
      }
    }
  };
  return {
    readInventory: Object.assign(readInventory, {
      readPrisma: async (directory: URL) => {
        const root = await realpath(projectRoot);
        const path = resolve(fileURLToPath(directory));
        if (!inside(root, path) || (await realpath(path)) !== path)
          throw inputError();
        return readPrismaMigrationInventory(directory, {
          onBytes: (filename, bytes) => {
            if (filename === "migration_lock.toml") return;
            if (
              ++totalFiles > MIGRATION_INSIGHTS_LIMITS.maximumFiles ||
              bytes.length > MIGRATION_INSIGHTS_LIMITS.maximumFileBytes ||
              totalBytes + bytes.length >
                MIGRATION_INSIGHTS_LIMITS.maximumTotalBytes
            )
              throw inputError();
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              bytes,
            );
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const key = join(path, filename);
            const prior = contents.get(key);
            if (prior && prior.sha256 !== sha256) throw inputError();
            totalBytes += bytes.length;
            contents.set(key, { sha256, text });
          },
        });
      },
    }),
    sourceFor: (path: string, sha256: string): string | undefined => {
      const retained = contents.get(resolve(path));
      return retained?.sha256 === sha256 ? retained.text : undefined;
    },
  };
};
