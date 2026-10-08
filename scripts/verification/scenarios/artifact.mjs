/** Pack once or select an exact candidate artifact, then install those bytes. */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { runScenarioCommand } from "./process.mjs";

export const sha256Value = (value) =>
  createHash("sha256").update(value).digest("hex");

export const sha256File = async (path) => sha256Value(await readFile(path));

const requireArtifact = async (path) => {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new Error(`Candidate artifact is not a regular file: ${path}`);
  }
};

const readPackedManifest = (artifactPath, repositoryRoot) =>
  JSON.parse(
    runScenarioCommand("tar", ["-xOf", artifactPath, "package/package.json"], {
      cwd: repositoryRoot,
    }),
  );

export const prepareCandidateArtifact = async ({
  repositoryRoot,
  outputDirectory,
  requestedArtifact = process.env.REHEARSAL_CANDIDATE_ARTIFACT,
}) => {
  await mkdir(outputDirectory, { recursive: true });
  let artifactPath;
  let source;
  if (requestedArtifact?.trim()) {
    artifactPath = isAbsolute(requestedArtifact)
      ? requestedArtifact
      : resolve(repositoryRoot, requestedArtifact);
    await requireArtifact(artifactPath);
    source = "provided";
  } else {
    const [packed] = JSON.parse(
      runScenarioCommand(
        "npm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          outputDirectory,
        ],
        { cwd: repositoryRoot },
      ),
    );
    artifactPath = join(outputDirectory, basename(packed.filename));
    await requireArtifact(artifactPath);
    source = "packed";
  }
  const manifest = readPackedManifest(artifactPath, repositoryRoot);
  if (manifest.name !== "@rehearsal-db/core") {
    throw new Error(
      `Candidate artifact contains unexpected package ${String(manifest.name)}.`,
    );
  }
  return Object.freeze({
    path: artifactPath,
    sha256: await sha256File(artifactPath),
    name: manifest.name,
    version: manifest.version,
    source,
  });
};

export const installCandidateArtifact = (
  cwd,
  artifact,
  {
    additionalSpecifications = [],
    saveDev = false,
    runInstallScripts = false,
  } = {},
) =>
  runScenarioCommand(
    "npm",
    [
      "install",
      ...(saveDev ? ["--save-dev"] : ["--no-save"]),
      "--no-audit",
      "--no-fund",
      ...(runInstallScripts ? ["--foreground-scripts"] : ["--ignore-scripts"]),
      artifact.path,
      ...additionalSpecifications,
    ],
    { cwd, inheritEnvironment: true },
  );
