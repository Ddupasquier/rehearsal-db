/** Load a discovered config and resolve every owned path from the project root. */

import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findRehearsalConfigPath,
  type RehearsalConfigPathOptions,
} from "./configuration_discovery.mjs";
import { normalizeRehearsalConfig } from "./configuration_normalization.mjs";
import { assertIdentifier } from "./configuration_validation.mjs";

export type NormalizedRehearsalConfig = ReturnType<
  typeof normalizeRehearsalConfig
>;

export const loadRehearsalConfig = async ({
  projectRoot = process.cwd(),
  configPath,
}: RehearsalConfigPathOptions = {}) => {
  const root = resolve(projectRoot);
  const path = await findRehearsalConfigPath({
    projectRoot: root,
    ...(configPath === undefined ? {} : { configPath }),
  });
  const module = await import(
    `${pathToFileURL(path).href}?loaded=${Date.now()}`
  );
  const config = normalizeRehearsalConfig(module.default);
  const resolveOwnedPath = (value: string): string => {
    const resolved = resolve(root, value);
    if (relative(root, resolved).startsWith("..")) {
      throw new Error(`A Rehearsal path escaped the project root: ${value}.`);
    }
    return resolved;
  };
  const paths = Object.freeze({
    artifactDirectory: resolveOwnedPath(config.baseline.artifactDirectory),
    applicationEnvironment: resolveOwnedPath(
      config.application.environmentFile,
    ),
    migrationDirectory: resolveOwnedPath(
      (config.supabase ?? config.postgresql)!.migrationDirectory,
    ),
    rehearsalConfig: config.supabase
      ? resolveOwnedPath(config.supabase.rehearsalConfig)
      : null,
    runtimeWorkdir: resolveOwnedPath(
      (config.supabase ?? config.postgresql)!.runtimeWorkdir,
    ),
    serviceEnvironment: config.supabase?.serviceEnvironmentFile
      ? resolveOwnedPath(config.supabase.serviceEnvironmentFile)
      : null,
    sanitizationPolicy: resolveOwnedPath(config.baseline.sanitizationPolicy),
    sourcePolicy: config.preparation
      ? resolveOwnedPath(config.preparation.sourcePolicy)
      : null,
    privacyKey: config.preparation
      ? resolveOwnedPath(config.preparation.privacyKey)
      : null,
    runtimePolicy: config.runtimePolicy
      ? resolveOwnedPath(config.runtimePolicy)
      : null,
    identityPolicy: config.identityPolicy
      ? resolveOwnedPath(config.identityPolicy)
      : null,
    supabaseWorkdir: config.supabase
      ? resolveOwnedPath(config.supabase.workdir)
      : null,
    runtimeAdapter: config.application.runtimeAdapter
      ? resolveOwnedPath(config.application.runtimeAdapter)
      : null,
  });
  if (basename(paths.artifactDirectory) !== ".rehearsal") {
    throw new Error(
      'config.baseline.artifactDirectory must resolve to a directory named ".rehearsal" so destructive reset and cleanup operations have an explicit safety boundary.',
    );
  }
  const requiredRuntimeWorkdir = join(paths.artifactDirectory, "runtime");
  if (paths.runtimeWorkdir !== requiredRuntimeWorkdir) {
    throw new Error(
      `config.${config.runtime.target}.runtimeWorkdir must resolve to the runtime directory inside config.baseline.artifactDirectory.`,
    );
  }
  const environmentRelativePath = relative(
    paths.artifactDirectory,
    paths.applicationEnvironment,
  );
  if (
    !environmentRelativePath ||
    environmentRelativePath.startsWith("..") ||
    isAbsolute(environmentRelativePath)
  ) {
    throw new Error(
      "config.application.environmentFile must resolve to a file inside config.baseline.artifactDirectory.",
    );
  }
  if (paths.privacyKey) {
    const privacyKeyRelativePath = relative(
      paths.artifactDirectory,
      paths.privacyKey,
    );
    if (
      !privacyKeyRelativePath ||
      privacyKeyRelativePath.startsWith("..") ||
      isAbsolute(privacyKeyRelativePath)
    ) {
      throw new Error(
        "config.preparation.privacyKey must resolve to a secret file inside config.baseline.artifactDirectory.",
      );
    }
  }
  assertIdentifier(config.runtime.projectId, "config.runtime.projectId");
  return Object.freeze({
    config,
    configPath: path,
    projectRoot: root,
    paths,
  });
};
