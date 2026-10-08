/** Validate the raw object shape and known keys before applying defaults. */

import { resolveRuntimeTarget } from "../targets/target.mjs";
import { REHEARSAL_CONFIG_VERSION } from "./configuration_contract.mjs";
import {
  assertKnownKeys,
  assertPlainObject,
  type PlainObject,
} from "./configuration_validation.mjs";

export interface ValidatedConfigurationSchema {
  root: PlainObject;
  project: PlainObject;
  runtime: PlainObject;
  runtimeTarget: "supabase" | "postgresql";
  supabase: PlainObject | null;
  postgresql: PlainObject | null;
  baseline: PlainObject;
  containerRuntime: PlainObject;
  cleanup: PlainObject;
  preparation: PlainObject | null;
  dependentTargets: PlainObject[];
  application: PlainObject;
  readiness: PlainObject | null;
  httpProofs: PlainObject[];
  safety: PlainObject;
  verification: PlainObject;
  authentication: PlainObject | null;
}

const assertObjectArray = (value: unknown, path: string): PlainObject[] => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((entry, index) =>
    assertPlainObject(entry, `${path}[${index}]`),
  );
};

export const validateConfigurationSchema = (
  input: unknown,
): ValidatedConfigurationSchema => {
  const root = assertPlainObject(input, "config");
  assertKnownKeys(
    root,
    [
      "schemaVersion",
      "project",
      "supabase",
      "postgresql",
      "baseline",
      "containerRuntime",
      "cleanup",
      "preparation",
      "runtimePolicy",
      "identityPolicy",
      "dependentTargets",
      "application",
      "runtime",
      "safety",
      "verification",
    ],
    "config",
  );
  if (root.schemaVersion !== REHEARSAL_CONFIG_VERSION) {
    throw new Error(
      `Unsupported Rehearsal configuration version: ${String(root.schemaVersion)}. Expected ${REHEARSAL_CONFIG_VERSION}.`,
    );
  }

  const project = assertPlainObject(root.project, "config.project");
  assertKnownKeys(project, ["name"], "config.project");

  const runtime = assertPlainObject(root.runtime ?? {}, "config.runtime");
  assertKnownKeys(
    runtime,
    [
      "target",
      "applicationUrl",
      "projectId",
      "apiPort",
      "databasePort",
      "studioPort",
    ],
    "config.runtime",
  );
  const runtimeTarget = resolveRuntimeTarget(runtime.target).id;
  const supabase =
    runtimeTarget === "supabase"
      ? assertPlainObject(root.supabase, "config.supabase")
      : null;
  const postgresql =
    runtimeTarget === "postgresql"
      ? assertPlainObject(root.postgresql, "config.postgresql")
      : null;
  if (runtimeTarget === "supabase" && root.postgresql !== undefined) {
    throw new Error(
      "config.postgresql is not allowed when config.runtime.target is supabase.",
    );
  }
  if (runtimeTarget === "postgresql" && root.supabase !== undefined) {
    throw new Error(
      "config.supabase is not allowed when config.runtime.target is postgresql.",
    );
  }
  if (supabase) {
    assertKnownKeys(
      supabase,
      [
        "workdir",
        "migrationDirectory",
        "rehearsalConfig",
        "runtimeWorkdir",
        "authentication",
        "serviceEnvironmentFile",
        "serviceEnvironmentVariables",
      ],
      "config.supabase",
    );
  }
  if (postgresql) {
    assertKnownKeys(
      postgresql,
      ["migrationDirectory", "runtimeWorkdir", "image", "database", "user"],
      "config.postgresql",
    );
  }

  const baseline = assertPlainObject(root.baseline, "config.baseline");
  assertKnownKeys(
    baseline,
    ["artifactDirectory", "sanitizationPolicy"],
    "config.baseline",
  );
  const containerRuntime = assertPlainObject(
    root.containerRuntime ?? {},
    "config.containerRuntime",
  );
  assertKnownKeys(
    containerRuntime,
    ["autoStartColima"],
    "config.containerRuntime",
  );
  const cleanup = assertPlainObject(root.cleanup ?? {}, "config.cleanup");
  assertKnownKeys(cleanup, ["retainBaselineGenerations"], "config.cleanup");
  const preparation =
    root.preparation === undefined
      ? null
      : assertPlainObject(root.preparation, "config.preparation");
  if (preparation) {
    assertKnownKeys(
      preparation,
      [
        "sourcePolicy",
        "privacyKey",
        "batchRows",
        "maximumRows",
        "maximumBytes",
        "diskHeadroomBytes",
      ],
      "config.preparation",
    );
  }

  const dependentTargets = assertObjectArray(
    root.dependentTargets ?? [],
    "config.dependentTargets",
  );
  dependentTargets.forEach((target, index) =>
    assertKnownKeys(
      target,
      ["name", "configPath", "prepareCommand"],
      `config.dependentTargets[${index}]`,
    ),
  );

  const application = assertPlainObject(root.application, "config.application");
  assertKnownKeys(
    application,
    [
      "startCommand",
      "proofCommand",
      "environmentFile",
      "environmentVariables",
      "readiness",
      "httpProofs",
      "runtimeAdapter",
    ],
    "config.application",
  );
  const readiness =
    application.readiness === undefined
      ? null
      : assertPlainObject(
          application.readiness,
          "config.application.readiness",
        );
  if (readiness) {
    assertKnownKeys(
      readiness,
      ["url", "expectedStatus", "timeoutSeconds"],
      "config.application.readiness",
    );
  }
  const httpProofs = assertObjectArray(
    application.httpProofs ?? [],
    "config.application.httpProofs",
  );
  httpProofs.forEach((proof, index) => {
    const path = `config.application.httpProofs[${index}]`;
    assertKnownKeys(
      proof,
      ["name", "kind", "url", "method", "expectedStatus", "json"],
      path,
    );
    if (proof.json !== undefined) {
      assertKnownKeys(
        assertPlainObject(proof.json, `${path}.json`),
        ["path", "equals", "notEquals", "minimumItems"],
        `${path}.json`,
      );
    }
  });

  const safety = assertPlainObject(root.safety ?? {}, "config.safety");
  assertKnownKeys(
    safety,
    [
      "allowedHosts",
      "blockedEnvironmentVariables",
      "authenticationProviders",
      "hostedAccess",
      "outboundNetwork",
    ],
    "config.safety",
  );
  const verification = assertPlainObject(
    root.verification ?? {},
    "config.verification",
  );
  assertKnownKeys(verification, ["commands"], "config.verification");

  const authentication =
    supabase?.authentication === undefined
      ? null
      : assertPlainObject(
          supabase.authentication,
          "config.supabase.authentication",
        );
  if (authentication) {
    assertKnownKeys(
      authentication,
      ["enableLocalSignup", "environmentFile", "providers"],
      "config.supabase.authentication",
    );
    if (Array.isArray(authentication.providers)) {
      const providers = assertObjectArray(
        authentication.providers,
        "config.supabase.authentication.providers",
      );
      providers.forEach((provider, index) =>
        assertKnownKeys(
          provider,
          [
            "name",
            "clientIdEnvironmentVariable",
            "clientSecretEnvironmentVariable",
            "skipNonceCheck",
            "emailOptional",
          ],
          `config.supabase.authentication.providers[${index}]`,
        ),
      );
    }
  }

  return {
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
  };
};
