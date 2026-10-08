/** Stable public facade for the versioned, fail-closed privacy pipeline. */

export { validateExecutablePrivacyPolicy } from "./privacy_policy.mjs";
export { createPrivacyEngine } from "./privacy_pipeline.mjs";
export {
  assertPrivacyKeyFingerprint,
  createPrivacyKey,
  readPrivacyKey,
} from "./privacy_key.mjs";
export type {
  ExecutablePrivacyPolicy,
  PrivacyColumn,
  PrivacyEngine,
  PrivacyForeignKey,
  PrivacySourceRecord,
  PrivacyTable,
} from "./privacy_policy.mjs";
