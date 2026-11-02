/** Stable public facade for the versioned, fail-closed privacy pipeline. */

export { validateExecutablePrivacyPolicy } from "./privacy/privacy_policy.mjs";
export { createPrivacyEngine } from "./privacy/privacy_pipeline.mjs";
export {
  assertPrivacyKeyFingerprint,
  createPrivacyKey,
  readPrivacyKey,
} from "./privacy/privacy_key.mjs";
export type {
  ExecutablePrivacyPolicy,
  PrivacyColumn,
  PrivacyEngine,
  PrivacyForeignKey,
  PrivacySourceRecord,
  PrivacyTable,
} from "./privacy/privacy_policy.mjs";
