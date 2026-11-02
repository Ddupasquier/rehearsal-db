/** Named selections contain only existing target names and safe application URLs. */

import {
  assertLoopbackUrl,
  assertNonEmptyString,
  type PlainObject,
} from "./configuration_validation.mjs";
import { assertApplicationPortDoesNotOverlap } from "./configuration_application_urls.mjs";

export const normalizeConfigurationProfiles = ({
  profiles,
  targetNames,
  allowedHosts,
  servicePorts,
}: {
  readonly profiles: readonly PlainObject[];
  readonly targetNames: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly servicePorts: readonly number[];
}) => {
  const names = new Set<string>();
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  return Object.freeze(
    profiles.map((profile, index) => {
      const path = `config.profiles[${index}]`;
      const name = assertNonEmptyString(profile.name, `${path}.name`);
      if (name.length > 80 || /[\r\n\0]/u.test(name) || names.has(name)) {
        throw new Error(
          `${path}.name must be unique, single-line text of at most 80 characters.`,
        );
      }
      names.add(name);
      const targets = profile.targets;
      if (
        !Array.isArray(targets) ||
        !targets.length ||
        targets.length > 32 ||
        targets.some(
          (target) =>
            typeof target !== "string" || !targetNames.includes(target),
        ) ||
        new Set(targets).size !== targets.length
      ) {
        throw new Error(
          `${path}.targets must contain 1–32 unique configured target names.`,
        );
      }
      const applicationUrl =
        profile.applicationUrl === undefined
          ? null
          : assertLoopbackUrl(
              profile.applicationUrl,
              `${path}.applicationUrl`,
              allowedHosts,
              loopbackHosts,
            );
      if (applicationUrl !== null)
        assertApplicationPortDoesNotOverlap(
          applicationUrl,
          servicePorts,
          `${path}.applicationUrl`,
        );
      return Object.freeze({
        name,
        targets: Object.freeze([...targets] as string[]),
        applicationUrl,
      });
    }),
  );
};
