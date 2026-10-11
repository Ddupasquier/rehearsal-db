/** Public Rehearsal package entry point. */

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
