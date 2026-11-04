import {
  defineRehearsalConfig,
  type NormalizedRehearsalConfig,
  type RehearsalConfig,
} from "@rehearsal-db/core";

const supabaseConfig = defineRehearsalConfig({
  schemaVersion: 1,
  project: { name: "typecheck-supabase" },
  supabase: {
    workdir: "supabase",
    migrationDirectory: "supabase/migrations",
    rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml",
    runtimeWorkdir: ".rehearsal/runtime/supabase",
  },
  baseline: {
    sanitizationPolicy: "rehearsal/sanitization-policy.json",
  },
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm test",
  },
  runtime: {
    target: "supabase",
    databasePort: 54322,
  },
});

const postgresqlConfig = defineRehearsalConfig({
  schemaVersion: 1,
  project: { name: "typecheck-postgresql" },
  postgresql: {
    migrationDirectory: "migrations",
  },
  baseline: {
    sanitizationPolicy: "rehearsal/sanitization-policy.json",
  },
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm test",
  },
  runtime: {
    target: "postgresql",
    databasePort: 55432,
  },
});

const sqliteConfig = defineRehearsalConfig({
  schemaVersion: 1,
  project: { name: "typecheck-sqlite" },
  runtime: { target: "sqlite", projectId: "sqlite-typecheck" },
  sqlite: { sourceDatabase: "source.sqlite", migrationDirectory: "migrations" },
  baseline: { sanitizationPolicy: "sqlite-policy.json" },
  application: { startCommand: "node app.mjs", proofCommand: "node proof.mjs" },
});
// @ts-expect-error Embedded SQLite configurations cannot declare a server port.
const invalidSqlitePort: RehearsalConfig["runtime"] = {
  target: "sqlite",
  databasePort: 5432,
};
void invalidSqlitePort;
const publicConfigurations: readonly RehearsalConfig[] = [
  supabaseConfig,
  postgresqlConfig,
  sqliteConfig,
];

void publicConfigurations;

const normalizedDatabasePort = (
  config: NormalizedRehearsalConfig,
): number | null => config.runtime.ports.database ?? null;

void normalizedDatabasePort;
