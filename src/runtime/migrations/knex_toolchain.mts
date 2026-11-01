/** Exact local Knex/pg resolution and complete copied runtime dependency closure. */
import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { inspectNativeToolchain } from "./native_toolchain.mjs";
export interface KnexToolchainSelection {
  readonly packageDirectory: string;
  readonly driverPackageDirectory: string;
}
const invalid = () =>
  new Error(
    "Isolated Knex requires exact regular project-local Knex 3.3.0 and its resolved pg 8.23.1 dependency closure; no code, install or fallback was attempted.",
  );
export const inspectKnexToolchain = async ({
  projectRoot,
  tool,
  onBytes,
}: {
  projectRoot: string;
  tool: KnexToolchainSelection;
  onBytes?: (path: string, bytes: Buffer) => Promise<void> | void;
}) => {
  try {
    const root = await realpath(projectRoot),
      knex = resolve(root, tool.packageDirectory),
      pg = resolve(root, tool.driverPackageDirectory);
    const resolution = async () => {
      const resolver = createRequire(
        join(knex, "lib", "dialects", "postgres", "index.js"),
      );
      const entry = await realpath(resolver.resolve("pg"));
      const rel = relative(pg, entry);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw invalid();
      for (const parent of resolver.resolve.paths("pg") ?? []) {
        const path = join(parent, "pg");
        try {
          const stat = await lstat(path);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (await realpath(path)) !== pg
          )
            throw invalid();
          return entry;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      throw invalid();
    };
    const before = await resolution();
    const result = await inspectNativeToolchain({
      projectRoot: root,
      profiles: [
        {
          label: "knex",
          directory: tool.packageDirectory,
          name: "knex",
          version: "3.3.0",
        },
        {
          label: "driver",
          directory: tool.driverPackageDirectory,
          name: "pg",
          version: "8.23.1",
        },
      ],
      ...(onBytes ? { onBytes } : {}),
    });
    if ((await resolution()) !== before) throw invalid();
    return Object.freeze({
      sha256: result.sha256,
      knexDirectory: knex,
      driverDirectory: pg,
    });
  } catch {
    throw invalid();
  }
};
