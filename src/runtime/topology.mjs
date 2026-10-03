/**
 * Purpose: Resolve and validate a primary Rehearsal runtime plus any explicitly
 * declared dependent runtimes. Every target remains a complete, independently
 * safe Rehearsal configuration.
 */

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { loadRehearsalConfig } from "../project/configuration.mjs";
import { inspectRehearsalMigrations } from "./plan.mjs";

const isInside = (parent, candidate) => {
  const path = relative(parent, candidate);
  return !path || (!path.startsWith("..") && !isAbsolute(path));
};

const assertUnique = (entries, valueFor, label) => {
  const seen = new Map();
  for (const entry of entries) {
    const value = valueFor(entry);
    if (seen.has(value)) {
      throw new Error(
        `Dependent runtime ${entry.name} conflicts with ${seen.get(value)}: ${label} ${value} must be unique.`,
      );
    }
    seen.set(value, entry.name);
  }
};

const targetFrom = ({ name, declaration, loaded, primary }) =>
  Object.freeze({
    name,
    primary,
    declaration,
    configPath: loaded.configPath,
    config: loaded.config,
    paths: loaded.paths,
  });

export const loadRuntimeTopology = async (options = {}) => {
  const primaryLoaded = await loadRehearsalConfig(options);
  const primary = targetFrom({
    name: "primary",
    declaration: null,
    loaded: primaryLoaded,
    primary: true,
  });
  const dependents = [];
  for (const declaration of primary.config.dependentTargets) {
    const loaded = await loadRehearsalConfig({
      projectRoot: primaryLoaded.projectRoot,
      configPath: declaration.configPath,
    });
    if (loaded.config.dependentTargets.length > 0) {
      throw new Error(
        `Dependent runtime ${declaration.name} cannot declare its own dependentTargets. Nesting is intentionally unsupported.`,
      );
    }
    dependents.push(
      targetFrom({
        name: declaration.name,
        declaration,
        loaded,
        primary: false,
      }),
    );
  }
  const targets = [primary, ...dependents];
  assertUnique(targets, (target) => target.name, "target name");
  assertUnique(targets, (target) => target.configPath, "config path");
  assertUnique(
    targets,
    (target) => target.config.runtime.projectId,
    "runtime project ID",
  );
  assertUnique(
    targets.flatMap((target) =>
      Object.entries(target.config.runtime.ports).map(([kind, port]) => ({
        name: `${target.name} (${kind})`,
        port,
      })),
    ),
    (entry) => entry.port,
    "runtime port",
  );
  assertUnique(
    targets,
    (target) => target.paths.applicationEnvironment,
    "application environment file",
  );
  assertUnique(
    targets.filter((target) => target.paths.rehearsalConfig),
    (target) => target.paths.rehearsalConfig,
    "Supabase runtime config",
  );
  for (let index = 0; index < targets.length; index += 1) {
    for (
      let otherIndex = index + 1;
      otherIndex < targets.length;
      otherIndex += 1
    ) {
      const left = targets[index];
      const right = targets[otherIndex];
      if (
        isInside(left.paths.artifactDirectory, right.paths.artifactDirectory) ||
        isInside(right.paths.artifactDirectory, left.paths.artifactDirectory)
      ) {
        throw new Error(
          `Dependent runtimes ${left.name} and ${right.name} must use separate, non-nested .rehearsal artifact directories.`,
        );
      }
    }
  }
  return Object.freeze({
    projectRoot: primaryLoaded.projectRoot,
    primary,
    dependents: Object.freeze(dependents),
    targets: Object.freeze(targets),
  });
};

const candidateSummary = (inspection) => {
  const candidates = inspection.migrations.filter(
    (migration) => migration.status === "candidate",
  );
  return Object.freeze({
    baselineGenerationId: inspection.baselineGenerationId,
    candidateSha256: inspection.candidateSha256,
    candidateCount: candidates.length,
    candidates: Object.freeze(candidates),
  });
};

export const inspectRuntimeTopologyCandidates = async (options = {}) => {
  const topology = await loadRuntimeTopology(options);
  const targets = [];
  for (const target of topology.targets) {
    targets.push(
      Object.freeze({
        ...target,
        summary: candidateSummary(
          await inspectRehearsalMigrations({
            projectRoot: topology.projectRoot,
            configPath: target.configPath,
          }),
        ),
      }),
    );
  }
  if (targets.length === 1) {
    return Object.freeze({
      topology,
      targets: Object.freeze(targets),
      candidateSha256: targets[0].summary.candidateSha256,
      candidateCount: targets[0].summary.candidateCount,
    });
  }
  const digestInput = targets.map((target) => ({
    name: target.name,
    candidateSha256: target.summary.candidateSha256,
    candidates: target.summary.candidates.map((candidate) => ({
      filename: candidate.filename,
      sha256: candidate.sha256,
    })),
  }));
  return Object.freeze({
    topology,
    targets: Object.freeze(targets),
    candidateSha256: createHash("sha256")
      .update(JSON.stringify(digestInput))
      .digest("hex"),
    candidateCount: targets.reduce(
      (total, target) => total + target.summary.candidateCount,
      0,
    ),
  });
};
