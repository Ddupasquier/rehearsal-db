/**
 * Stable public facade for Rehearsal configuration. Implementation concerns
 * live in focused modules so callers keep one compatible import path.
 */

export {
  defineRehearsalConfig,
  REHEARSAL_CONFIG_VERSION,
  REHEARSAL_DEFAULTS,
} from "./configuration_contract.mjs";
export type {
  RehearsalConfig,
  RehearsalConfigVersion,
} from "./configuration_contract.mjs";
export { findRehearsalConfigPath } from "./configuration_discovery.mjs";
export type { RehearsalConfigPathOptions } from "./configuration_discovery.mjs";
export { loadRehearsalConfig } from "./configuration_resolution.mjs";
export type { NormalizedRehearsalConfig } from "./configuration_resolution.mjs";
export { inspectDetectedProject } from "./project_detection.mjs";
export type { DetectedProject } from "./project_detection.mjs";
export {
  renderDetectedConfig,
  renderDetectedPostgresqlConfig,
} from "./configuration_rendering.mjs";
