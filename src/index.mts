/** Public Rehearsal package entry point. */

export {
  REHEARSAL_CONFIG_VERSION,
  defineRehearsalConfig,
  findRehearsalConfigPath,
  inspectDetectedProject,
  loadRehearsalConfig,
  renderDetectedConfig,
  renderDetectedPostgresqlConfig,
} from "./project/configuration.mjs";
export type {
  DetectedProject,
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
