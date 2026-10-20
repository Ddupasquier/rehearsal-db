/** Installed-package OS smoke; no container engine or database operation is started. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCleanProcessEnvironment } from "../../dist/src/shared/process_environment.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = join(root, "test-results/platform");
const environment = createCleanProcessEnvironment({
  overrides: { REHEARSAL_UPDATE_CHECK: "off" },
});
const run = (args, cwd = root, timeout = 120_000) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
};
const succeeded = (args, cwd) => {
  const result = run(args, cwd);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
const npmCandidates = [
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
];
let npmCli;
for (const candidate of npmCandidates) {
  try {
    await access(candidate);
    npmCli = candidate;
    break;
  } catch {
    /* try the next documented Node layout */
  }
}
assert.ok(npmCli, "The Node installation must include npm's JavaScript CLI.");

const temporary = await mkdtemp(join(tmpdir(), "rehearsal-platform-"));
try {
  const [packed] = JSON.parse(
    succeeded([
      npmCli,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporary,
    ]),
  );
  assert.equal(packed.name, "@rehearsal-db/core");
  assert.equal(packed.version, metadata.version);
  assert.equal(basename(packed.filename), packed.filename);
  const tarball = join(temporary, packed.filename);
  const artifactSha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  const project = join(temporary, "project with spaces café");
  await mkdir(project);
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "platform-smoke", private: true }),
  );
  succeeded(
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      tarball,
    ],
    project,
  );
  const installedRoot = join(project, "node_modules/@rehearsal-db/core");
  const installed = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(installed.version, metadata.version);
  const cli = join(installedRoot, "dist/src/cli/rehearsal.mjs");
  const version = JSON.parse(
    succeeded([cli, "--version", "--json", "--plain"], project),
  );
  assert.equal(version.name, "@rehearsal-db/core");
  assert.equal(version.version, metadata.version);
  assert.match(succeeded([cli, "--help"], project), /rehearsal/iu);
  const discovery = JSON.parse(
    succeeded([cli, "discover", "--json", "--plain"], project),
  );
  assert.equal(discovery.schemaVersion, 1);
  assert.equal(discovery.status, "success");
  let nativeRuntime = "not-exercised";
  if (process.platform === "win32") {
    // A missing config makes an accidental regression non-mutating. The expected
    // Windows refusal must precede even configuration access, not fail as bad config.
    for (const command of ["doctor", "start"]) {
      const result = run(
        [
          cli,
          command,
          "--json",
          "--plain",
          "--config=missing-platform-smoke.config.mjs",
        ],
        project,
      );
      assert.notEqual(result.status, 0);
      const refusal = JSON.parse(result.stdout);
      if (command === "doctor") {
        assert.equal(refusal.status, "not_ready");
        assert.equal(refusal.data.state, "NOT READY");
        const [operatingSystem] = refusal.data.checks;
        assert.equal(operatingSystem.id, "operating-system");
        assert.equal(operatingSystem.status, "fail");
        assert.match(operatingSystem.remediation, /WSL\s*2/iu);
      } else {
        assert.equal(refusal.status, "error");
        assert.equal(refusal.error.code, "HOST_PLATFORM_UNSUPPORTED");
        assert.match(refusal.error.message, /Windows/iu);
        assert.match(JSON.stringify(refusal.error), /WSL\s*2/iu);
      }
    }
    nativeRuntime = "explicitly-refused-use-wsl2";
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, `node-${process.platform}-${process.arch}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "passed",
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        version: installed.version,
        artifactSha256,
        installedVersion: "passed",
        help: "passed",
        discovery: "passed",
        pathWithSpacesAndUnicode: "passed",
        installScripts: "disabled",
        nativeRuntime,
        databaseOperations: "not-performed",
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Installed CLI smoke passed: ${process.platform}/${process.arch}; database runtime ${nativeRuntime}.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
