import { addDrizzleMigrationDiscovery } from "./project_discovery_migration_tool.mjs";
/**
 * Build a read-only, explainable profile from bounded project metadata.
 *
 * Discovery never imports project modules, reads environment files, contacts a
 * database, or starts a container engine. Suggestions are intentionally kept
 * separate from facts and from choices that require a person.
 */

import { resolve } from "node:path";
import { addPrismaMigrationDiscovery } from "./project_discovery_migration_tool.mjs";
import { inspectContainerEngineOptions } from "../runtime/engine_discovery.mjs";
import type { ContainerEngineDiscovery } from "../runtime/engine_discovery.mjs";
import { discoverApplication } from "./project_discovery_application.mjs";
import type {
  ContainerEngineProbe,
  DecisionDiscoveryItem,
  DetectedDiscoveryItem,
  DiscoveredConfigurationField,
  PackageManifest,
  ProjectDiscoveryResult,
  SuggestedDiscoveryItem,
} from "./project_discovery_contract.mjs";
import {
  PROJECT_DISCOVERY_SCHEMA_VERSION,
  decision,
  detected,
  isRecord,
  recordStrings,
  suggested,
} from "./project_discovery_contract.mjs";
import {
  discoverRootConfigPaths,
  localConfigHints,
  metadataKind,
  normalizedProjectName,
  probeContainerEngineWithoutStarting,
  readBoundedProjectFile,
} from "./project_discovery_metadata.mjs";

export { PROJECT_DISCOVERY_SCHEMA_VERSION } from "./project_discovery_contract.mjs";
export type {
  ContainerEngineProbe,
  DecisionDiscoveryItem,
  DetectedDiscoveryItem,
  DiscoveredConfigurationField,
  DiscoveryConfidence,
  DiscoveryEvidence,
  DiscoveryValue,
  ProjectDiscoveryResult,
  SuggestedDiscoveryItem,
} from "./project_discovery_contract.mjs";
export { probeContainerEngineWithoutStarting } from "./project_discovery_metadata.mjs";

export const discoverProjectProfile = async ({
  projectRoot = process.cwd(),
  containerEngineProbe,
  containerEngineOptionsProbe,
}: {
  projectRoot?: string;
  containerEngineProbe?: ContainerEngineProbe;
  containerEngineOptionsProbe?: () => Promise<ContainerEngineDiscovery>;
} = {}): Promise<ProjectDiscoveryResult> => {
  const root = resolve(projectRoot);
  const manifestSource = await readBoundedProjectFile(root, "package.json");
  let manifest: PackageManifest = {};
  if (manifestSource !== null) {
    const parsed: unknown = JSON.parse(manifestSource);
    if (!isRecord(parsed))
      throw new Error("package.json must contain an object.");
    manifest = parsed;
  }
  const scripts = recordStrings(manifest.scripts);
  const dependencies = {
    ...recordStrings(manifest.dependencies),
    ...recordStrings(manifest.devDependencies),
  };
  const projectName = normalizedProjectName(manifest.name, root);
  const facts: DetectedDiscoveryItem[] = [];
  const suggestions: SuggestedDiscoveryItem[] = [];
  const decisions: DecisionDiscoveryItem[] = [];
  const application = await discoverApplication({
    root,
    manifest,
    scripts,
    dependencies,
  });
  facts.push(...application.detected);
  suggestions.push(...application.suggested);
  decisions.push(...application.decisions);

  const migrationDirectories = (
    await Promise.all(
      [
        "supabase/migrations",
        "database/migrations",
        "db/migrations",
        "migrations",
        "prisma/migrations",
        "drizzle",
      ].map(async (path) => ({
        path,
        exists: (await metadataKind(root, path)) === "directory",
      })),
    )
  ).filter(({ exists }) => exists);
  if (migrationDirectories.length > 0) {
    facts.push(
      detected(
        "database.migrationDirectories",
        "Migration directories",
        migrationDirectories.map(({ path }) => path),
        migrationDirectories.map(({ path }) => ({
          kind: "file",
          source: path,
          detail: "Project-local migration directory is present.",
        })),
      ),
    );
  }

  const hasSupabaseConfig =
    (await metadataKind(root, "supabase/config.toml")) === "file";
  const hasSupabaseDependency = "@supabase/supabase-js" in dependencies;
  const postgresPackages = [
    "pg",
    "postgres",
    "@prisma/client",
    "drizzle-orm",
  ].filter((name) => name in dependencies);
  const hasPostgresDependency = postgresPackages.length > 0;
  if (hasSupabaseConfig || hasSupabaseDependency) {
    facts.push(
      detected("database.supabase", "Supabase usage", "Supabase", [
        ...(hasSupabaseConfig
          ? [
              {
                kind: "file" as const,
                source: "supabase/config.toml",
                detail: "Supabase project configuration is present.",
              },
            ]
          : []),
        ...(hasSupabaseDependency
          ? [
              {
                kind: "manifest" as const,
                source: "package.json#@supabase/supabase-js",
                detail: "The Supabase client is declared.",
              },
            ]
          : []),
      ]),
    );
  }
  if (hasPostgresDependency) {
    facts.push(
      detected(
        "database.postgresql",
        "PostgreSQL-related packages",
        postgresPackages,
        [
          {
            kind: "manifest",
            source: "package.json#dependencies",
            detail: "A PostgreSQL client or ORM is declared.",
          },
        ],
      ),
    );
  }
  if (
    hasSupabaseConfig &&
    migrationDirectories.some(({ path }) => path !== "supabase/migrations")
  ) {
    decisions.push(
      decision(
        "database.target",
        "Database target",
        ["supabase", "postgresql"],
        "Which database target should this Rehearsal configuration own?",
        "Supabase configuration and an additional migration directory are both present.",
        [],
        "runtime.target",
      ),
    );
  } else if (
    hasSupabaseConfig ||
    migrationDirectories.some(({ path }) => path === "supabase/migrations")
  ) {
    suggestions.push(
      suggested(
        "database.target",
        "Database target",
        "supabase",
        "high",
        "Confirm that this project needs Supabase services rather than PostgreSQL alone.",
        [
          {
            kind: "file",
            source: hasSupabaseConfig
              ? "supabase/config.toml"
              : "supabase/migrations",
            detail: "Supabase project structure is present.",
          },
        ],
        "runtime.target",
      ),
    );
  } else if (migrationDirectories.length === 1 || hasPostgresDependency) {
    suggestions.push(
      suggested(
        "database.target",
        "Database target",
        "postgresql",
        migrationDirectories.length === 1 ? "high" : "medium",
        "Confirm that ordinary PostgreSQL provides the services this project needs.",
        migrationDirectories.length === 1
          ? [
              {
                kind: "file",
                source: migrationDirectories[0]!.path,
                detail: "A non-Supabase migration directory is present.",
              },
            ]
          : (facts.find(({ id }) => id === "database.postgresql")?.evidence ??
              []),
        "runtime.target",
      ),
    );
  } else {
    decisions.push(
      decision(
        "database.target",
        "Database target",
        "Not detected",
        "Does this project use Supabase or ordinary PostgreSQL?",
        "No supported database structure was detected.",
        [],
        "runtime.target",
      ),
    );
  }

  const nativePrisma = migrationDirectories.some(
    ({ path }) => path === "prisma/migrations",
  );
  const nativeDrizzle =
    (await metadataKind(root, "drizzle/meta/_journal.json")) === "file";
  if (nativeDrizzle) addDrizzleMigrationDiscovery(facts, decisions);
  if (nativePrisma) addPrismaMigrationDiscovery(facts, decisions);
  if (migrationDirectories.length === 1 && !nativePrisma && !nativeDrizzle) {
    suggestions.push(
      suggested(
        "database.migrationDirectory",
        "Migration directory",
        migrationDirectories[0]!.path,
        "high",
        "Review before adding this path to Rehearsal.",
        [
          {
            kind: "file",
            source: migrationDirectories[0]!.path,
            detail: "This is the only conventional migration directory found.",
          },
        ],
        hasSupabaseConfig
          ? "supabase.migrationDirectory"
          : "postgresql.migrationDirectory",
      ),
    );
  } else if (migrationDirectories.length > 0) {
    decisions.push(
      decision(
        "database.migrationDirectory",
        "Migration directory",
        migrationDirectories.map(({ path }) => path),
        nativePrisma
          ? "Which reviewed native migration-tool workflow belongs to this target?"
          : "Which migration directory belongs to this target?",
        nativePrisma
          ? "Prisma native history needs explicit pinned tool configuration; do not flatten it into SQL files."
          : "More than one conventional migration directory was found.",
        migrationDirectories.map(({ path }) => ({
          kind: "file",
          source: path,
          detail: "Project-local migration directory is present.",
        })),
      ),
    );
  }

  const configPaths = await discoverRootConfigPaths(root);
  if (configPaths.length > 0) {
    facts.push(
      detected(
        "rehearsal.configuration",
        "Rehearsal configuration files",
        configPaths,
        configPaths.map((path) => ({
          kind: "file",
          source: path,
          detail:
            "Known Rehearsal configuration filename is present; its module was not imported.",
        })),
      ),
    );
  }
  if (configPaths.length > 1) {
    decisions.push(
      decision(
        "rehearsal.configuration.active",
        "Active Rehearsal configuration",
        configPaths,
        "Which configuration should this workspace use?",
        "Multiple Rehearsal configuration files were detected. No file was changed.",
        configPaths.map((path) => ({
          kind: "file",
          source: path,
          detail: "Configuration candidate is present.",
        })),
      ),
    );
  }
  if (configPaths.length === 1) {
    const configSource = await readBoundedProjectFile(root, configPaths[0]!);
    const hints = configSource
      ? localConfigHints(configSource)
      : { applicationUrl: null, apiPort: null };
    if (hints.applicationUrl) {
      const existingSuggestion = suggestions.findIndex(
        ({ id }) => id === "application.readiness.url",
      );
      if (existingSuggestion !== -1) suggestions.splice(existingSuggestion, 1);
      const existingDecision = decisions.findIndex(
        ({ id }) => id === "application.readiness.url",
      );
      if (existingDecision !== -1) decisions.splice(existingDecision, 1);
      suggestions.push(
        suggested(
          "application.readiness.url",
          "Application URL",
          hints.applicationUrl,
          "high",
          "A loopback URL literal is present in the config; doctor remains the validation authority.",
          [
            {
              kind: "file",
              source: configPaths[0]!,
              detail:
                "A literal loopback applicationUrl is present; no module was imported.",
            },
          ],
          "application.readiness.url",
        ),
      );
    }
    if (hints.apiPort && hasSupabaseConfig) {
      suggestions.push(
        suggested(
          "authentication.callbackUrl",
          "Local authentication callback",
          `http://127.0.0.1:${hints.apiPort}/auth/v1/callback`,
          "high",
          "Confirm this callback with each local authentication provider.",
          [
            {
              kind: "file",
              source: configPaths[0]!,
              detail:
                "A literal local Supabase apiPort is present; no provider credentials were read.",
            },
          ],
          "supabase.authentication",
        ),
      );
    }
  }

  const policyPaths = (
    await Promise.all(
      [
        "rehearsal/sanitization-policy.json",
        "rehearsal/identity-policy.json",
        "rehearsal/runtime-policy.json",
        "infrastructure/rehearsal/sanitization-policy.json",
        "infrastructure/rehearsal/identity-policy.json",
        "infrastructure/rehearsal/runtime-policy.json",
      ].map(async (path) => ({
        path,
        exists: (await metadataKind(root, path)) === "file",
      })),
    )
  ).filter(({ exists }) => exists);
  if (policyPaths.length > 0) {
    facts.push(
      detected(
        "rehearsal.policies",
        "Rehearsal policy files",
        policyPaths.map(({ path }) => path),
        policyPaths.map(({ path }) => ({
          kind: "file",
          source: path,
          detail: "Policy filename is present; policy values were not read.",
        })),
      ),
    );
  }

  const generationsPresent =
    (await metadataKind(root, ".rehearsal/generations")) === "directory";
  const currentBaseline = await metadataKind(root, ".rehearsal/current");
  if (generationsPresent || currentBaseline === "symlink") {
    facts.push(
      detected("rehearsal.baseline", "Local baseline artifacts", true, [
        ...(generationsPresent
          ? [
              {
                kind: "file" as const,
                source: ".rehearsal/generations",
                detail: "The baseline generations directory is present.",
              },
            ]
          : []),
        ...(currentBaseline === "symlink"
          ? [
              {
                kind: "file" as const,
                source: ".rehearsal/current",
                detail:
                  "An active baseline link is present; it was not followed.",
              },
            ]
          : []),
      ]),
    );
  }

  const containerEngines = containerEngineOptionsProbe
    ? await containerEngineOptionsProbe()
    : containerEngineProbe
      ? null
      : await inspectContainerEngineOptions({ projectRoot: root });
  const engineState = containerEngineProbe
    ? await containerEngineProbe()
    : containerEngines?.state === "ready"
      ? "running"
      : containerEngines?.state === "unavailable"
        ? "unavailable"
        : "stopped";
  facts.push(
    detected("container.engine", "Docker-compatible engine", engineState, [
      {
        kind: "runtime_probe",
        source: "selected local Docker context",
        detail:
          "Read-only reachability probe; Rehearsal did not issue a start command.",
      },
    ]),
  );
  if (containerEngines)
    facts.push(
      detected(
        "host.platform",
        "Detected host platform",
        containerEngines.host.kind,
        [
          {
            kind: "runtime_probe",
            source: "host platform",
            detail:
              "Runtime support remains separate from engine/tool discovery.",
          },
        ],
      ),
      detected(
        "container.options",
        "Local engine options",
        containerEngines.options
          .filter(
            (option) =>
              option.contexts.length || option.installed === "detected",
          )
          .map(
            (option) =>
              `${option.label}: ${option.contexts.join(", ") || "tool detected; engine not probed"}`,
          ),
        [
          {
            kind: "runtime_probe",
            source: "local context metadata and executable presence",
            detail:
              "Alternate engines were not contacted or started; vendor conformance is not inferred.",
          },
        ],
      ),
    );

  decisions.push(
    decision(
      "privacy.productionData",
      "Production data scope",
      "Requires review",
      "Which production-shaped records may be copied and sanitized?",
      "File and schema discovery cannot establish permission to copy data.",
    ),
    decision(
      "privacy.sanitization",
      "Sanitization policy",
      policyPaths.some(({ path }) => path.endsWith("sanitization-policy.json"))
        ? "Existing policy requires review"
        : "Not configured",
      "Which fields must be excluded, transformed, or preserved?",
      "Privacy rules must be explicitly reviewed even when a policy file exists.",
      policyPaths
        .filter(({ path }) => path.endsWith("sanitization-policy.json"))
        .map(({ path }) => ({
          kind: "file",
          source: path,
          detail:
            "A sanitization policy filename is present; its values were not read.",
        })),
      "baseline.sanitizationPolicy",
    ),
    decision(
      "privacy.identity",
      "Identity policy",
      policyPaths.some(({ path }) => path.endsWith("identity-policy.json"))
        ? "Existing policy requires review"
        : "Not configured",
      "How should copied identities be represented and associated locally?",
      "Authentication and ownership behavior is security-sensitive and cannot be inferred.",
      policyPaths
        .filter(({ path }) => path.endsWith("identity-policy.json"))
        .map(({ path }) => ({
          kind: "file",
          source: path,
          detail:
            "An identity policy filename is present; its values were not read.",
        })),
      "identityPolicy",
    ),
    decision(
      "cleanup.policy",
      "Cleanup policy",
      "Requires review",
      "What may Rehearsal retain or remove from its owned local resources?",
      "Cleanup and retention choices can remove local artifacts and must stay explicit.",
      [],
      "cleanup",
    ),
  );
  if (hasSupabaseConfig || hasSupabaseDependency) {
    decisions.push(
      decision(
        "authentication.providers",
        "Local authentication providers",
        "Requires review",
        "Which authentication providers should be enabled in the local Rehearsal runtime?",
        "Provider choice and credential-variable names are security-sensitive and cannot be inferred from dependencies.",
        [],
        "supabase.authentication",
      ),
    );
  }

  const sourceItems = [...suggestions, ...decisions];
  const field = (
    path: string,
    status: DiscoveredConfigurationField["status"],
  ): DiscoveredConfigurationField => {
    const matches = sourceItems.filter((item) => item.configPath === path);
    return {
      path,
      status,
      ...(matches.length === 1 ? { value: matches[0]!.value } : {}),
      sourceItemIds: matches.map(({ id }) => id),
    };
  };
  const hasSuggestion = (path: string) =>
    suggestions.some((item) => item.configPath === path);
  const hasDecision = (path: string) =>
    decisions.some((item) => item.configPath === path);
  const configState =
    configPaths.length === 0
      ? "missing"
      : configPaths.length === 1
        ? "present_unvalidated"
        : "ambiguous";

  return {
    schemaVersion: PROJECT_DISCOVERY_SCHEMA_VERSION,
    ...(containerEngines ? { containerEngines } : {}),
    project: {
      name: projectName,
      packageManifest: manifestSource === null ? "missing" : "present",
    },
    detected: facts,
    suggested: suggestions,
    decisions,
    configuration: {
      state: configState,
      activePath: configPaths[0] ?? null,
      discoveredPaths: configPaths,
      fields: [
        ...(nativePrisma
          ? [field("postgresql.migrationTool", "decision_required")]
          : []),
        {
          path: "configuration.path",
          status:
            configState === "present_unvalidated"
              ? "present_unvalidated"
              : configState === "ambiguous"
                ? "decision_required"
                : "not_detected",
          ...(configPaths[0] ? { value: configPaths[0] } : {}),
          sourceItemIds:
            configPaths.length > 1
              ? ["rehearsal.configuration.active"]
              : configPaths.length === 1
                ? ["rehearsal.configuration"]
                : [],
        },
        field(
          "runtime.target",
          hasDecision("runtime.target")
            ? "decision_required"
            : hasSuggestion("runtime.target")
              ? "suggested"
              : "not_detected",
        ),
        field(
          hasSupabaseConfig
            ? "supabase.migrationDirectory"
            : "postgresql.migrationDirectory",
          hasDecision("database.migrationDirectory")
            ? "decision_required"
            : suggestions.some(({ id }) => id === "database.migrationDirectory")
              ? "suggested"
              : "not_detected",
        ),
        field(
          "application.startCommand",
          hasDecision("application.startCommand")
            ? "decision_required"
            : hasSuggestion("application.startCommand")
              ? "suggested"
              : "not_detected",
        ),
        field(
          "application.proofCommand",
          hasDecision("application.proofCommand")
            ? "decision_required"
            : hasSuggestion("application.proofCommand")
              ? "suggested"
              : "not_detected",
        ),
        field(
          "application.readiness.url",
          hasDecision("application.readiness.url")
            ? "decision_required"
            : hasSuggestion("application.readiness.url")
              ? "suggested"
              : "not_detected",
        ),
        field("baseline.sanitizationPolicy", "decision_required"),
        field("identityPolicy", "decision_required"),
        ...(hasSupabaseConfig || hasSupabaseDependency
          ? [field("supabase.authentication", "decision_required")]
          : []),
        field("cleanup", "decision_required"),
      ],
    },
    safety: {
      projectCodeExecuted: false,
      environmentFilesRead: false,
      databaseContacted: false,
      containerEngineStarted: false,
    },
  };
};
