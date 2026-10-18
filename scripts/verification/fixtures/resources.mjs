/** Installed CLI resource-manager proof with scratch images and no database data. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createScenarioWorkspace,
  removeScenarioWorkspace,
} from "../scenarios/workspace.mjs";
import {
  prepareCandidateArtifact,
  installCandidateArtifact,
} from "../scenarios/artifact.mjs";
import {
  runScenarioCommand,
  executeInstalledCli,
  executeInstalledCliOrThrow,
} from "../scenarios/process.mjs";

const workspace = await createScenarioWorkspace({
  prefix: "rehearsal-resource-proof-",
});
const root = workspace.projectRoot;
const identity = `rehearsal-resource-proof-${randomUUID().slice(0, 8)}`;
const repository = `public.ecr.aws/supabase/${identity}`;
const tags = [`${repository}:v1`, `${repository}:v2`];
let containerId = null;
const docker = (args) => runScenarioCommand("docker", args, { cwd: root });
const ids = (value) => value.trim().split(/\s+/u).filter(Boolean);
const before = {
  containers: ids(
    docker(["container", "ls", "--all", "--quiet", "--no-trunc"]),
  ),
  volumes: ids(docker(["volume", "ls", "--quiet"])),
};
const json = (args) =>
  JSON.parse(
    executeInstalledCliOrThrow({ cwd: root, args: [...args, "--json"] }).stdout,
  ).data;
try {
  const artifact = await prepareCandidateArtifact({
    repositoryRoot: process.cwd(),
    outputDirectory: workspace.packageOutput,
  });
  await mkdir(join(root, "database/migrations"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: identity, private: true }),
  );
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `export default {schemaVersion:1,project:{name:${JSON.stringify(identity)}},postgresql:{migrationDirectory:"database/migrations"},baseline:{sanitizationPolicy:"policy.json"},application:{startCommand:"node app.mjs",proofCommand:"node proof.mjs"},runtime:{target:"postgresql",projectId:${JSON.stringify(identity)},displayName:"Protected scratch sandbox",protected:true,databasePort:59999}};`,
  );
  installCandidateArtifact(root, artifact);
  for (const [index, tag] of tags.entries()) {
    await writeFile(
      join(root, "Dockerfile"),
      `FROM scratch\nLABEL com.rehearsal-db.resource-test="${identity}"\nLABEL com.rehearsal-db.generation="${index}"\nCMD ["/never-executed"]\n`,
    );
    docker(["build", "--quiet", "--tag", tag, root]);
  }
  const imageId = docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    tags[0],
  ]).trim();
  containerId = docker([
    "create",
    "--name",
    identity,
    "--label",
    `com.rehearsal-db.resource-test=${identity}`,
    tags[0],
  ]).trim();
  let catalog = json(["resources"]).catalog;
  assert.equal(
    catalog.images.find((image) => image.id === imageId).state,
    "in-use",
  );
  const selection = ["cleanup", "--images-only", `--image-id=${imageId}`];
  const refused = executeInstalledCli({
    cwd: root,
    args: [...selection, "--json"],
  });
  assert.notEqual(
    refused.status,
    0,
    "A stopped container must protect its image",
  );
  assert.equal(
    docker([
      "container",
      "inspect",
      "--format",
      '{{index .Config.Labels "com.rehearsal-db.resource-test"}}',
      containerId,
    ]).trim(),
    identity,
  );
  docker(["container", "rm", containerId]);
  containerId = null;
  catalog = json(["resources"]).catalog;
  assert.equal(
    catalog.images.find((image) => image.id === imageId)?.state,
    "candidate",
    "Owned scratch v1 must become a cleanup candidate after its stopped container is removed",
  );
  const preview = json(selection);
  assert.equal(preview.plan.imagesOnly, true);
  assert.deepEqual(preview.plan.baselines.removed, []);
  assert.equal(preview.plan.runtime.included, false);
  assert.deepEqual(
    preview.plan.images.candidates.map((image) => image.id),
    [imageId],
  );
  const applied = json([
    ...selection,
    "--write",
    `--confirm-cleanup=${preview.plan.digest}`,
  ]);
  assert.deepEqual(applied.applied.imagesRemoved, [tags[0]]);
  catalog = json(["resources"]).catalog;
  assert.equal(
    catalog.images.some((image) => image.id === imageId),
    false,
  );
  assert.equal(
    catalog.images.find((image) => image.tags.includes(tags[1])).state,
    "current",
  );
  for (const operation of ["run", "reset", "discard"]) {
    const result = executeInstalledCli({
      cwd: root,
      args: [operation, "--json"],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /protected/iu);
  }
  console.log(
    JSON.stringify(
      {
        status: "passed",
        installedPackage: `${artifact.name}@${artifact.version}`,
        artifactSha256: artifact.sha256,
        artifactSource: artifact.source,
        checks: [
          "stopped-container reference refuses cleanup",
          "exact selected image removed",
          "newest cached image preserved",
          "zero runtime/volume/baseline selection",
          "protected run/reset/discard refused",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Keep diagnostic evidence confined to this run's labelled scratch images.
  // Never dump another project's resources, image configuration or environment.
  try {
    const images = JSON.parse(docker(["image", "inspect", ...tags])).filter(
      (image) =>
        image.Config?.Labels?.["com.rehearsal-db.resource-test"] === identity,
    );
    const ownedIds = new Set(images.map((image) => image.Id));
    const current = json(["resources"]).catalog;
    console.error(
      JSON.stringify({
        diagnostic: "resource-fixture-owned-images",
        images: images.map(({ Id, Created, RepoTags, Size }) => ({
          Id,
          Created: Created ?? null,
          RepoTags,
          Size,
        })),
        catalog: current.images
          .filter((image) => ownedIds.has(image.id))
          .map(({ id, state, references }) => ({
            id,
            state,
            referenceCount: references.length,
          })),
      }),
    );
  } catch {
    console.error("resource-fixture-owned-images: diagnostic unavailable");
  }
  throw error;
} finally {
  if (containerId) {
    assert.equal(
      docker([
        "container",
        "inspect",
        "--format",
        '{{index .Config.Labels "com.rehearsal-db.resource-test"}}',
        containerId,
      ]).trim(),
      identity,
    );
    docker(["container", "rm", containerId]);
  }
  const remaining = ids(
    docker(["image", "ls", "--quiet", "--no-trunc", repository]),
  );
  for (const id of new Set(remaining)) {
    assert.equal(
      docker([
        "image",
        "inspect",
        "--format",
        '{{index .Config.Labels "com.rehearsal-db.resource-test"}}',
        id,
      ]).trim(),
      identity,
    );
  }
  for (const tag of tags) {
    const available = JSON.parse(
      docker(["image", "ls", "--format", "{{json .Repository}}", tag]).trim() ||
        "null",
    );
    if (available) docker(["image", "rm", tag]);
  }
  const after = {
    containers: new Set(
      ids(docker(["container", "ls", "--all", "--quiet", "--no-trunc"])),
    ),
    volumes: new Set(ids(docker(["volume", "ls", "--quiet"]))),
  };
  assert(
    before.containers.every((id) => after.containers.has(id)),
    "Existing containers preserved",
  );
  assert(
    before.volumes.every((id) => after.volumes.has(id)),
    "Existing volumes preserved",
  );
  await removeScenarioWorkspace(workspace);
}
