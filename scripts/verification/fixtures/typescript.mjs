/** Verify the packed package's CLI, exports, and declarations as an installed consumer. */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = process.cwd();
const temporaryRoot = await mkdtemp(join(tmpdir(), "rehearsal-typescript-"));

try {
  const { stdout: packOutput } = await execute(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot],
    { cwd: repositoryRoot },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const artifactPath = join(temporaryRoot, basename(filename));

  await writeFile(
    join(temporaryRoot, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await execute(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      artifactPath,
      "@types/node@22.20.5",
    ],
    { cwd: temporaryRoot },
  );

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
  await execute(process.execPath, [compiler, "--project", "tsconfig.json"], {
    cwd: temporaryRoot,
  });

  const cli = join(
    temporaryRoot,
    "node_modules/@rehearsal-db/core/dist/src/cli/rehearsal.mjs",
  );
  const { stdout: versionOutput } = await execute(
    process.execPath,
    [cli, "--version"],
    {
      cwd: temporaryRoot,
    },
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
        rootTypes: true,
        subpathTypes: true,
        compiledCli: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
