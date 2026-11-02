/**
 * Stable public facade for Rehearsal configuration. Implementation concerns
 * live in focused modules so callers keep one compatible import path.
 */

export {
  defineRehearsalConfig,
  REHEARSAL_CONFIG_VERSION,
  REHEARSAL_DEFAULTS,
} from "./configuration/configuration_contract.mjs";
export type {
  ApplicationRequiredService,
  RehearsalResourcePolicy,
  RehearsalConfig,
  RehearsalConfigVersion,
} from "./configuration/configuration_contract.mjs";
export { findRehearsalConfigPath } from "./configuration/configuration_discovery.mjs";
export type { RehearsalConfigPathOptions } from "./configuration/configuration_discovery.mjs";
export { loadRehearsalConfig } from "./configuration/configuration_resolution.mjs";
export type { NormalizedRehearsalConfig } from "./configuration/configuration_resolution.mjs";
export { inspectDetectedProject } from "./discovery/project_detection.mjs";
export type { DetectedProject } from "./discovery/project_detection.mjs";
export {
  discoverProjectProfile,
  probeContainerEngineWithoutStarting,
  PROJECT_DISCOVERY_SCHEMA_VERSION,
} from "./project_discovery.mjs";
export type {
  ContainerEngineProbe,
  DecisionDiscoveryItem,
  DetectedDiscoveryItem,
  DiscoveredConfigurationField,
  DiscoveryConfidence,
  DiscoveryEvidence,
  DiscoveryValue,
  ProjectDiscoveryResult,
  SuggestedDiscoveryItem,
} from "./project_discovery.mjs";
export {
  renderDetectedConfig,
  renderDetectedPostgresqlConfig,
} from "./configuration/configuration_rendering.mjs";
