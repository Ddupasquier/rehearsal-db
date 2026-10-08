import {
  defineRehearsalConfig,
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

const publicConfigurations: readonly RehearsalConfig[] = [
  supabaseConfig,
  postgresqlConfig,
];

void publicConfigurations;
