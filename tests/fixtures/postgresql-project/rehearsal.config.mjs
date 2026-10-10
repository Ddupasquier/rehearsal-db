import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
  schemaVersion: 1,
  project: { name: "rehearsal-postgresql-fixture" },
  postgresql: {
    migrationDirectory: "database/migrations",
    runtimeWorkdir: ".rehearsal/runtime",
    image: "postgres:17-alpine",
    database: "postgres",
    user: "postgres",
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "rehearsal/sanitization-policy.json",
  },
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm run proof",
  },
  runtime: {
    target: "postgresql",
    applicationUrl: "http://localhost:5275",
    projectId: "rehearsal-postgresql-fixture",
    databasePort: 59422,
  },
  safety: {
    hostedAccess: "disabled",
    outboundNetwork: "deny",
  },
});
