/** Normalize declarative application environment mappings without reading secret values. */
import {
  assertPlainObject,
  assertEnvironmentKey,
  assertEnvironmentReference,
} from "./configuration_validation.mjs";
export const normalizeApplicationEnvironmentMappings = (
  value: unknown = {},
): Readonly<Record<string, string>> => {
  const mappings = assertPlainObject(
    value,
    "config.application.environmentVariables",
  );
  return Object.freeze(
    Object.fromEntries(
      Object.entries(mappings).map(([key, reference]) => {
        const path = `config.application.environmentVariables.${key}`;
        assertEnvironmentKey(key, path);
        return [key, assertEnvironmentReference(reference, path)];
      }),
    ),
  );
};
