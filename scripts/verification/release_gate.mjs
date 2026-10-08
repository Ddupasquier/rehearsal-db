/** Run every installed-consumer scenario against one immutable package artifact. */

import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCandidateArtifact, sha256File } from "./scenarios/artifact.mjs";
import { verificationScenarios } from "./scenarios/catalog.mjs";
import {
  commandFailureText,
  spawnScenarioCommand,
} from "./scenarios/process.mjs";

const repositoryRoot = process.cwd();
const help = process.argv
  .slice(2)
  .some((argument) => ["--help", "-h"].includes(argument));
if (help) {
  console.log(`Usage: npm run release:verify

Builds one exact candidate artifact, runs the complete package gate, then runs every
installed-consumer scenario against those same bytes. Set REHEARSAL_CANDIDATE_ARTIFACT
to verify an existing absolute or repository-relative tarball instead of repacking.
Evidence is written to test-results/release-gate/.`);
  process.exit(0);
}
if (process.argv.length !== 2) {
  throw new Error("release:verify does not accept positional arguments.");
}

const startedAt = new Date();
const runId = startedAt.toISOString().replaceAll(/[:.]/gu, "-");
const reportDirectory = join(
  repositoryRoot,
  "test-results/release-gate",
  runId,
);
const packingDirectory = await mkdtemp(
  join(tmpdir(), "rehearsal-release-gate-"),
);
await mkdir(reportDirectory, { recursive: true });
const results = [];
let artifact;
let failure;

const execute = (id, command, args, environment = {}) => {
  console.log(`→ ${id}`);
  const began = performance.now();
  const result = spawnScenarioCommand(command, args, {
    cwd: repositoryRoot,
    environment,
  });
  const evidence = {
    id,
    command: [command, ...args],
    status: result.status === 0 && !result.error ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Math.round(performance.now() - began),
  };
  results.push(evidence);
  if (evidence.status === "failed") {
    console.log(`✗ ${id}`);
    throw new Error(commandFailureText(result, id), { cause: result.error });
  }
  console.log(`✓ ${id} (${(evidence.durationMs / 1000).toFixed(1)}s)`);
  return result.stdout;
};

try {
  const preparedArtifact = await prepareCandidateArtifact({
    repositoryRoot,
    outputDirectory: packingDirectory,
  });
  const artifactSnapshot = join(reportDirectory, "candidate.tgz");
  await copyFile(preparedArtifact.path, artifactSnapshot);
  if ((await sha256File(artifactSnapshot)) !== preparedArtifact.sha256) {
    throw new Error("Candidate artifact changed while creating evidence.");
  }
  artifact = Object.freeze({
    ...preparedArtifact,
    originalPath: preparedArtifact.path,
    path: artifactSnapshot,
  });
  execute("package", "npm", ["run", "check"]);
  for (const { id, file } of verificationScenarios) {
    const stdout = execute(id, process.execPath, [file], {
      REHEARSAL_CANDIDATE_ARTIFACT: artifact.path,
    });
    const reported = JSON.parse(stdout);
    if (
      reported.status !== "passed" ||
      reported.artifactSha256 !== artifact.sha256
    ) {
      throw new Error(`${id} did not report the exact accepted artifact.`);
    }
  }
} catch (error) {
  failure = error;
} finally {
  await rm(packingDirectory, { recursive: true, force: true });
  const completedAt = new Date();
  const versionOf = (command, args) => {
    const result = spawnScenarioCommand(command, args, {
      cwd: repositoryRoot,
      inheritEnvironment: true,
    });
    return result.status === 0
      ? (result.stdout || result.stderr).trim().split("\n")[0]
      : "unavailable";
  };
  const report = {
    schemaVersion: 1,
    status: failure ? "failed" : "passed",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    environment: {
      node: process.versions.node,
      npm: versionOf("npm", ["--version"]),
      docker: versionOf("docker", [
        "version",
        "--format",
        "{{.Server.Version}}",
      ]),
      supabase: versionOf("supabase", ["--version"]),
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
    },
    artifact,
    results,
    error: failure instanceof Error ? failure.message : null,
  };
  await writeFile(
    join(reportDirectory, "acceptance.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const markdown = `# Rehearsal release gate

- Status: **${report.status.toUpperCase()}**
- Package: ${artifact ? `\`${artifact.name}@${artifact.version}\`` : "unavailable"}
- SHA-256: ${artifact ? `\`${artifact.sha256}\`` : "unavailable"}
- Node.js: ${report.environment.node}
- npm: ${report.environment.npm}
- Docker: ${report.environment.docker}
- Supabase CLI: ${report.environment.supabase}
- Platform: ${report.environment.platform} ${report.environment.architecture} (${report.environment.osRelease})
- Started: ${report.startedAt}
- Completed: ${report.completedAt}

| Scenario | Result | Duration |
| --- | --- | ---: |
${results.map((result) => `| ${result.id} | ${result.status} | ${(result.durationMs / 1000).toFixed(1)}s |`).join("\n")}
${failure ? `\nFailure: ${report.error}\n` : ""}`;
  await writeFile(join(reportDirectory, "acceptance.md"), markdown);
  console.log(`Release report: ${join(reportDirectory, "acceptance.md")}`);
}

if (failure) throw failure;
console.log(
  `Release gate passed for ${artifact.name}@${artifact.version} (${artifact.sha256}).`,
);
