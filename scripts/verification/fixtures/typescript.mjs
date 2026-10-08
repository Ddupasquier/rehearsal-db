/** Verify the packed package's CLI, exports, and declarations as an installed consumer. */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installCandidateArtifact,
  prepareCandidateArtifact,
} from "../scenarios/artifact.mjs";
import { runScenarioCommand } from "../scenarios/process.mjs";
import {
  createScenarioWorkspace,
  removeScenarioWorkspace,
} from "../scenarios/workspace.mjs";

const repositoryRoot = process.cwd();
const workspace = await createScenarioWorkspace({
  prefix: "rehearsal-typescript-",
});
const temporaryRoot = workspace.projectRoot;

try {
  const artifact = await prepareCandidateArtifact({
    repositoryRoot,
    outputDirectory: workspace.packageOutput,
  });

  await writeFile(
    join(temporaryRoot, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  installCandidateArtifact(temporaryRoot, artifact, {
    additionalSpecifications: ["@types/node@22.20.5"],
  });

  await writeFile(
    join(temporaryRoot, "consumer.mts"),
    `import { defineRehearsalConfig, type RehearsalConfig } from "@rehearsal-db/core";
import {
  createCleanProcessEnvironment,
  type ProcessEnvironment,
} from "@rehearsal-db/core/process-environment";

const config = defineRehearsalConfig({
  schemaVersion: 1,
  project: { name: "packed-typescript-consumer" },
  postgresql: { migrationDirectory: "migrations" },
  baseline: { sanitizationPolicy: "rehearsal/sanitization-policy.json" },
  application: { startCommand: "npm run dev", proofCommand: "npm test" },
  runtime: { target: "postgresql", databasePort: 55432 },
});

const source: ProcessEnvironment = { PATH: "/usr/bin", SECRET: undefined };
const clean = createCleanProcessEnvironment({ inheritedEnvironment: source });
const publicConfig: RehearsalConfig = config;

void clean;
void publicConfig;
`,
  );
  await writeFile(
    join(temporaryRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2023",
          types: ["node"],
        },
        files: ["consumer.mts"],
      },
      null,
      2,
    )}\n`,
  );

  const compiler = join(repositoryRoot, "node_modules/typescript/bin/tsc");
  runScenarioCommand(
    process.execPath,
    [compiler, "--project", "tsconfig.json"],
    { cwd: temporaryRoot },
  );

  const cli = join(
    temporaryRoot,
    "node_modules/@rehearsal-db/core/dist/src/cli/rehearsal.mjs",
  );
  const versionOutput = runScenarioCommand(
    process.execPath,
    [cli, "--version"],
    { cwd: temporaryRoot },
  );
  const manifest = JSON.parse(
    await readFile(
      join(temporaryRoot, "node_modules/@rehearsal-db/core/package.json"),
      "utf8",
    ),
  );
  if (versionOutput.trim() !== manifest.version) {
    throw new Error(
      "The installed TypeScript candidate reported the wrong version.",
    );
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        fixture: "packed-typescript-consumer",
        installedPackage: `${manifest.name}@${manifest.version}`,
        artifactSha256: artifact.sha256,
        artifactSource: artifact.source,
        rootTypes: true,
        subpathTypes: true,
        compiledCli: true,
      },
      null,
      2,
    ),
  );
} finally {
  await removeScenarioWorkspace(workspace);
}
