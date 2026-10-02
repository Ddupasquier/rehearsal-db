/**
 * Purpose: Load and strictly validate the versioned, project-owned Rehearsal
 * configuration contract. Do not run directly; this module is reusable script
 * infrastructure.
 */

import { access, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRuntimeTarget } from "../runtime/runtime_target.mjs";

export {
  EXCLUDED_VALUE,
  SANITIZATION_ACTIONS,
  applySanitizationAction,
  normalizeSanitizationAction,
  readBoundRuntimeSanitizationPolicy,
  validateSanitizationCoverage,
  validateRuntimeSanitizationPolicy,
} from "./sanitization_policy.mjs";

export const REHEARSAL_CONFIG_VERSION = 1;

export const REHEARSAL_DEFAULTS = Object.freeze({
  baseline: Object.freeze({ artifactDirectory: ".rehearsal" }),
  containerRuntime: Object.freeze({ autoStartColima: true }),
  cleanup: Object.freeze({ retainBaselineGenerations: 2 }),
  runtime: Object.freeze({
    applicationUrl: "http://localhost:5175",
    projectId: "rehearsal-local",
  }),
  safety: Object.freeze({
    allowedHosts: Object.freeze(["127.0.0.1", "::1", "localhost"]),
    blockedEnvironmentVariables: Object.freeze([
      "DATABASE_URL",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
      "PGUSER",
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_DB_PASSWORD",
      "SUPABASE_PROJECT_ID",
    ]),
    hostedAccess: "disabled",
    outboundNetwork: "deny",
  }),
});

const CONFIG_FILENAMES = Object.freeze([
  "rehearsal.config.mjs",
  "rehearsal.config.js",
  "rehearsal.config.ts",
  join("infrastructure", "rehearsal", "rehearsal.config.mjs"),
  join("infrastructure", "rehearsal", "rehearsal.config.ts"),
]);

const LOOPBACK_HOSTS = new Set(REHEARSAL_DEFAULTS.safety.allowedHosts);
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const DATABASE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const POSTGRES_IMAGE_PATTERN = /^postgres:\d+(?:\.\d+)?-alpine$/u;
const SAFE_COMMAND_PATTERN = /^[^\n\r\0]+$/u;

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const assertPlainObject = (value, path) => {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
};

const assertKnownKeys = (value, keys, path) => {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(
        `Unknown Rehearsal configuration property: ${path}.${key}.`,
      );
    }
  }
};

const assertNonEmptyString = (value, path) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
};

const assertRelativePath = (value, path) => {
  const normalized = assertNonEmptyString(value, path);
  if (isAbsolute(normalized) || normalized.split(/[\\/]/u).includes("..")) {
    throw new Error(`${path} must stay inside the project root.`);
  }
  return normalized;
};

const assertCommand = (value, path) => {
  const command = assertNonEmptyString(value, path);
  if (!SAFE_COMMAND_PATTERN.test(command)) {
    throw new Error(`${path} contains an unsafe control character.`);
  }
  return command;
};

const assertPort = (value, path) => {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) {
    throw new Error(`${path} must be a non-privileged TCP port.`);
  }
  return value;
};

const assertBoolean = (value, path) => {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be true or false.`);
  }
  return value;
};

const assertPositiveInteger = (value, path) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return value;
};

const assertStringArray = (value, path) => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${path} must be a non-empty string array.`);
  }
  return [...new Set(value.map((entry) => entry.trim()))];
};

const assertLoopbackUrl = (value, path, allowedHosts) => {
  let parsed;
  try {
    parsed = new URL(assertNonEmptyString(value, path));
  } catch {
    throw new Error(`${path} must be a valid loopback URL.`);
  }
  if (
    !allowedHosts.includes(parsed.hostname) ||
    !LOOPBACK_HOSTS.has(parsed.hostname)
  ) {
    throw new Error(`${path} must use an explicitly allowed loopback host.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${path} must use HTTP or HTTPS.`);
  }
  return parsed.toString().replace(/\/$/u, "");
};

const normalizeConfig = (input) => {
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
  const projectName = assertNonEmptyString(project.name, "config.project.name");
  if (!IDENTIFIER_PATTERN.test(projectName)) {
    throw new Error(
      "config.project.name must contain only lowercase letters, digits, and hyphens.",
    );
  }

  const runtimeTarget = resolveRuntimeTarget(root.runtime?.target).id;
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
  const application = assertPlainObject(root.application, "config.application");
  assertKnownKeys(
    application,
    ["startCommand", "proofCommand", "environmentFile", "runtimeAdapter"],
    "config.application",
  );
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
  const serviceEnvironmentVariables =
    supabase?.serviceEnvironmentVariables ?? [];
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
    Boolean(supabase?.serviceEnvironmentFile) !==
    Boolean(normalizedServiceEnvironmentVariables.length)
  ) {
    throw new Error(
      "config.supabase.serviceEnvironmentFile and serviceEnvironmentVariables must be configured together.",
    );
  }
  const authenticationProviders = safety.authenticationProviders
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
          serviceEnvironmentFile: supabase.serviceEnvironmentFile
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
          image: (() => {
            const image = assertNonEmptyString(
              postgresql.image ?? "postgres:17-alpine",
              "config.postgresql.image",
            );
            if (!POSTGRES_IMAGE_PATTERN.test(image)) {
              throw new Error(
                "config.postgresql.image must name an official versioned Alpine PostgreSQL image, such as postgres:17-alpine.",
              );
            }
            return image;
          })(),
          database: (() => {
            const database = assertNonEmptyString(
              postgresql.database ?? "postgres",
              "config.postgresql.database",
            );
            if (!DATABASE_IDENTIFIER_PATTERN.test(database)) {
              throw new Error(
                "config.postgresql.database must be a safe lowercase PostgreSQL identifier.",
              );
            }
            return database;
          })(),
          user: (() => {
            const user = assertNonEmptyString(
              postgresql.user ?? "postgres",
              "config.postgresql.user",
            );
            if (!DATABASE_IDENTIFIER_PATTERN.test(user)) {
              throw new Error(
                "config.postgresql.user must be a safe lowercase PostgreSQL identifier.",
              );
            }
            return user;
          })(),
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

export const defineRehearsalConfig = (config) => config;

export const findRehearsalConfigPath = async ({ projectRoot, configPath }) => {
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
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    `No Rehearsal configuration was found. Checked: ${CONFIG_FILENAMES.join(", ")}.`,
  );
};

export const loadRehearsalConfig = async ({
  projectRoot = process.cwd(),
  configPath,
} = {}) => {
  const root = resolve(projectRoot);
  const path = await findRehearsalConfigPath({ projectRoot: root, configPath });
  const module = await import(
    `${pathToFileURL(path).href}?loaded=${Date.now()}`
  );
  const config = normalizeConfig(module.default);
  const resolveOwnedPath = (value) => {
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
      (config.supabase ?? config.postgresql).migrationDirectory,
    ),
    rehearsalConfig: config.supabase
      ? resolveOwnedPath(config.supabase.rehearsalConfig)
      : null,
    runtimeWorkdir: resolveOwnedPath(
      (config.supabase ?? config.postgresql).runtimeWorkdir,
    ),
    serviceEnvironment: config.supabase?.serviceEnvironmentFile
      ? resolveOwnedPath(config.supabase.serviceEnvironmentFile)
      : null,
    sanitizationPolicy: resolveOwnedPath(config.baseline.sanitizationPolicy),
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
  if (!IDENTIFIER_PATTERN.test(config.runtime.projectId)) {
    throw new Error(
      "config.runtime.projectId must contain only lowercase letters, digits, and hyphens.",
    );
  }
  return Object.freeze({
    config,
    configPath: path,
    projectRoot: root,
    paths,
  });
};

export const inspectDetectedProject = async ({
  projectRoot = process.cwd(),
} = {}) => {
  const root = resolve(projectRoot);
  const packageJsonPath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const hasPath = async (path) =>
    stat(join(root, path))
      .then(() => true)
      .catch((error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
  const packageManager = (await hasPath("pnpm-lock.yaml"))
    ? "pnpm"
    : (await hasPath("yarn.lock"))
      ? "yarn"
      : "npm";
  const scripts = packageJson.scripts ?? {};
  const postgresqlMigrationDirectory = (
    await Promise.all(
      ["database/migrations", "db/migrations", "migrations"].map(
        async (path) => ({ path, exists: await hasPath(path) }),
      ),
    )
  ).find(({ exists }) => exists)?.path;
  const normalizedProjectName = String(packageJson.name ?? basename(root))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-|-$/gu, "");
  const projectName =
    normalizedProjectName.slice(0, 52).replace(/-$/u, "") ||
    "rehearsal-project";
  return {
    projectName,
    packageManager,
    hasSupabaseConfig: await hasPath("supabase/config.toml"),
    hasMigrations: await hasPath("supabase/migrations"),
    hasPostgresqlMigrations: Boolean(postgresqlMigrationDirectory),
    postgresqlMigrationDirectory:
      postgresqlMigrationDirectory ?? "database/migrations",
    applicationCommand:
      ["dev:rehearsal", "dev", "start"]
        .find((name) => typeof scripts[name] === "string")
        ?.replace(/^/u, `${packageManager} run `) ??
      `${packageManager} run dev`,
    verificationCommand:
      ["verify:feature", "test", "check"]
        .find((name) => typeof scripts[name] === "string")
        ?.replace(/^/u, `${packageManager} run `) ?? `${packageManager} test`,
  };
};

export const renderDetectedConfig = (
  detected,
  {
    applicationUrl = "http://localhost:5175",
    ports = { api: 58321, database: 58322, studio: 58323 },
  } = {},
) =>
  `// @ts-check
/**
 * Rehearsal configuration for ${detected.projectName}.
 * Generated from this project by \`npx rehearsal\` and safe to commit.
 * Review the CHECK comments. Keep passwords, tokens, and production URLs out of this file.
 * Docs: https://github.com/Ddupasquier/rehearsal-db/blob/main/docs/configuration.md
 */
import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
	// Configuration format. Rehearsal will explain if an upgrade is ever needed.
	schemaVersion: 1,
	// Stable local name used in Rehearsal labels and reports.
	project: { name: ${JSON.stringify(detected.projectName)} },

	// Project files Rehearsal reads. Every path stays inside this repository.
	supabase: {
		workdir: ".",
		migrationDirectory: "supabase/migrations",
		rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml",
		runtimeWorkdir: ".rehearsal/runtime",

		// Optional local-only identity-provider credentials. Enable both keys together.
		// serviceEnvironmentFile: ".env.rehearsal-service.local",
		// serviceEnvironmentVariables: ["LOCAL_IDP_CLIENT_ID", "LOCAL_IDP_SECRET"],
	},

	// Immutable local baseline files. Rehearsal never reads production on your behalf.
	baseline: {
		artifactDirectory: ".rehearsal",
		sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
	},

	// Reuse any running Docker-compatible engine; start Colima only when needed.
	containerRuntime: {
		autoStartColima: true,
	},

	// Keep this many baseline generations, always including the active one.
	cleanup: {
		retainBaselineGenerations: 2,
	},

	application: {
		// CHECK: commands detected from package.json. Change them if they are not correct.
		startCommand: ${JSON.stringify(detected.applicationCommand)},
		proofCommand: ${JSON.stringify(detected.verificationCommand)},
		environmentFile: ".rehearsal/runtime.env",
		// Optional project-specific restore hook:
		// runtimeAdapter: "infrastructure/rehearsal/runtime-adapter.mjs",
	},

	// Disposable local runtime identity, URL, and dedicated ports.
	runtime: {
		target: "supabase",
		applicationUrl: ${JSON.stringify(applicationUrl)},
		projectId: "${detected.projectName}-rehearsal",
		apiPort: ${ports.api},
		databasePort: ${ports.database},
		studioPort: ${ports.studio},
	},

	// Only local runtime URLs are accepted; common hosted credentials are quarantined.
	safety: {
		allowedHosts: ["127.0.0.1", "::1", "localhost"],
		blockedEnvironmentVariables: [
			"SUPABASE_ACCESS_TOKEN",
			"SUPABASE_DB_PASSWORD",
			"SUPABASE_PROJECT_ID",
		],
		hostedAccess: "disabled",
		outboundNetwork: "deny",
	},
});
`.replaceAll("\t", "  ");

export const renderDetectedPostgresqlConfig = (
  detected,
  { applicationUrl = "http://localhost:5175", databasePort = 58322 } = {},
) =>
  `// @ts-check
/**
 * Rehearsal configuration for ${detected.projectName}.
 * Generated from this project by \`npx rehearsal\` and safe to commit.
 * Review the CHECK comments. Keep passwords, tokens, and production URLs out of this file.
 * Docs: https://github.com/Ddupasquier/rehearsal-db/blob/main/docs/configuration.md
 */
import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
	// Configuration format. Rehearsal will explain if an upgrade is ever needed.
	schemaVersion: 1,
	// Stable local name used in Rehearsal labels and reports.
	project: { name: ${JSON.stringify(detected.projectName)} },

	// Disposable PostgreSQL settings. The image must already exist locally.
	postgresql: {
		migrationDirectory: ${JSON.stringify(detected.postgresqlMigrationDirectory)},
		runtimeWorkdir: ".rehearsal/runtime",
		image: "postgres:17-alpine",
		database: "postgres",
		user: "postgres",
	},

	// Immutable local baseline files. Rehearsal never reads production on your behalf.
	baseline: {
		artifactDirectory: ".rehearsal",
		sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
	},

	// Reuse any running Docker-compatible engine; start Colima only when needed.
	containerRuntime: {
		autoStartColima: true,
	},

	// Keep this many baseline generations, always including the active one.
	cleanup: {
		retainBaselineGenerations: 2,
	},

	application: {
		// CHECK: commands detected from package.json. Change them if they are not correct.
		startCommand: ${JSON.stringify(detected.applicationCommand)},
		proofCommand: ${JSON.stringify(detected.verificationCommand)},
		environmentFile: ".rehearsal/runtime.env",
		// Optional project-specific restore hook:
		// runtimeAdapter: "infrastructure/rehearsal/runtime-adapter.mjs",
	},

	// Disposable local runtime identity, URL, and dedicated database port.
	runtime: {
		target: "postgresql",
		applicationUrl: ${JSON.stringify(applicationUrl)},
		projectId: "${detected.projectName}-rehearsal",
		databasePort: ${databasePort},
	},

	// Only local runtime URLs are accepted; common hosted credentials are quarantined.
	safety: {
		allowedHosts: ["127.0.0.1", "::1", "localhost"],
		blockedEnvironmentVariables: [
			"DATABASE_URL",
			"PGHOST",
			"PGPASSWORD",
			"PGPORT",
			"PGUSER",
		],
		hostedAccess: "disabled",
		outboundNetwork: "deny",
	},
});
`.replaceAll("\t", "  ");
