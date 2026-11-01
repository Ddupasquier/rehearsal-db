/** Installed CLI resource-manager proof with scratch images and no database data. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
} from "../../../dist/src/runtime/engines/local_docker_context.mjs";
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
const identity = `rehearsal-resource-proof-${randomUUID()}`;
const repository = `public.ecr.aws/supabase/${identity}`;
const tags = [`${repository}:v1`, `${repository}:v2`];
const sourceDateEpoch = 1_609_459_200;
let containerId = null;
const createdTags = new Set();
// This is real-engine scratch-resource acceptance, never a fake engine or a DB/VM-memory proof.
// Capture raw selectors before the common scenario process helper sanitizes them.
const inheritedEnvironment = { ...process.env };
const selected = assertLocalDockerContext({ cwd: root, inheritedEnvironment });
const dockerEnvironment = scopedDockerEnvironment({
  inheritedEnvironment,
  endpoint: selected.endpoint,
});
const cliEnvironment = {
  ...scopedDockerEnvironment({ inheritedEnvironment }),
  DOCKER_CONTEXT: selected.context,
  DOCKER_HOST: selected.endpoint,
};
const rawDocker = (args) =>
  runScenarioCommand("docker", ["--host", selected.endpoint, ...args], {
    cwd: root,
    environment: dockerEnvironment,
    timeout: args[0] === "build" ? 300000 : 30000,
  });
const readDaemon = () => {
  const value = JSON.parse(rawDocker(["info", "--format", "{{json .ID}}"]));
  assert(
    typeof value === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(value),
    "A finite local daemon identity is required",
  );
  return value;
};
const daemonId = readDaemon();
const assertBinding = () => {
  try {
    const current = assertLocalDockerContext({
      cwd: root,
      inheritedEnvironment,
      context: selected.context,
    });
    assert.equal(current.identity, selected.identity);
    assert.equal(current.dockerConfig, selected.dockerConfig);
    assert.equal(readDaemon(), daemonId);
  } catch {
    throw new Error(
      `Resource fixture engine binding changed or is unavailable. No further resource action is permitted; preserve scratch recovery at ${root}.`,
    );
  }
};
const docker = (args) => {
  assertBinding();
  return rawDocker(args);
};
const installedCli = (args, throwing = false) => {
  assertBinding();
  return (throwing ? executeInstalledCliOrThrow : executeInstalledCli)({
    cwd: root,
    args,
    environment: cliEnvironment,
  });
};
const ids = (value) => value.trim().split(/\s+/u).filter(Boolean);
const before = {
  containers: ids(
    docker(["container", "ls", "--all", "--quiet", "--no-trunc"]),
  ),
  volumes: ids(docker(["volume", "ls", "--quiet"])),
};
const json = (args) =>
  JSON.parse(installedCli([...args, "--json"], true).stdout).data;
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
    assert.deepEqual(
      ids(docker(["image", "ls", "--quiet", "--no-trunc", tag])),
      [],
      "A scratch build must never replace an existing image tag",
    );
    await writeFile(
      join(root, "Dockerfile"),
      `FROM scratch\nLABEL com.rehearsal-db.resource-test="${identity}"\nLABEL com.rehearsal-db.generation="${index}"\nCMD ["/never-executed"]\n`,
    );
    // Metadata-only scratch builds can omit Created. Give these synthetic images
    // explicit ages using Dockerfile 1.5 / BuildKit 0.11+'s predefined build arg.
    // https://docs.docker.com/reference/dockerfile/#buildkit-built-in-build-args
    createdTags.add(tag);
    docker([
      "build",
      "--quiet",
      "--build-arg",
      `SOURCE_DATE_EPOCH=${sourceDateEpoch + index}`,
      "--tag",
      tag,
      root,
    ]);
  }
  const creationTimes = tags.map((tag, index) => {
    const [image] = JSON.parse(docker(["image", "inspect", tag]));
    assert.equal(
      image.Config?.Labels?.["com.rehearsal-db.resource-test"],
      identity,
    );
    const createdAt = Date.parse(image.Created ?? "");
    assert(Number.isFinite(createdAt), "Scratch images must expose Created");
    assert.equal(
      createdAt,
      (sourceDateEpoch + index) * 1000,
      "Scratch image creation must honor the explicit SOURCE_DATE_EPOCH",
    );
    return createdAt;
  });
  assert(creationTimes[0] < creationTimes[1], "Scratch v1 must predate v2");
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
  const refused = installedCli([...selection, "--json"]);
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
  assert.equal(preview.plan.docker.engineIdentity, selected.identity);
  assert.equal(preview.plan.docker.daemonId, daemonId);
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
    const result = installedCli([operation, "--json"]);
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
          "reviewed context/endpoint/client config retained",
          "same daemon revalidated before resource and cleanup commands",
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
  for (const tag of createdTags) {
    const available = JSON.parse(
      docker(["image", "ls", "--format", "{{json .Repository}}", tag]).trim() ||
        "null",
    );
    if (available) {
      assert.equal(
        docker([
          "image",
          "inspect",
          "--format",
          '{{index .Config.Labels "com.rehearsal-db.resource-test"}}',
          tag,
        ]).trim(),
        identity,
        "Only this fixture's labelled scratch tag may be removed",
      );
      docker(["image", "rm", tag]);
    }
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
