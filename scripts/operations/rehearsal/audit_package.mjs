/**
 * Prove that the candidate npm artifact contains only the reviewed public package
 * surface and no credentials, runtime state, baselines, or project-owned data.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const forbiddenPathPattern =
  /(?:^|\/)(?:\.env(?:\.|$)|\.rehearsal|baseline-manifest\.json|sanitized-data\.ndjson|sanitization-policy\.json|project-items\.json|test-results|coverage|logs?)(?:\/|$)/iu;
const forbiddenContentPatterns = [
  /\b(?:postgres(?:ql)?):\/\/[^\s"']+@/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\bsb_secret_[A-Za-z0-9_-]+\b/u,
];
const forbiddenProjectPatterns = [
  new RegExp(`\\b${["BLEND", "CALC"].join("")}_[A-Z0-9_]+\\b`, "u"),
  new RegExp(`@${["blend", "calc"].join("")}\\.local\\b`, "iu"),
  new RegExp(["Blend", "Calc"].join(""), "iu"),
  new RegExp(["blend", "calc", "api"].join(""), "iu"),
  /\/Volumes\/Hobby/iu,
];

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed.`);
  }
  return result.stdout;
};

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const packed = JSON.parse(
  run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]),
)[0];
const paths = packed.files.map(({ path }) => path).sort();
for (const required of [
  "README.md",
  "package.json",
  "scripts/operations/rehearsal/rehearsal_cli.mjs",
  "scripts/operations/database/manage_rehearsal_database.mjs",
]) {
  if (!paths.includes(required)) {
    throw new Error(`Package is missing required public file ${required}.`);
  }
}
for (const repositoryOnly of [
  "scripts/operations/rehearsal/audit_package.mjs",
  "scripts/operations/rehearsal/prove_independent_fixture.mjs",
]) {
  if (paths.includes(repositoryOnly)) {
    throw new Error(`Package includes repository-only file ${repositoryOnly}.`);
  }
}
const forbiddenPaths = paths.filter((path) => forbiddenPathPattern.test(path));
if (forbiddenPaths.length > 0) {
  throw new Error(
    `Package contains forbidden paths: ${forbiddenPaths.join(", ")}.`,
  );
}

for (const path of paths.filter((value) =>
  /\.(?:mjs|js|json|md|mts)$/u.test(value),
)) {
  const content = await readFile(path, "utf8");
  for (const pattern of forbiddenContentPatterns) {
    if (pattern.test(content)) {
      throw new Error(`Package contains a secret-like value in ${path}.`);
    }
  }
  for (const pattern of forbiddenProjectPatterns) {
    if (pattern.test(content)) {
      throw new Error(`Package contains project-specific content in ${path}.`);
    }
  }
}

console.log(
  JSON.stringify(
    {
      status: "passed",
      name: manifest.name,
      version: manifest.version,
      files: paths.length,
      unpackedBytes: packed.unpackedSize,
      forbiddenFiles: 0,
      publicationBlocked: manifest.private === true,
    },
    null,
    2,
  ),
);
