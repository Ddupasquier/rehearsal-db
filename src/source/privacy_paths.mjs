/** Coordinate private source prefixes with reviewed privacy path mappings. */

import { validateExecutablePrivacyPolicy } from "../baseline/privacy_engine.mjs";
import { validateSourceAccessPolicy } from "./access.mjs";

export const resolvePrivacyMappedAssets = ({
  sourcePolicy,
  privacyPolicy,
  environment = process.env,
}) => {
  const source = validateSourceAccessPolicy(sourcePolicy);
  const privacy = validateExecutablePrivacyPolicy(privacyPolicy);

  return Object.freeze(
    source.assets.map((asset) => {
      if (!asset.pathMapping) return asset;
      const mapping = privacy.pathMappings[asset.pathMapping];
      if (!mapping) {
        throw new Error(
          `Storage asset references unknown privacy path mapping ${asset.pathMapping}.`,
        );
      }
      const binding = privacy.bindings[mapping.binding];
      if (binding.environmentVariable !== asset.prefixEnvironmentVariable) {
        throw new Error(
          `Storage asset ${asset.bucket} must use the environment variable reviewed by privacy path mapping ${asset.pathMapping}.`,
        );
      }
      const prefix = environment[asset.prefixEnvironmentVariable];
      if (typeof prefix !== "string" || !prefix) {
        throw new Error(
          `Storage asset ${asset.bucket} requires ${asset.prefixEnvironmentVariable}.`,
        );
      }
      return Object.freeze({ ...asset, prefix });
    }),
  );
};
