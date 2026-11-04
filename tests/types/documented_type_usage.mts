import type {
  NormalizedRehearsalConfig,
  ProjectDiscoveryResult,
  RehearsalConfig,
  RehearsalConfigVersion,
} from "@rehearsal-db/core";

export const schemaVersion: RehearsalConfigVersion = 1;

export const application = {
  startCommand: "npm run dev",
  proofCommand: "npm test",
} satisfies RehearsalConfig["application"];

export const localDatabasePort = (
  config: NormalizedRehearsalConfig,
): number | null => config.runtime.ports.database ?? null;

export const unresolvedChoices = (profile: ProjectDiscoveryResult): number =>
  profile.decisions.length;
