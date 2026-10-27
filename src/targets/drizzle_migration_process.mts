/** Execute pinned Kit migrate, never a project-owned executable config or schema. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readDrizzleMigrationInventory } from "../runtime/drizzle_history.mjs";
import { inspectDrizzleToolchain } from "../runtime/drizzle_toolchain.mjs";
import {
  parseNativeMigrationBinding,
  type NativeMigrationBinding,
} from "../runtime/native_migration_contract.mjs";
import {
  drizzleMigrationFiles,
  type DrizzleMigrationFileEntry,
} from "../runtime/migration_identity.mjs";
import type { DrizzleMigrationTool } from "../project/configuration_migration_tool.mjs";
import { deployNativeMigrations } from "./native_migration_process.mjs";
export const deployDrizzleMigrations = async (options: {
  projectRoot: string;
  tool: DrizzleMigrationTool;
  directory: string;
  runtimeWorkdir: string;
  entries: readonly DrizzleMigrationFileEntry[];
  binding: NativeMigrationBinding;
  databaseUrl: string;
  assertOwnedTarget: () => string;
  assertExpectedBaseline: () => Promise<void>;
}) => {
  const binding = parseNativeMigrationBinding(options.binding);
  if (binding.kind !== "drizzle")
    throw new Error("Drizzle execution requires its exact native binding.");
  return deployNativeMigrations({
    ...options,
    binding,
    recipe: {
      label: "Drizzle Kit migrate",
      prefix: ".drizzle-migrate-",
      preparedInputs: [
        [
          "drizzle.config.cjs",
          'module.exports = { dialect: "postgresql", out: "./migrations", dbCredentials: { url: process.env.REHEARSAL_NATIVE_DATABASE_URL }, migrations: { schema: "drizzle", table: "__drizzle_migrations" } };\n',
        ],
        [".env", ""],
        ["tsconfig.json", '{"compilerOptions":{}}\n'],
      ],
      read: async (directory, onBytes) => {
        const x = await readDrizzleMigrationInventory(
          pathToFileURL(`${directory}/`),
          onBytes ? { onBytes } : {},
        );
        return {
          entries: drizzleMigrationFiles(x.entries),
          binding: parseNativeMigrationBinding({
            ...x.binding,
            driver: "pg",
            driverVersion: "8.23.1",
            toolchainSha256: "0".repeat(64),
          }),
        };
      },
      inspect: () =>
        inspectDrizzleToolchain({
          projectRoot: options.projectRoot,
          tool: options.tool,
        }),
      args: (cliPath, workspace) => [
        cliPath,
        "migrate",
        "--config",
        join(workspace, "drizzle.config.cjs"),
      ],
      environment: (workspace) => ({
        DOTENV_CONFIG_PATH: join(workspace, ".env"),
        TSX_TSCONFIG_PATH: join(workspace, "tsconfig.json"),
        TSX_DISABLE_CACHE: "1",
      }),
    },
  });
};
