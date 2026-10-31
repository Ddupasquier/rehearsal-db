import { readDrizzleMigrationInventory } from "./drizzle_history.mjs";
import { inspectDrizzleToolchain } from "./drizzle_toolchain.mjs";
import { drizzleMigrationFiles } from "./migration_identity.mjs";
/** Select native inventory only through explicit reviewed PostgreSQL configuration. */
import type { loadRehearsalConfig } from "../project/configuration.mjs";
import { pathToFileURL } from "node:url";
import { readMigrationFileInventory } from "./migration_history.mjs";
import { readPrismaMigrationInventory } from "./prisma_history.mjs";
import { inspectPrismaToolchain } from "./prisma_toolchain.mjs";
import { parseNativeMigrationBinding } from "./native_migration_contract.mjs";
type LoadedRehearsalConfig = Awaited<ReturnType<typeof loadRehearsalConfig>>;

export const readConfiguredMigrationSource = async (
  loaded: Pick<LoadedRehearsalConfig, "config" | "projectRoot" | "paths">,
  inventoryReader = readMigrationFileInventory,
) => {
  const directory = pathToFileURL(`${loaded.paths.migrationDirectory}/`);
  const tool = loaded.config.postgresql?.migrationTool;
  if (!tool)
    return { entries: await inventoryReader(directory), binding: null };
  if (tool.kind === "drizzle") {
    const nativeReader = (
      inventoryReader as typeof inventoryReader & {
        readDrizzle?: typeof readDrizzleMigrationInventory;
      }
    ).readDrizzle;
    if (inventoryReader !== readMigrationFileInventory && !nativeReader)
      throw new Error(
        "This optional inspector is not qualified for native Drizzle histories.",
      );
    const [inventory, toolchain] = await Promise.all([
      (nativeReader ?? readDrizzleMigrationInventory)(directory),
      inspectDrizzleToolchain({ projectRoot: loaded.projectRoot, tool }),
    ]);
    return {
      entries: drizzleMigrationFiles(inventory.entries),
      binding: parseNativeMigrationBinding({
        ...inventory.binding,
        driver: "pg",
        driverVersion: "8.23.1",
        toolchainSha256: toolchain.sha256,
      }),
    };
  }
  const nativeReader = (
    inventoryReader as typeof inventoryReader & {
      readPrisma?: typeof readPrismaMigrationInventory;
    }
  ).readPrisma;
  if (inventoryReader !== readMigrationFileInventory && !nativeReader)
    throw new Error(
      "Optional SQL Insights/impact analysis is not yet qualified for native Prisma histories. Use the native migration review and rehearsal instead.",
    );
  const [inventory, toolchain] = await Promise.all([
    (nativeReader ?? readPrismaMigrationInventory)(directory),
    inspectPrismaToolchain({
      projectRoot: loaded.projectRoot,
      packageDirectory: tool.packageDirectory,
    }),
  ]);
  return {
    entries: inventory.entries,
    binding: parseNativeMigrationBinding({
      ...inventory.binding,
      toolchainSha256: toolchain.sha256,
    }),
  };
};
