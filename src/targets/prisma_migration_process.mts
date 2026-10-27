/** Prisma recipe for the shared bounded owned-target native process boundary. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readPrismaMigrationInventory } from "../runtime/prisma_history.mjs";
import { inspectPrismaToolchain } from "../runtime/prisma_toolchain.mjs";
import {
  parseNativeMigrationBinding,
  type NativeMigrationBinding,
} from "../runtime/native_migration_contract.mjs";
import type { MigrationFileEntry } from "../runtime/migration_history.mjs";
import { deployNativeMigrations } from "./native_migration_process.mjs";
export const deployPrismaMigrations = async (options: {
  projectRoot: string;
  packageDirectory: string;
  directory: string;
  runtimeWorkdir: string;
  entries: readonly MigrationFileEntry[];
  binding: NativeMigrationBinding;
  databaseUrl: string;
  assertOwnedTarget: () => string;
  assertExpectedBaseline: () => Promise<void>;
}) => {
  const binding = parseNativeMigrationBinding(options.binding);
  if (binding.kind !== "prisma")
    throw new Error("Prisma execution requires its exact native binding.");
  return deployNativeMigrations({
    ...options,
    binding,
    recipe: {
      label: "Prisma Migrate",
      prefix: ".prisma-deploy-",
      preparedInputs: [
        ["schema.prisma", 'datasource db {\n  provider = "postgresql"\n}\n'],
        [
          "prisma.config.ts",
          'export default { schema: "./schema.prisma", migrations: { path: "./migrations" }, datasource: { url: process.env.REHEARSAL_NATIVE_DATABASE_URL } };\n',
        ],
      ],
      read: async (directory, onBytes) => {
        const x = await readPrismaMigrationInventory(
          pathToFileURL(`${directory}/`),
          onBytes ? { onBytes } : {},
        );
        return {
          entries: x.entries,
          binding: parseNativeMigrationBinding({
            ...x.binding,
            toolchainSha256: "0".repeat(64),
          }),
        };
      },
      inspect: () =>
        inspectPrismaToolchain({
          projectRoot: options.projectRoot,
          packageDirectory: options.packageDirectory,
        }),
      args: (cliPath, workspace) => [
        cliPath,
        "migrate",
        "deploy",
        "--config",
        join(workspace, "prisma.config.ts"),
      ],
      environment: (_workspace, cache, toolchain) => ({
        PRISMA_SCHEMA_ENGINE_BINARY: toolchain.enginePath!,
        CHECKPOINT_DISABLE: "1",
        PRISMA_HIDE_UPDATE_MESSAGE: "1",
        PRISMA_SKIP_POSTINSTALL_GENERATE: "1",
        JITI_CACHE_DIR: cache,
      }),
    },
  });
};
