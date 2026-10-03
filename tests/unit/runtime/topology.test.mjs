import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeTopology } from "../../../src/runtime/topology.mjs";

const roots = [];

const source = ({
  name,
  projectId,
  artifactDirectory,
  databasePort,
  dependencies = "",
}) => `export default {
  schemaVersion: 1,
  project: { name: ${JSON.stringify(name)} },
  postgresql: {
    migrationDirectory: ${JSON.stringify(`${name}/migrations`)},
    runtimeWorkdir: ${JSON.stringify(`${artifactDirectory}/runtime`)},
    image: "postgres:17-alpine",
    database: "postgres",
    user: "postgres",
  },
  baseline: {
    artifactDirectory: ${JSON.stringify(artifactDirectory)},
    sanitizationPolicy: ${JSON.stringify(`${name}/policy.json`)},
  },
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm test",
    environmentFile: ${JSON.stringify(`${artifactDirectory}/runtime.env`)},
  },
  runtime: {
    target: "postgresql",
    projectId: ${JSON.stringify(projectId)},
    databasePort: ${databasePort},
  },
  safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
  ${dependencies}
};\n`;

const makeTopology = async ({
  dependentPort = 58422,
  dependentName = "publication",
  nested = false,
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-topology-test-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "primary/migrations"), { recursive: true }),
    mkdir(join(root, "publication/migrations"), { recursive: true }),
  ]);
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    source({
      name: "primary-project",
      projectId: "primary-rehearsal",
      artifactDirectory: "primary/.rehearsal",
      databasePort: 58322,
      dependencies: `dependentTargets: [{ name: ${JSON.stringify(dependentName)}, configPath: "rehearsal.publication.config.mjs", prepareCommand: "npm run prepare:publication" }],`,
    }),
  );
  await writeFile(
    join(root, "rehearsal.publication.config.mjs"),
    source({
      name: "publication-project",
      projectId: "publication-rehearsal",
      artifactDirectory: "publication/.rehearsal",
      databasePort: dependentPort,
      dependencies: nested
        ? 'dependentTargets: [{ name: "nested", configPath: "nested.mjs" }],'
        : "",
    }),
  );
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("dependent runtime topology", () => {
  it("loads isolated primary and dependent runtime configs", async () => {
    const root = await makeTopology();
    const topology = await loadRuntimeTopology({ projectRoot: root });

    expect(topology.targets.map((target) => target.name)).toEqual([
      "primary",
      "publication",
    ]);
    expect(topology.dependents[0].declaration.prepareCommand).toBe(
      "npm run prepare:publication",
    );
  });

  it("rejects port collisions and nested dependency graphs", async () => {
    const collisionRoot = await makeTopology({ dependentPort: 58322 });
    await expect(
      loadRuntimeTopology({ projectRoot: collisionRoot }),
    ).rejects.toThrow("runtime port 58322 must be unique");

    const nestedRoot = await makeTopology({ nested: true });
    await expect(
      loadRuntimeTopology({ projectRoot: nestedRoot }),
    ).rejects.toThrow("cannot declare its own dependentTargets");

    const reservedNameRoot = await makeTopology({ dependentName: "primary" });
    await expect(
      loadRuntimeTopology({ projectRoot: reservedNameRoot }),
    ).rejects.toThrow("target name primary must be unique");
  });
});
