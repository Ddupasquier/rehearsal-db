/**
 * Purpose: Load and strictly validate the versioned, project-owned Rehearsal
 * configuration contract. Do not run directly; this module is reusable script
 * infrastructure.
 */

import {
  REHEARSAL_CONFIG_VERSION,
  REHEARSAL_DEFAULTS,
} from "./configuration_contract.mjs";
import { validateConfigurationSchema } from "./configuration_schema.mjs";
import {
  assertBoolean,
  assertCommand,
  assertDatabaseIdentifier,
  assertEnvironmentKey,
  assertEnvironmentReference,
  assertHttpStatus,
  assertIdentifier,
  assertKnownKeys,
  assertLoopbackUrl,
  assertNonEmptyString,
  assertPlainObject,
  assertPort,
  assertPostgresImage,
  assertPositiveInteger,
  assertRelativePath,
  assertStringArray,
} from "./configuration_validation.mjs";
const LOOPBACK_HOSTS = new Set(REHEARSAL_DEFAULTS.safety.allowedHosts);
const SUPPORTED_SUPABASE_OAUTH_PROVIDERS = new Set(["github", "google"]);

const normalizeApplicationEnvironmentMappings = (
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

export const normalizeRehearsalConfig = (input: unknown) => {
  const {
    root,
    project,
    runtime,
    runtimeTarget,
    supabase,
    postgresql,
    baseline,
    containerRuntime,
    cleanup,
    preparation,
    dependentTargets,
    application,
    readiness,
    httpProofs,
    safety,
    verification,
    authentication,
  } = validateConfigurationSchema(input);

  const projectName = assertIdentifier(project.name, "config.project.name");

  const normalizedDependentTargets = dependentTargets.map((target, index) => {
    const path = `config.dependentTargets[${index}]`;
    const name = assertIdentifier(target.name, `${path}.name`);
    return Object.freeze({
      name,
      configPath: assertRelativePath(target.configPath, `${path}.configPath`),
      prepareCommand:
        target.prepareCommand === undefined
          ? null
          : assertCommand(target.prepareCommand, `${path}.prepareCommand`),
    });
  });
  if (
    new Set(normalizedDependentTargets.map((target) => target.name)).size !==
    normalizedDependentTargets.length
  ) {
    throw new Error("config.dependentTargets names must be unique.");
  }
  if (
    httpProofs.length > 0 &&
    (!httpProofs.some((proof) => proof.kind === "positive") ||
      !httpProofs.some((proof) => proof.kind === "negative"))
  ) {
    throw new Error(
      "config.application.httpProofs must include at least one positive and one negative check.",
    );
  }

  const allowedHosts = assertStringArray(
    safety.allowedHosts ?? REHEARSAL_DEFAULTS.safety.allowedHosts,
    "config.safety.allowedHosts",
  );
  if (allowedHosts.some((host) => !LOOPBACK_HOSTS.has(host))) {
    throw new Error(
      "config.safety.allowedHosts may contain loopback hosts only in configuration version 1.",
    );
  }
  if ((safety.hostedAccess ?? "disabled") !== "disabled") {
    throw new Error(
      "config.safety.hostedAccess must remain disabled in configuration version 1.",
    );
  }
  if ((safety.outboundNetwork ?? "deny") !== "deny") {
    throw new Error(
      "config.safety.outboundNetwork must remain deny in configuration version 1.",
    );
  }

  const ports = {
    ...(runtimeTarget === "supabase"
      ? { api: assertPort(runtime.apiPort, "config.runtime.apiPort") }
      : {}),
    database: assertPort(runtime.databasePort, "config.runtime.databasePort"),
    ...(runtimeTarget === "supabase"
      ? { studio: assertPort(runtime.studioPort, "config.runtime.studioPort") }
      : {}),
  };
  if (new Set(Object.values(ports)).size !== Object.values(ports).length) {
    throw new Error("Rehearsal runtime ports must be unique.");
  }

  const commands = verification.commands ?? [];
  if (!Array.isArray(commands)) {
    throw new Error("config.verification.commands must be an array.");
  }
  let normalizedAuthentication = null;
  if (authentication) {
    if (!supabase) {
      throw new Error(
        "config.supabase.authentication requires the Supabase runtime target.",
      );
    }
    if (authentication.enableLocalSignup !== true) {
      throw new Error(
        "config.supabase.authentication.enableLocalSignup must be true to create the disposable local identity used by an OAuth sign-in.",
      );
    }
    if (
      supabase.serviceEnvironmentFile !== undefined ||
      supabase.serviceEnvironmentVariables !== undefined
    ) {
      throw new Error(
        "config.supabase.authentication cannot be combined with the legacy serviceEnvironmentFile or serviceEnvironmentVariables fields.",
      );
    }
    if (safety.authenticationProviders !== undefined) {
      throw new Error(
        "config.safety.authenticationProviders is derived from config.supabase.authentication and must be omitted.",
      );
    }
    if (
      !Array.isArray(authentication.providers) ||
      authentication.providers.length === 0
    ) {
      throw new Error(
        "config.supabase.authentication.providers must be a non-empty array.",
      );
    }
    const providers = authentication.providers.map(
      (entry: unknown, index: number) => {
        const path = `config.supabase.authentication.providers[${index}]`;
        const value = entry as Record<string, unknown>;
        const reviewedName = assertNonEmptyString(value.name, `${path}.name`);
        if (!SUPPORTED_SUPABASE_OAUTH_PROVIDERS.has(reviewedName)) {
          throw new Error(
            `${path}.name must be one of: ${[...SUPPORTED_SUPABASE_OAUTH_PROVIDERS].join(", ")}.`,
          );
        }
        const name = reviewedName as "google" | "github";
        const environmentVariable = (
          key:
            "clientIdEnvironmentVariable" | "clientSecretEnvironmentVariable",
        ): string => {
          return assertEnvironmentKey(value[key], `${path}.${key}`);
        };
        const optionalBoolean = (
          key: "skipNonceCheck" | "emailOptional",
        ): boolean => {
          if (value[key] === undefined) return false;
          if (typeof value[key] !== "boolean") {
            throw new Error(`${path}.${key} must be a boolean.`);
          }
          return value[key];
        };
        return Object.freeze({
          name,
          clientIdEnvironmentVariable: environmentVariable(
            "clientIdEnvironmentVariable",
          ),
          clientSecretEnvironmentVariable: environmentVariable(
            "clientSecretEnvironmentVariable",
          ),
          skipNonceCheck: optionalBoolean("skipNonceCheck"),
          emailOptional: optionalBoolean("emailOptional"),
        });
      },
    );
    if (
      new Set(providers.map(({ name }: { name: string }) => name)).size !==
      providers.length
    ) {
      throw new Error(
        "config.supabase.authentication.providers must not contain duplicate providers.",
      );
    }
    const credentialVariables = providers.flatMap((provider) => [
      provider.clientIdEnvironmentVariable,
      provider.clientSecretEnvironmentVariable,
    ]);
    if (new Set(credentialVariables).size !== credentialVariables.length) {
      throw new Error(
        "config.supabase.authentication provider environment variables must be unique.",
      );
    }
    normalizedAuthentication = Object.freeze({
      enableLocalSignup: true,
      environmentFile: assertRelativePath(
        authentication.environmentFile,
        "config.supabase.authentication.environmentFile",
      ),
      providers: Object.freeze(providers),
    });
  }
  const serviceEnvironmentVariables = normalizedAuthentication
    ? normalizedAuthentication.providers.flatMap((provider) => [
        provider.clientIdEnvironmentVariable,
        provider.clientSecretEnvironmentVariable,
      ])
    : (supabase?.serviceEnvironmentVariables ?? []);
  if (!Array.isArray(serviceEnvironmentVariables)) {
    throw new Error(
      "config.supabase.serviceEnvironmentVariables must be an array.",
    );
  }
  const normalizedServiceEnvironmentVariables = serviceEnvironmentVariables.map(
    (value, index) =>
      assertNonEmptyString(
        value,
        `config.supabase.serviceEnvironmentVariables[${index}]`,
      ),
  );
  if (
    new Set(normalizedServiceEnvironmentVariables).size !==
    normalizedServiceEnvironmentVariables.length
  ) {
    throw new Error(
      "config.supabase.serviceEnvironmentVariables must not contain duplicates.",
    );
  }
  if (
    Boolean(
      normalizedAuthentication?.environmentFile ??
      supabase?.serviceEnvironmentFile,
    ) !== Boolean(normalizedServiceEnvironmentVariables.length)
  ) {
    throw new Error(
      "config.supabase.serviceEnvironmentFile and serviceEnvironmentVariables must be configured together.",
    );
  }
  const authenticationProviders = normalizedAuthentication
    ? normalizedAuthentication.providers.map(
        ({ name }: { name: string }) => name,
      )
    : safety.authenticationProviders
      ? assertStringArray(
          safety.authenticationProviders,
          "config.safety.authenticationProviders",
        )
      : [];
  if (runtimeTarget === "postgresql" && authenticationProviders.length > 0) {
    throw new Error(
      "config.safety.authenticationProviders is available only for the Supabase target.",
    );
  }

  return Object.freeze({
    schemaVersion: REHEARSAL_CONFIG_VERSION,
    project: Object.freeze({ name: projectName }),
    supabase: supabase
      ? Object.freeze({
          workdir: assertRelativePath(
            supabase.workdir,
            "config.supabase.workdir",
          ),
          migrationDirectory: assertRelativePath(
            supabase.migrationDirectory,
            "config.supabase.migrationDirectory",
          ),
          rehearsalConfig: assertRelativePath(
            supabase.rehearsalConfig,
            "config.supabase.rehearsalConfig",
          ),
          runtimeWorkdir: assertRelativePath(
            supabase.runtimeWorkdir,
            "config.supabase.runtimeWorkdir",
          ),
          authentication: normalizedAuthentication,
          serviceEnvironmentFile: normalizedAuthentication
            ? normalizedAuthentication.environmentFile
            : supabase.serviceEnvironmentFile
              ? assertRelativePath(
                  supabase.serviceEnvironmentFile,
                  "config.supabase.serviceEnvironmentFile",
                )
              : null,
          serviceEnvironmentVariables: Object.freeze(
            normalizedServiceEnvironmentVariables,
          ),
        })
      : null,
    postgresql: postgresql
      ? Object.freeze({
          migrationDirectory: assertRelativePath(
            postgresql.migrationDirectory,
            "config.postgresql.migrationDirectory",
          ),
          runtimeWorkdir: assertRelativePath(
            postgresql.runtimeWorkdir ?? ".rehearsal/runtime",
            "config.postgresql.runtimeWorkdir",
          ),
          image: assertPostgresImage(
            postgresql.image ?? "postgres:17-alpine",
            "config.postgresql.image",
          ),
          database: assertDatabaseIdentifier(
            postgresql.database ?? "postgres",
            "config.postgresql.database",
          ),
          user: assertDatabaseIdentifier(
            postgresql.user ?? "postgres",
            "config.postgresql.user",
          ),
        })
      : null,
    baseline: Object.freeze({
      artifactDirectory: assertRelativePath(
        baseline.artifactDirectory ??
          REHEARSAL_DEFAULTS.baseline.artifactDirectory,
        "config.baseline.artifactDirectory",
      ),
      sanitizationPolicy: assertRelativePath(
        baseline.sanitizationPolicy,
        "config.baseline.sanitizationPolicy",
      ),
    }),
    containerRuntime: Object.freeze({
      autoStartColima: assertBoolean(
        containerRuntime.autoStartColima ??
          REHEARSAL_DEFAULTS.containerRuntime.autoStartColima,
        "config.containerRuntime.autoStartColima",
      ),
    }),
    cleanup: Object.freeze({
      retainBaselineGenerations: assertPositiveInteger(
        cleanup.retainBaselineGenerations ??
          REHEARSAL_DEFAULTS.cleanup.retainBaselineGenerations,
        "config.cleanup.retainBaselineGenerations",
      ),
    }),
    preparation: preparation
      ? Object.freeze({
          sourcePolicy: assertRelativePath(
            preparation.sourcePolicy,
            "config.preparation.sourcePolicy",
          ),
          privacyKey: assertRelativePath(
            preparation.privacyKey,
            "config.preparation.privacyKey",
          ),
          batchRows: assertPositiveInteger(
            preparation.batchRows ?? 500,
            "config.preparation.batchRows",
          ),
          maximumRows: assertPositiveInteger(
            preparation.maximumRows ?? 1_000_000,
            "config.preparation.maximumRows",
          ),
          maximumBytes: assertPositiveInteger(
            preparation.maximumBytes ?? 2 * 1024 * 1024 * 1024,
            "config.preparation.maximumBytes",
          ),
          diskHeadroomBytes: assertPositiveInteger(
            preparation.diskHeadroomBytes ?? 64 * 1024 * 1024,
            "config.preparation.diskHeadroomBytes",
          ),
        })
      : null,
    runtimePolicy:
      root.runtimePolicy === undefined
        ? null
        : assertRelativePath(root.runtimePolicy, "config.runtimePolicy"),
    identityPolicy:
      root.identityPolicy === undefined
        ? null
        : assertRelativePath(root.identityPolicy, "config.identityPolicy"),
    dependentTargets: Object.freeze(normalizedDependentTargets),
    application: Object.freeze({
      startCommand: assertCommand(
        application.startCommand,
        "config.application.startCommand",
      ),
      proofCommand: assertCommand(
        application.proofCommand,
        "config.application.proofCommand",
      ),
      environmentFile: assertRelativePath(
        application.environmentFile ?? ".rehearsal/runtime.env",
        "config.application.environmentFile",
      ),
      environmentVariables: normalizeApplicationEnvironmentMappings(
        application.environmentVariables,
      ),
      readiness: readiness
        ? Object.freeze({
            url: assertLoopbackUrl(
              readiness.url,
              "config.application.readiness.url",
              allowedHosts,
              LOOPBACK_HOSTS,
            ),
            expectedStatus: assertHttpStatus(
              readiness.expectedStatus,
              "config.application.readiness.expectedStatus",
            ),
            timeoutSeconds: assertPositiveInteger(
              readiness.timeoutSeconds ?? 30,
              "config.application.readiness.timeoutSeconds",
            ),
          })
        : null,
      httpProofs: Object.freeze(
        httpProofs.map((proof, index) => {
          const path = `config.application.httpProofs[${index}]`;
          const value = assertPlainObject(proof, path);
          assertKnownKeys(
            value,
            ["name", "kind", "url", "method", "expectedStatus", "json"],
            path,
          );
          if (
            typeof value.kind !== "string" ||
            !["positive", "negative"].includes(value.kind)
          ) {
            throw new Error(`${path}.kind must be positive or negative.`);
          }
          const expectedStatus = assertHttpStatus(
            value.expectedStatus,
            `${path}.expectedStatus`,
          );
          const method = assertNonEmptyString(
            value.method ?? "GET",
            `${path}.method`,
          ).toUpperCase();
          if (!["GET", "HEAD"].includes(method)) {
            throw new Error(`${path}.method must be GET or HEAD.`);
          }
          let json = null;
          if (value.json !== undefined) {
            const assertion = assertPlainObject(value.json, `${path}.json`);
            assertKnownKeys(
              assertion,
              ["path", "equals", "notEquals", "minimumItems"],
              `${path}.json`,
            );
            if (
              !Array.isArray(assertion.path) ||
              assertion.path.length === 0 ||
              assertion.path.some(
                (segment: unknown) => typeof segment !== "string" || !segment,
              )
            ) {
              throw new Error(
                `${path}.json.path must be a non-empty string array.`,
              );
            }
            const assertionCount = [
              Object.hasOwn(assertion, "equals"),
              Object.hasOwn(assertion, "notEquals"),
              assertion.minimumItems !== undefined,
            ].filter(Boolean).length;
            if (assertionCount !== 1) {
              throw new Error(
                `${path}.json must declare exactly one assertion.`,
              );
            }
            json = Object.freeze({
              path: Object.freeze([...assertion.path] as string[]),
              ...(Object.hasOwn(assertion, "equals")
                ? { equals: assertion.equals }
                : {}),
              ...(Object.hasOwn(assertion, "notEquals")
                ? { notEquals: assertion.notEquals }
                : {}),
              ...(assertion.minimumItems !== undefined
                ? {
                    minimumItems: assertPositiveInteger(
                      assertion.minimumItems,
                      `${path}.json.minimumItems`,
                    ),
                  }
                : {}),
            });
          }
          return Object.freeze({
            name: assertNonEmptyString(value.name, `${path}.name`),
            kind: value.kind as "positive" | "negative",
            url: assertLoopbackUrl(
              value.url,
              `${path}.url`,
              allowedHosts,
              LOOPBACK_HOSTS,
            ),
            method,
            expectedStatus,
            json,
          });
        }),
      ),
      runtimeAdapter:
        application.runtimeAdapter === undefined
          ? null
          : assertRelativePath(
              application.runtimeAdapter,
              "config.application.runtimeAdapter",
            ),
    }),
    runtime: Object.freeze({
      target: runtimeTarget,
      applicationUrl: assertLoopbackUrl(
        runtime.applicationUrl ?? REHEARSAL_DEFAULTS.runtime.applicationUrl,
        "config.runtime.applicationUrl",
        allowedHosts,
        LOOPBACK_HOSTS,
      ),
      projectId: assertNonEmptyString(
        runtime.projectId ?? REHEARSAL_DEFAULTS.runtime.projectId,
        "config.runtime.projectId",
      ),
      ports: Object.freeze(ports),
    }),
    safety: Object.freeze({
      allowedHosts: Object.freeze(allowedHosts),
      blockedEnvironmentVariables: Object.freeze(
        assertStringArray(
          safety.blockedEnvironmentVariables ??
            REHEARSAL_DEFAULTS.safety.blockedEnvironmentVariables,
          "config.safety.blockedEnvironmentVariables",
        ),
      ),
      authenticationProviders: Object.freeze(authenticationProviders),
      hostedAccess: "disabled",
      outboundNetwork: "deny",
    }),
    verification: Object.freeze({
      commands: Object.freeze(
        commands.map((command, index) =>
          assertCommand(command, `config.verification.commands[${index}]`),
        ),
      ),
    }),
  });
};
