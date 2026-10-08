/** Locate the one supported Rehearsal configuration owned by a project. */

import { access } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const CONFIG_FILENAMES = Object.freeze([
  "rehearsal.config.mjs",
  "rehearsal.config.js",
  "rehearsal.config.ts",
  join("infrastructure", "rehearsal", "rehearsal.config.mjs"),
  join("infrastructure", "rehearsal", "rehearsal.config.ts"),
]);

export interface RehearsalConfigPathOptions {
  projectRoot?: string;
  configPath?: string;
}

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

export const findRehearsalConfigPath = async ({
  projectRoot = process.cwd(),
  configPath,
}: RehearsalConfigPathOptions = {}): Promise<string> => {
  const root = resolve(projectRoot);
  if (configPath) {
    const explicit = resolve(root, configPath);
    if (relative(root, explicit).startsWith("..")) {
      throw new Error(
        "The Rehearsal configuration must stay inside the project root.",
      );
    }
    await access(explicit);
    return explicit;
  }
  for (const filename of CONFIG_FILENAMES) {
    const candidate = join(root, filename);
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
  }
  throw new Error(
    `No Rehearsal configuration was found. Checked: ${CONFIG_FILENAMES.join(", ")}.`,
  );
};
