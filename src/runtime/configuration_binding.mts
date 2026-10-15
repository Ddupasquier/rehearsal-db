/** Pin normalized reviewed configuration across a parent/child runtime action. */
import { createHash } from "node:crypto";
import type { NormalizedRehearsalConfig } from "../project/configuration.mjs";

export const runtimeConfigurationSha256 = (
  config: NormalizedRehearsalConfig,
): string => createHash("sha256").update(JSON.stringify(config)).digest("hex");

export const assertRuntimeConfigurationBinding = ({
  config,
  expected,
}: {
  readonly config: NormalizedRehearsalConfig;
  readonly expected: string | undefined;
}): void => {
  if (expected === undefined) return;
  if (
    !/^[a-f0-9]{64}$/u.test(expected) ||
    runtimeConfigurationSha256(config) !== expected
  )
    throw new Error(
      "The reviewed target configuration changed before this runtime action. The target was preserved; review current configuration and status before retrying.",
    );
};
