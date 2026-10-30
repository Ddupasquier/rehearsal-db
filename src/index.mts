/** Public Rehearsal package entry point. */
export type { ApplicationActivitySample } from "./application/activity_contract.mjs";

export {
  REHEARSAL_CONFIG_VERSION,
  defineRehearsalConfig,
  discoverProjectProfile,
  findRehearsalConfigPath,
  inspectDetectedProject,
  PROJECT_DISCOVERY_SCHEMA_VERSION,
  loadRehearsalConfig,
  renderDetectedConfig,
  renderDetectedPostgresqlConfig,
} from "./project/configuration.mjs";
export type {
  ApplicationRequiredService,
  DetectedProject,
  DecisionDiscoveryItem,
  DetectedDiscoveryItem,
  DiscoveredConfigurationField,
  DiscoveryConfidence,
  DiscoveryEvidence,
  DiscoveryValue,
  NormalizedRehearsalConfig,
  ProjectDiscoveryResult,
  RehearsalConfig,
  RehearsalResourcePolicy,
  RehearsalConfigPathOptions,
  RehearsalConfigVersion,
} from "./project/configuration.mjs";
export {
  EXCLUDED_VALUE,
  SANITIZATION_ACTIONS,
  applySanitizationAction,
  normalizeSanitizationAction,
  readBoundRuntimeSanitizationPolicy,
  validateSanitizationCoverage,
  validateRuntimeSanitizationPolicy,
} from "./baseline/sanitization_policy.mjs";
export type {
  MigrationCutoff,
  DrizzleMigrationIdentity,
} from "./runtime/migration_identity.mjs";
export type {
  NativeMigrationTool,
  DrizzleMigrationTool,
} from "./project/configuration_migration_tool.mjs";
