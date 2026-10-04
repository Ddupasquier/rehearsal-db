/**
 * Prove root-config onboarding from the packed package and a published beta.11
 * upgrade without touching either consumer's existing configuration.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
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

const sha256 = (source) => createHash("sha256").update(source).digest("hex");

const createConsumer = async (root, name) => {
  await mkdir(join(root, "supabase/migrations"), { recursive: true });
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
  await writeFile(
    join(root, "supabase/config.toml"),
    `project_id = ${JSON.stringify(name)}\n\n[db]\nmajor_version = 17\n`,
  );
  await writeFile(join(root, ".gitignore"), "node_modules/\nproject-cache/\n");
};

const install = (root, specification) =>
  run(
    "npm",
    ["install", "--save-dev", "--no-audit", "--no-fund", specification],
    { cwd: root },
  );

const runInit = (root) =>
  JSON.parse(
    run(join(root, "node_modules/.bin/rehearsal"), ["init", "--json"], {
      cwd: root,
    }),
  );

try {
  await mkdir(packedRoot, { recursive: true });
  const packed = JSON.parse(
    run("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packedRoot,
    ]),
  )[0];
  assert.equal(packed.name, "@rehearsal-db/core");
  assert.equal(packed.version, "0.1.0-beta.12");
  const tarball = join(packedRoot, packed.filename);
  const artifactSha256 = sha256(await readFile(tarball));

  const freshRoot = join(temporaryRoot, "fresh-consumer");
  await createConsumer(freshRoot, "fresh-onboarding-consumer");
  install(freshRoot, tarball);
  const freshConfig = await readFile(
    join(freshRoot, "rehearsal.config.mjs"),
    "utf8",
  );
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

  const upgradeRoot = join(temporaryRoot, "upgrade-consumer");
  await createConsumer(upgradeRoot, "upgrade-onboarding-consumer");
  install(upgradeRoot, "@rehearsal-db/core@0.1.0-beta.11");
  const upgradeConfigPath = join(upgradeRoot, "rehearsal.config.mjs");
  const beta11Config = await readFile(upgradeConfigPath, "utf8");
  const legacyConfig = beta11Config
    .replace(
      'runtimeWorkdir: ".rehearsal/runtime",',
      'runtimeWorkdir: ".rehearsal/runtime",\n    serviceEnvironmentFile: ".env.rehearsal-service.local",\n    serviceEnvironmentVariables: ["LEGACY_GOOGLE_CLIENT_ID", "LEGACY_GOOGLE_SECRET"],',
    )
    .replace(
      'hostedAccess: "disabled",',
      'authenticationProviders: ["google"],\n    hostedAccess: "disabled",',
    );
  assert.notEqual(legacyConfig, beta11Config);
  await writeFile(upgradeConfigPath, legacyConfig);
  await appendFile(upgradeConfigPath, "\n// user-owned upgrade marker\n");
  const upgradeRuntimeConfigPath = join(
    upgradeRoot,
    "infrastructure/rehearsal/supabase/config.toml",
  );
  const beta11RuntimeConfig = await readFile(upgradeRuntimeConfigPath, "utf8");
  await writeFile(
    upgradeRuntimeConfigPath,
    `${beta11RuntimeConfig.trimEnd()}

[auth.external.google]
enabled = true
client_id = "env(LEGACY_GOOGLE_CLIENT_ID)"
secret = "env(LEGACY_GOOGLE_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"
skip_nonce_check = true
email_optional = false
`,
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
    /replace the legacy provider fields together/iu,
  );

  console.log(
    JSON.stringify(
      {
        status: "passed",
        fixture: "packed-package-onboarding",
        installedPackage: `${packed.name}@${packed.version}`,
        artifactSha256,
        freshRootConfigCreated: true,
        freshRootConfigValidated: true,
        beta11ConfigPreserved: true,
        beta11ConfigSha256: sha256(afterUpgrade),
        authenticationOptionDiscoverable: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
