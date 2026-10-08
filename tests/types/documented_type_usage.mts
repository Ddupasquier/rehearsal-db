import type {
  RehearsalConfig,
  RehearsalConfigVersion,
} from "@rehearsal-db/core";

export const schemaVersion: RehearsalConfigVersion = 1;

export const application = {
  startCommand: "npm run dev",
  proofCommand: "npm test",
} satisfies RehearsalConfig["application"];
