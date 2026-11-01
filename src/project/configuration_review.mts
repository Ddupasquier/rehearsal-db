/** Core-owned field metadata and validated, fingerprint-bound editor proposals. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRehearsalConfig } from "./configuration.mjs";
import { findRehearsalConfigPath } from "./configuration_discovery.mjs";
import type { RehearsalConfigPathOptions } from "./configuration.mjs";
import { normalizeRehearsalConfig } from "./configuration_normalization.mjs";
import { loadRuntimeTopology } from "../runtime/lifecycle/topology.mjs";
import { assertRuntimeTopologyApplicationPorts } from "../runtime/lifecycle/topology_application_ports.mjs";
import { createConfigurationValidationError } from "./configuration_validation.mjs";

export const EDITABLE_CONFIGURATION_FIELDS = Object.freeze([
  ["runtime.applicationUrl", "local-url"],
  ["runtime.displayName", "text"],
  ["runtime.protected", "boolean"],
  ["application.startCommand", "command"],
  ["application.proofCommand", "command"],
  ["application.readiness.url", "local-url"],
  ["application.activity.url", "local-url"],
  ["lifecycle.run", "run-persistence"],
  ["lifecycle.open", "open-persistence"],
  ["lifecycle.openIdleTimeoutSeconds", "nullable-integer"],
  ["cleanup.retainBaselineGenerations", "integer"],
  ["containerRuntime.autoStartColima", "boolean"],
  ["containerRuntime.stopOwnedColimaWhenIdle", "boolean"],
  ["containerRuntime.diskWarningPercent", "integer"],
  ["containerRuntime.minimumFreeBytes", "integer"],
  ["resources.staleAfterSeconds", "nullable-integer"],
  ["resources.retainedEnvironmentCount", "integer"],
  ["resources.maximumBytes", "nullable-integer"],
  ["resources.cleanupSchedule", "review-schedule"],
  ["profiles", "profiles"],
] as const);
const valueAt = (source: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      source,
    );
const hash = (source: string): string =>
  createHash("sha256").update(source).digest("hex");
const localRegularPath = async (
  projectRoot: string,
  path: string,
  maximumBytes: number,
): Promise<string> => {
  const root = await realpath(projectRoot);
  const candidate = await realpath(path);
  const local = relative(root, candidate);
  const details = await lstat(path);
  if (
    !local ||
    local === ".." ||
    local.startsWith("../") ||
    local.startsWith("..\\") ||
    isAbsolute(local) ||
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > maximumBytes
  )
    throw createConfigurationValidationError(
      "Configuration review requires a bounded project-local regular file, not a symbolic link.",
    );
  return candidate;
};
const boundedSource = async (
  path: string,
  projectRoot: string,
  maximumBytes = 1024 * 1024,
): Promise<string> => {
  const candidate = await localRegularPath(projectRoot, path, maximumBytes);
  const before = await lstat(candidate);
  const handle = await open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    const current = await lstat(
      await localRegularPath(projectRoot, candidate, maximumBytes),
    );
    if (
      !opened.isFile() ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.ino !== current.ino ||
      opened.dev !== current.dev
    )
      throw createConfigurationValidationError(
        "Configuration review file changed while opening it.",
      );
    const bytes = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > maximumBytes)
      throw createConfigurationValidationError(
        "Configuration review file exceeds its bounded read limit.",
      );
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
};
const loadReviewedConfiguration = async (
  options: RehearsalConfigPathOptions,
) => {
  const projectRoot = await realpath(options.projectRoot ?? process.cwd());
  const configPath = await findRehearsalConfigPath({ ...options, projectRoot });
  const source = await boundedSource(configPath, projectRoot);
  const loaded = await loadRehearsalConfig({ projectRoot, configPath });
  if (hash(await boundedSource(configPath, projectRoot)) !== hash(source))
    throw createConfigurationValidationError(
      "Configuration changed while loading its review; no proposal was accepted.",
    );
  return { loaded, source };
};
export const inspectConfigurationMetadata = async (
  options: RehearsalConfigPathOptions = {},
) => {
  const { loaded, source } = await loadReviewedConfiguration(options);
  return {
    schemaVersion: 1 as const,
    path: relative(loaded.projectRoot, loaded.configPath),
    sourceSha256: hash(source),
    fields: EDITABLE_CONFIGURATION_FIELDS.map(([path, kind]) => ({
      path,
      kind,
      value: valueAt(loaded.config, path) ?? null,
      provenance: "validated-active-configuration" as const,
      confidence: "certain" as const,
      reviewRequired: true,
    })),
    profiles: loaded.config.profiles,
    patchContract: {
      schemaVersion: 1 as const,
      input: "project-local-json-file" as const,
      maximumBytes: 65536,
      writesConfiguration: false,
      executesProposedCommands: false,
      concurrentChanges: "refuse" as const,
      dependentTargetReview: "explicit-topologyConfigPath" as const,
    },
    pathResolution:
      "Rehearsal paths resolve from the project root; JavaScript imports resolve from the configuration folder.",
    manualFields:
      "Source, privacy, identity, runtime identifiers, provider declarations, and expression-based values require explicit source review. They are never guessed or silently edited. Dependent-target proposals require the explicit parent topologyConfigPath to validate cross-target application ports.",
  };
};
export const reviewConfigurationProposal = async (
  options: RehearsalConfigPathOptions,
  proposalPath: string,
) => {
  const { loaded, source: before } = await loadReviewedConfiguration(options);
  const path = resolve(loaded.projectRoot, proposalPath);
  const local = relative(loaded.projectRoot, path);
  if (!local || local.startsWith("..") || /^[A-Za-z]:/u.test(local))
    throw createConfigurationValidationError(
      "Configuration proposals must remain project-local.",
    );
  let input: unknown;
  try {
    input = JSON.parse(await boundedSource(path, loaded.projectRoot, 65536));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw createConfigurationValidationError(
        "The configuration proposal is not valid JSON; no private content was printed.",
      );
    throw error;
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw createConfigurationValidationError(
      "The configuration proposal must be an object.",
    );
  const proposal = input as Record<string, unknown>;
  if (
    proposal.schemaVersion !== 1 ||
    typeof proposal.sourceSha256 !== "string" ||
    !Array.isArray(proposal.changes) ||
    !proposal.changes.length ||
    proposal.changes.length > EDITABLE_CONFIGURATION_FIELDS.length ||
    Object.keys(proposal).some(
      (key) =>
        ![
          "schemaVersion",
          "sourceSha256",
          "changes",
          "topologyConfigPath",
        ].includes(key),
    )
  )
    throw createConfigurationValidationError(
      "The versioned configuration proposal is invalid.",
    );
  if (hash(before) !== proposal.sourceSha256)
    throw createConfigurationValidationError(
      "Configuration changed during review; refresh and review a new diff.",
    );
  const module = await import(
    `${pathToFileURL(loaded.configPath).href}?review=${Date.now()}`
  );
  const candidate = structuredClone(module.default) as Record<string, unknown>;
  const seen = new Set<string>();
  for (const raw of proposal.changes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw createConfigurationValidationError("A proposed change is invalid.");
    const change = raw as Record<string, unknown>;
    if (
      Object.keys(change).some((key) => !["path", "value"].includes(key)) ||
      typeof change.path !== "string" ||
      seen.has(change.path) ||
      !EDITABLE_CONFIGURATION_FIELDS.some(([path]) => path === change.path)
    )
      throw createConfigurationValidationError(
        "The proposed field is unknown, duplicated, or requires manual review.",
      );
    seen.add(change.path);
    const keys = change.path.split(".");
    const leaf = keys.pop()!;
    let owner = candidate;
    for (const key of keys) {
      if (owner[key] === undefined) owner[key] = {};
      if (
        !owner[key] ||
        typeof owner[key] !== "object" ||
        Array.isArray(owner[key])
      )
        throw createConfigurationValidationError(
          "A configuration owner cannot be safely edited.",
        );
      owner = owner[key] as Record<string, unknown>;
    }
    owner[leaf] = change.value;
  }
  const normalized = normalizeRehearsalConfig(candidate);
  const topologyConfigPath = proposal.topologyConfigPath;
  if (
    topologyConfigPath !== undefined &&
    (typeof topologyConfigPath !== "string" ||
      !topologyConfigPath ||
      topologyConfigPath.length > 500 ||
      /[\x00-\x1f\x7f]/u.test(topologyConfigPath) ||
      isAbsolute(topologyConfigPath) ||
      /^[A-Za-z]:/u.test(topologyConfigPath) ||
      topologyConfigPath.split(/[\\/]/u).includes(".."))
  )
    throw createConfigurationValidationError(
      "The topology configuration must be an explicit bounded project-local path.",
    );
  const graphSources = new Map<string, string>();
  const topology = await loadRuntimeTopology(
    {
      projectRoot: loaded.projectRoot,
      configPath: topologyConfigPath ?? loaded.configPath,
    },
    async (input = {}) => {
      const reviewed = await loadReviewedConfiguration(input);
      graphSources.set(reviewed.loaded.configPath, hash(reviewed.source));
      return reviewed.loaded;
    },
  );
  if (
    !topology.targets.some((target) => target.configPath === loaded.configPath)
  )
    throw createConfigurationValidationError(
      "The edited configuration is not a member of the explicit parent topology; no proposal was accepted.",
    );
  assertRuntimeTopologyApplicationPorts(
    topology.targets.map((target) =>
      target.configPath === loaded.configPath
        ? { ...target, config: normalized }
        : target,
    ),
  );
  for (const [path, expected] of graphSources)
    if (hash(await boundedSource(path, loaded.projectRoot)) !== expected)
      throw createConfigurationValidationError(
        "A topology configuration changed during review; no proposal was accepted.",
      );
  if (
    hash(await boundedSource(loaded.configPath, loaded.projectRoot)) !==
    proposal.sourceSha256
  )
    throw createConfigurationValidationError(
      "Configuration changed during review; no configuration was written.",
    );
  return {
    schemaVersion: 1 as const,
    path: relative(loaded.projectRoot, loaded.configPath),
    sourceSha256: proposal.sourceSha256,
    changes: [...seen].map((path) => ({
      path,
      previous: valueAt(loaded.config, path) ?? null,
      proposed: valueAt(normalized, path) ?? null,
    })),
    writesConfiguration: false,
    executesProposedCommands: false,
    validation: "complete-config-passed" as const,
    topologyValidation: "complete-configured-topology-passed" as const,
    topologyTargets: topology.targets.map((target) => target.name),
  };
};
