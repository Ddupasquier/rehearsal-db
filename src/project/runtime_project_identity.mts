/** Preserve exact configured runtime ownership and bound newly generated identities. */

import { createHash } from "node:crypto";
import { RehearsalError } from "../shared/diagnostics.mjs";
import type { RehearsalRuntimeTargetId } from "../targets/target.mjs";
import {
  assertIdentifier,
  assertNonEmptyString,
} from "./configuration_validation.mjs";

const maximumProjectIdLength = (target: RehearsalRuntimeTargetId): number =>
  target === "supabase" ? 40 : 63;

export const assertRuntimeProjectId = (
  value: unknown,
  target: RehearsalRuntimeTargetId,
): string => {
  const projectId = assertNonEmptyString(value, "config.runtime.projectId");
  const maximumLength = maximumProjectIdLength(target);
  if (projectId.length < 2 || projectId.length > maximumLength) {
    const provider = target === "supabase" ? "Supabase" : "PostgreSQL";
    throw new RehearsalError({
      category: "configuration_invalid",
      code: "CONFIGURATION_INVALID",
      message: `config.runtime.projectId must contain 2–${maximumLength} characters for ${provider}.`,
      expected: `2–${maximumLength} lowercase letters, digits, or hyphens`,
      actual: { length: projectId.length },
      context: { field: "runtime.projectId", target, maximumLength },
      refused:
        "No runtime was started or renamed. Rehearsal never truncates a configured project ID or adopts resources by prefix.",
      suggestions: [
        "Choose a distinct, explicitly reviewed ID for a new disposable runtime. Review existing resources before changing their configured identity.",
      ],
    });
  }
  return assertIdentifier(projectId, "config.runtime.projectId");
};

/** Only new setup identities are shortened; valid existing generated IDs stay stable. */
export const createRuntimeProjectId = (
  projectName: string,
  target: RehearsalRuntimeTargetId,
  identitySeed = projectName,
): string => {
  const candidate = `${projectName}-rehearsal`;
  const maximumLength = maximumProjectIdLength(target);
  if (candidate.length <= maximumLength)
    return assertRuntimeProjectId(candidate, target);
  const digest = createHash("sha256")
    .update(`${identitySeed}-rehearsal`)
    .digest("hex")
    .slice(0, 12);
  const suffix = `-${digest}-rehearsal`;
  const prefix = projectName
    .slice(0, maximumLength - suffix.length)
    .replace(/-+$/u, "");
  return assertRuntimeProjectId(`${prefix}${suffix}`, target);
};
