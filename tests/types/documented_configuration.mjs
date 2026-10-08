// @ts-check
import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
  schemaVersion: 1,
  project: { name: "example-postgresql-app" },
  postgresql: { migrationDirectory: "migrations" },
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
