/** Preview or create the project-root Rehearsal configuration. */

import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  findRehearsalConfigPath,
  inspectDetectedProject,
  loadRehearsalConfig,
  renderDetectedConfig,
  renderDetectedPostgresqlConfig,
} from "../project/configuration.mjs";

const findExistingConfig = async ({ projectRoot, configPath }) => {
  try {
    return await findRehearsalConfigPath({ projectRoot, configPath });
  } catch (error) {
    if (
      String(error?.message ?? error).startsWith("No Rehearsal configuration")
    ) {
      return null;
    }
    throw error;
  }
};

export const runRehearsalInit = async ({ projectRoot, flags }) => {
  const detected = await inspectDetectedProject({ projectRoot });
  const destination = join(projectRoot, "rehearsal.config.mjs");
  const existingPath = await findExistingConfig({
    projectRoot,
    configPath: flags.configPath,
  });
  if (existingPath) {
    if (flags.write) {
      throw new Error(
        `A Rehearsal configuration already exists at ${relative(projectRoot, existingPath)}; Rehearsal will not overwrite it.`,
      );
    }
    const loaded = await loadRehearsalConfig({
      projectRoot,
      configPath: flags.configPath,
    });
    const source = loaded.config.supabase
      ? renderDetectedConfig(detected, {
          applicationUrl: loaded.config.runtime.applicationUrl,
          ports: loaded.config.runtime.ports,
        })
      : renderDetectedPostgresqlConfig(detected, {
          applicationUrl: loaded.config.runtime.applicationUrl,
          databasePort: loaded.config.runtime.ports.database,
        });
    const usesLegacyAuthentication = Boolean(
      loaded.config.supabase?.serviceEnvironmentFile ||
      loaded.config.safety.authenticationProviders.length,
    );
    const availableOptions =
      loaded.config.supabase && !loaded.config.supabase.authentication
        ? [
            {
              path: "supabase.authentication",
              summary: usesLegacyAuthentication
                ? "A declarative Google/GitHub replacement is available; replace the legacy provider fields together after review."
                : "Configure local Google or GitHub sign-in with credentials kept outside tracked files.",
            },
          ]
        : [];
    return {
      mode: "current-template",
      destination: relative(projectRoot, existingPath),
      detected,
      source,
      availableOptions,
      nextAction:
        "Your existing configuration was not changed. Compare it with this installed-release template to discover new optional keys.",
    };
  }

  const source = detected.hasSupabaseConfig
    ? renderDetectedConfig(detected)
    : renderDetectedPostgresqlConfig(detected);
  if (flags.write) {
    await writeFile(destination, source, { flag: "wx", mode: 0o600 });
  }
  return {
    mode: flags.write ? "written" : "preview",
    destination: relative(projectRoot, destination),
    detected,
    source,
    availableOptions: [],
    nextAction: flags.write
      ? "Review the generated safety settings and run rehearsal doctor."
      : "Review this preview, then rerun rehearsal init --write to create it.",
  };
};
