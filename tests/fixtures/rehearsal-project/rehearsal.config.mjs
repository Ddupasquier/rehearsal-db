export default {
  schemaVersion: 1,
  project: { name: "rehearsal-fixture-project" },
  supabase: {
    workdir: ".",
    migrationDirectory: "supabase/migrations",
    rehearsalConfig: "supabase/config.toml",
    runtimeWorkdir: ".rehearsal/runtime",
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "rehearsal/sanitization-policy.json",
  },
  runtimePolicy: "rehearsal/runtime-policy.json",
  identityPolicy: "rehearsal/identity-policy.json",
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm run proof",
    readiness: {
      url: "http://127.0.0.1:5275",
      expectedStatus: 200,
      timeoutSeconds: 10,
    },
  },
  runtime: {
    target: "supabase",
    applicationUrl: "http://localhost:5275",
    projectId: "rehearsal-fixture",
    apiPort: 59321,
    databasePort: 59322,
    studioPort: 59323,
  },
  safety: {
    hostedAccess: "disabled",
    outboundNetwork: "deny",
  },
};
