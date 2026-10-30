/** Read-only exact Kit/ORM/pg resolution and complete runtime dependency fingerprint. */
import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DrizzleMigrationTool } from "../project/configuration_migration_tool.mjs";
import { inspectNativeToolchain } from "./native_toolchain.mjs";
const invalid = () =>
  new Error(
    "Drizzle requires exact local Kit 0.31.11, ORM 0.45.4 and pg 8.23.1 resolved from Kit plus direct esbuild 0.25.x at patch 4 or later; no install, download or fallback was attempted.",
  );
export const inspectDrizzleToolchain = async ({
  projectRoot,
  tool,
}: {
  projectRoot: string;
  tool: DrizzleMigrationTool;
}) => {
  try {
    const root = await realpath(projectRoot),
      kit = resolve(root, tool.packageDirectory),
      orm = resolve(root, tool.ormPackageDirectory),
      pg = resolve(root, tool.driverPackageDirectory);
    const resolver = createRequire(join(kit, "bin.cjs"));
    const packageRoot = async (name: string) => {
      const search = resolver.resolve.paths(name);
      if (!search || search.length > 128) throw invalid();
      for (const parent of search) {
        const candidate = join(parent, name);
        try {
          const stat = await lstat(candidate);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (await realpath(candidate)) !== candidate
          )
            throw invalid();
          const local = relative(root, candidate);
          if (
            !local ||
            local === ".." ||
            local.startsWith(`..${sep}`) ||
            isAbsolute(local)
          )
            throw invalid();
          return candidate;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      throw invalid();
    };
    const esbuild = await packageRoot("esbuild");
    const selected = async (name: string, expected: string, entry: string) => {
      for (const parent of resolver.resolve.paths(name) ?? []) {
        const candidate = join(parent, name);
        try {
          const stat = await lstat(candidate);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (await realpath(candidate)) !== expected
          )
            throw invalid();
          const path = await realpath(resolver.resolve(entry)),
            local = relative(expected, path);
          if (
            !local ||
            local === ".." ||
            local.startsWith(`..${sep}`) ||
            isAbsolute(local)
          )
            throw invalid();
          return path;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      throw invalid();
    };
    const refuseFallbacks = async () => {
      for (const name of [
        "postgres",
        "@vercel/postgres",
        "@neondatabase/serverless",
      ]) {
        for (const parent of resolver.resolve.paths(name) ?? []) {
          try {
            await lstat(join(parent, name));
            throw invalid();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
    };
    await refuseFallbacks();
    const before = [
      await selected("pg", pg, "pg"),
      await selected("drizzle-orm", orm, "drizzle-orm/node-postgres/migrator"),
      await selected("esbuild", esbuild, "esbuild"),
    ];
    const result = await inspectNativeToolchain({
      projectRoot: root,
      profiles: [
        {
          label: "kit",
          directory: tool.packageDirectory,
          name: "drizzle-kit",
          version: "0.31.11",
          bin: { key: "drizzle-kit", value: "./bin.cjs" },
        },
        {
          label: "orm",
          directory: tool.ormPackageDirectory,
          name: "drizzle-orm",
          version: "0.45.4",
        },
        {
          label: "driver",
          directory: tool.driverPackageDirectory,
          name: "pg",
          version: "8.23.1",
        },
        {
          label: "esbuild",
          directory: relative(root, esbuild),
          name: "esbuild",
          version: (version: unknown) =>
            typeof version === "string" &&
            version.length <= 64 &&
            /^0\.25\.(?:[4-9]|[1-9][0-9]+)$/u.test(version),
        },
      ],
    });
    await refuseFallbacks();
    const after = [
      await selected("pg", pg, "pg"),
      await selected("drizzle-orm", orm, "drizzle-orm/node-postgres/migrator"),
      await selected("esbuild", esbuild, "esbuild"),
    ];
    if (JSON.stringify(before) !== JSON.stringify(after)) throw invalid();
    return Object.freeze({
      sha256: result.sha256,
      cliPath: result.entrypoints.get("kit")!.cliPath!,
    });
  } catch {
    throw invalid();
  }
};
