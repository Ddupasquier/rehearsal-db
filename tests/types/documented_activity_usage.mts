import type {
  ApplicationActivitySample,
  RehearsalConfig,
} from "@rehearsal-db/core";

export const idleApplication = {
  startCommand: "npm run dev",
  proofCommand: "npm test",
  readiness: { url: "http://localhost:5175/health", expectedStatus: 200 },
  activity: { url: "http://localhost:5175/rehearsal-activity" },
} satisfies RehearsalConfig["application"];

export const idleLifecycle = {
  open: "stop-on-application-exit",
  openIdleTimeoutSeconds: 900,
} satisfies NonNullable<RehearsalConfig["lifecycle"]>;

export const activityResponse = {
  schemaVersion: 1,
  busy: false,
  activitySequence: 12,
} satisfies ApplicationActivitySample;
