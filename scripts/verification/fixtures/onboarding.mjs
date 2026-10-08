/**
 * Prove first-time Supabase/PostgreSQL onboarding and non-destructive recovery
 * from the exact packed package, including an upgrade from the oldest retained
 * beta configuration contract.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findAvailableRehearsalPorts } from "../../../dist/src/project/setup.mjs";
import {
  prepareCandidateArtifact,
  sha256Value as sha256,
} from "../scenarios/artifact.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "rehearsal-onboarding-fixture-"),
);
const packedRoot = join(temporaryRoot, "packed");

const run = (command, args, { cwd = repositoryRoot } = {}) => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      error?.stderr || error?.stdout || error?.message || `${command} failed.`,
      { cause: error },
    );
  }
};

const createConsumer = async (root, name, { target = "supabase" } = {}) => {
  await mkdir(
    join(
      root,
      target === "supabase" ? "supabase/migrations" : "database/migrations",
    ),
    { recursive: true },
  );
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name,
        private: true,
        scripts: {
          dev: 'node -e "setInterval(() => {}, 1000)"',
          test: "node --test",
        },
      },
      null,
      2,
    )}\n`,
  );
  if (target === "supabase") {
    await writeFile(
      join(root, "supabase/config.toml"),
      `project_id = ${JSON.stringify(name)}\n\n[db]\nmajor_version = 17\n`,
    );
  }
  await writeFile(join(root, ".gitignore"), "node_modules/\nproject-cache/\n");
};

const install = (root, specification) => {
  const result = spawnSync(
    "npm",
    [
      "install",
      "--save-dev",
      "--no-audit",
      "--no-fund",
      "--foreground-scripts",
      specification,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || "npm install failed",
  );
  return `${result.stdout}${result.stderr}`;
};

const existingSupabaseConfig = (name, ports) => `export default {
  schemaVersion: 1,
  project: { name: ${JSON.stringify(name)} },
  supabase: {
    workdir: ".",
    migrationDirectory: "supabase/migrations",
    rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml",
    runtimeWorkdir: ".rehearsal/runtime",
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
  },
  application: { startCommand: "npm run dev", proofCommand: "npm test" },
  runtime: {
    target: "supabase",
    applicationUrl: "http://localhost:5175",
    projectId: ${JSON.stringify(`${name}-rehearsal`)},
    apiPort: ${ports.api},
    databasePort: ${ports.database},
    studioPort: ${ports.studio},
  },
  safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
};
`;

const runInit = (root) =>
  JSON.parse(
    run(join(root, "node_modules/.bin/rehearsal"), ["init", "--json"], {
      cwd: root,
    }),
  );

const executeCli = (root, args, { environment = {} } = {}) =>
  spawnSync(join(root, "node_modules/.bin/rehearsal"), args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });

const runCliJson = (root, args) => {
  const result = executeCli(root, [...args, "--json"]);
  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || `${args.join(" ")} failed`,
  );
  return JSON.parse(result.stdout);
};

const enableGeneratedGoogleAuthentication = (source) => {
  const start = source.indexOf("    // authentication: {");
  const end = source.indexOf("\n  },\n\n  // Immutable", start);
  assert.notEqual(
    start,
    -1,
    "Generated Supabase config omitted authentication",
  );
  assert.notEqual(end, -1, "Generated Supabase authentication block changed");
  const enabled = source.slice(start, end).replace(/^(\s*)\/\/ ?/gmu, "$1");
  return `${source.slice(0, start)}${enabled}${source.slice(end)}`;
};

const listen = async (port) => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
};

const close = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

try {
  await mkdir(packedRoot, { recursive: true });
  const artifact = await prepareCandidateArtifact({
    repositoryRoot,
    outputDirectory: packedRoot,
  });
  assert.equal(artifact.name, "@rehearsal-db/core");
  assert.equal(artifact.version, packageManifest.version);
  const tarball = artifact.path;

  const freshRoot = join(temporaryRoot, "fresh-consumer");
  await createConsumer(freshRoot, "fresh-onboarding-consumer");
  const freshInstallOutput = install(freshRoot, tarball);
  assert.match(
    freshInstallOutput,
    /Configuration: rehearsal\.config\.mjs \(created\)/u,
  );
  assert.match(freshInstallOutput, /Next: review rehearsal\.config\.mjs/iu);
  const freshConfigPath = join(freshRoot, "rehearsal.config.mjs");
  const freshConfig = await readFile(freshConfigPath, "utf8");
  const freshIgnore = await readFile(join(freshRoot, ".gitignore"), "utf8");
  const freshInit = runInit(freshRoot);
  assert.equal(freshInit.data.mode, "current-template");
  assert.match(freshConfig, /authentication:/u);
  assert.match(freshConfig, /REHEARSAL_GOOGLE_CLIENT_SECRET/u);
  assert.match(freshIgnore, /\.rehearsal\//u);
  assert.match(freshIgnore, /\.env\.rehearsal-service\.local/u);
  assert.match(freshIgnore, /project-cache\//u);
  assert.equal(
    freshInit.data.availableOptions[0]?.path,
    "supabase.authentication",
  );

  await appendFile(freshConfigPath, "\n// repeat-install canary\n");
  const beforeRepeatInstall = await readFile(freshConfigPath, "utf8");
  await rm(join(freshRoot, "node_modules/@rehearsal-db/core"), {
    recursive: true,
    force: true,
  });
  const repeatInstallOutput = install(freshRoot, tarball);
  assert.match(
    repeatInstallOutput,
    /Configuration: rehearsal\.config\.mjs \(existing\)/u,
  );
  assert.match(repeatInstallOutput, /review rehearsal\.config\.mjs/iu);
  assert.equal(await readFile(freshConfigPath, "utf8"), beforeRepeatInstall);

  const nestedRoot = join(temporaryRoot, "nested-config-consumer");
  await createConsumer(nestedRoot, "nested-config-consumer");
  const nestedConfigPath = join(
    nestedRoot,
    "infrastructure/rehearsal/rehearsal.config.mjs",
  );
  await mkdir(join(nestedRoot, "infrastructure/rehearsal"), {
    recursive: true,
  });
  const nestedConfig = existingSupabaseConfig(
    "nested-config-consumer",
    await findAvailableRehearsalPorts(),
  );
  await writeFile(nestedConfigPath, nestedConfig);
  const nestedInstallOutput = install(nestedRoot, tarball);
  assert.match(
    nestedInstallOutput,
    /Configuration: infrastructure\/rehearsal\/rehearsal\.config\.mjs \(existing\)/u,
  );
  assert.match(
    nestedInstallOutput,
    /rehearsal\.config\.mjs was not created because Rehearsal preserves one active configuration/iu,
  );
  assert.equal(await readFile(nestedConfigPath, "utf8"), nestedConfig);
  await assert.rejects(readFile(join(nestedRoot, "rehearsal.config.mjs")), {
    code: "ENOENT",
  });
  const nestedInit = runInit(nestedRoot);
  assert.equal(
    nestedInit.data.destination,
    "infrastructure/rehearsal/rehearsal.config.mjs",
  );

  const existingRoot = join(temporaryRoot, "existing-root-consumer");
  await createConsumer(existingRoot, "existing-root-consumer");
  const existingRootConfigPath = join(existingRoot, "rehearsal.config.mjs");
  const existingRootConfig = existingSupabaseConfig(
    "existing-root-consumer",
    await findAvailableRehearsalPorts(),
  );
  await writeFile(existingRootConfigPath, existingRootConfig);
  const existingRootInstallOutput = install(existingRoot, tarball);
  assert.match(
    existingRootInstallOutput,
    /Configuration: rehearsal\.config\.mjs \(existing\)/u,
  );
  assert.doesNotMatch(
    existingRootInstallOutput,
    /rehearsal\.config\.mjs was not created/iu,
  );
  assert.equal(
    await readFile(existingRootConfigPath, "utf8"),
    existingRootConfig,
  );

  const freshRuntimeConfigPath = join(
    freshRoot,
    "infrastructure/rehearsal/supabase/config.toml",
  );
  const beforeRecoveryConfig = await readFile(freshConfigPath, "utf8");
  const databasePort = Number(
    /databasePort:\s*(\d+)/u.exec(beforeRecoveryConfig)?.[1],
  );
  assert.ok(Number.isInteger(databasePort));
  await rm(freshRuntimeConfigPath);
  const occupiedServer = await listen(databasePort);
  const occupied = executeCli(freshRoot, ["setup", "--write", "--json"]);
  await close(occupiedServer);
  assert.notEqual(occupied.status, 0);
  assert.match(
    `${occupied.stdout}\n${occupied.stderr}`,
    /ports became occupied/iu,
  );
  await assert.rejects(readFile(freshRuntimeConfigPath, "utf8"), {
    code: "ENOENT",
  });
  const recovered = runCliJson(freshRoot, ["setup", "--write"]);
  assert.equal(
    recovered.data.files.find(
      ({ path }) => path === "infrastructure/rehearsal/supabase/config.toml",
    )?.action,
    "create",
  );
  assert.equal(await readFile(freshConfigPath, "utf8"), beforeRecoveryConfig);

  const credentialCanary = "onboarding-secret-must-not-appear";
  await writeFile(
    freshConfigPath,
    enableGeneratedGoogleAuthentication(beforeRecoveryConfig),
  );
  const missingCredentials = executeCli(freshRoot, ["doctor", "--json"], {
    environment: {
      REHEARSAL_GOOGLE_CLIENT_ID: credentialCanary,
      REHEARSAL_GOOGLE_CLIENT_SECRET: credentialCanary,
    },
  });
  assert.notEqual(missingCredentials.status, 0);
  const missingCredentialReport = JSON.parse(missingCredentials.stdout);
  const credentialCheck = missingCredentialReport.data.checks.find(
    ({ id }) => id === "service-environment",
  );
  assert.equal(credentialCheck.status, "fail");
  assert.match(credentialCheck.detail, /environment file is missing/iu);
  assert.doesNotMatch(
    missingCredentials.stdout,
    new RegExp(credentialCanary, "u"),
  );
  await writeFile(freshConfigPath, beforeRecoveryConfig);

  const postgresqlRoot = join(temporaryRoot, "fresh-postgresql-consumer");
  await createConsumer(postgresqlRoot, "fresh-postgresql-consumer", {
    target: "postgresql",
  });
  install(postgresqlRoot, tarball);
  const postgresqlConfig = await readFile(
    join(postgresqlRoot, "rehearsal.config.mjs"),
    "utf8",
  );
  assert.match(postgresqlConfig, /target: "postgresql"/u);
  assert.match(postgresqlConfig, /image: "postgres:17-alpine"/u);
  assert.match(postgresqlConfig, /migrationDirectory: "database\/migrations"/u);
  await assert.rejects(
    readFile(
      join(postgresqlRoot, "infrastructure/rehearsal/supabase/config.toml"),
      "utf8",
    ),
    { code: "ENOENT" },
  );
  const postgresqlConfigPath = join(postgresqlRoot, "rehearsal.config.mjs");
  await writeFile(
    postgresqlConfigPath,
    postgresqlConfig.replace('target: "postgresql"', 'target: "sqlite"'),
  );
  const unsupportedTarget = executeCli(postgresqlRoot, ["doctor", "--json"]);
  assert.notEqual(unsupportedTarget.status, 0);
  assert.match(
    unsupportedTarget.stdout,
    /unsupported rehearsal (?:runtime )?target: sqlite/iu,
  );
  await writeFile(postgresqlConfigPath, postgresqlConfig);

  const malformedRoot = join(temporaryRoot, "malformed-consumer");
  await createConsumer(malformedRoot, "malformed-onboarding-consumer");
  const malformedPath = join(malformedRoot, "rehearsal.config.mjs");
  const malformedSource =
    "export default { schemaVersion: 999, runtime: { target: 'sqlite' } };\n";
  await writeFile(malformedPath, malformedSource);
  install(malformedRoot, tarball);
  assert.equal(await readFile(malformedPath, "utf8"), malformedSource);
  const malformedDoctor = executeCli(malformedRoot, ["doctor", "--json"]);
  assert.notEqual(malformedDoctor.status, 0);
  const malformedReport = JSON.parse(malformedDoctor.stdout);
  assert.equal(malformedReport.data.checks[0].status, "fail");
  assert.match(
    JSON.stringify(malformedReport.data.checks[0]),
    /schemaVersion|configuration|runtime-topology/iu,
  );
  await rename(malformedPath, `${malformedPath}.invalid`);
  const malformedRecovery = runCliJson(malformedRoot, ["setup", "--write"]);
  assert.equal(malformedRecovery.data.mode, "written");
  assert.match(await readFile(malformedPath, "utf8"), /target: "supabase"/u);

  const upgradeRoot = join(temporaryRoot, "upgrade-consumer");
  await createConsumer(upgradeRoot, "upgrade-onboarding-consumer");
  install(upgradeRoot, "@rehearsal-db/core@0.1.0-beta.7");
  runCliJson(upgradeRoot, ["setup", "--write"]);
  const upgradeConfigPath = join(upgradeRoot, "rehearsal.config.mjs");
  await appendFile(upgradeConfigPath, "\n// user-owned upgrade marker\n");
  const upgradeRuntimeConfigPath = join(
    upgradeRoot,
    "infrastructure/rehearsal/supabase/config.toml",
  );
  const beforeUpgrade = await readFile(upgradeConfigPath, "utf8");
  const beforeRuntimeConfig = await readFile(upgradeRuntimeConfigPath, "utf8");

  install(upgradeRoot, tarball);
  const afterUpgrade = await readFile(upgradeConfigPath, "utf8");
  const afterRuntimeConfig = await readFile(upgradeRuntimeConfigPath, "utf8");
  const upgradeInit = runInit(upgradeRoot);
  assert.equal(sha256(afterUpgrade), sha256(beforeUpgrade));
  assert.equal(afterUpgrade, beforeUpgrade);
  assert.equal(afterRuntimeConfig, beforeRuntimeConfig);
  assert.match(afterUpgrade, /user-owned upgrade marker/u);
  assert.equal(upgradeInit.data.mode, "current-template");
  assert.match(upgradeInit.data.source, /authentication:/u);
  assert.equal(
    upgradeInit.data.availableOptions[0]?.path,
    "supabase.authentication",
  );
  assert.match(
    upgradeInit.data.availableOptions[0]?.summary,
    /Google or GitHub/iu,
  );

  console.log(
    JSON.stringify(
      {
        status: "passed",
        fixture: "packed-package-onboarding",
        installedPackage: `${artifact.name}@${artifact.version}`,
        artifactSha256: artifact.sha256,
        artifactSource: artifact.source,
        freshRootConfigCreated: true,
        freshRootConfigValidated: true,
        freshInstallReportedActiveConfig: true,
        nestedConfigPreservedAndReported: true,
        existingRootConfigPreservedAndReported: true,
        repeatInstallPreservedAndReported: true,
        postgresqlRootConfigCreated: true,
        occupiedPortRefusedBeforeRecovery: true,
        partialSetupRecovered: true,
        missingCredentialsRefused: true,
        unsupportedTargetRefused: true,
        malformedConfigurationPreservedAndRecovered: true,
        beta7ConfigPreserved: true,
        beta7ConfigSha256: sha256(afterUpgrade),
        authenticationOptionDiscoverable: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
