import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeTopology } from "../../../dist/src/runtime/topology.mjs";

const roots = [];

const source = ({
  name,
  projectId,
  artifactDirectory,
  databasePort,
  dependencies = "",
  applicationUrl = "http://localhost:5175",
  readinessUrl,
  profiles = [],
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
    ${readinessUrl ? `readiness: { url: ${JSON.stringify(readinessUrl)}, expectedStatus: 200 },` : ""}
  },
  runtime: {
    target: "postgresql",
    projectId: ${JSON.stringify(projectId)},
    databasePort: ${databasePort},
    applicationUrl: ${JSON.stringify(applicationUrl)},
  },
  profiles: ${JSON.stringify(profiles)},
  safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
  ${dependencies}
};\n`;

const makeTopology = async ({
  dependentPort = 58422,
  dependentName = "publication",
  nested = false,
  primaryApplicationUrl,
  dependentApplicationUrl,
  dependentReadinessUrl,
  primaryProfiles = [],
  dependentProfiles = [],
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
      applicationUrl: primaryApplicationUrl,
      profiles: primaryProfiles,
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
      applicationUrl: dependentApplicationUrl,
      readinessUrl: dependentReadinessUrl,
      profiles: dependentProfiles,
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

  it("refuses application, readiness and named-profile URLs colliding with another target service", async () => {
    for (const options of [
      { primaryApplicationUrl: "http://localhost:58422/" },
      { dependentReadinessUrl: "http://[::1]:58322/health" },
      {
        primaryProfiles: [
          {
            name: "Both targets",
            targets: ["primary", "publication"],
            applicationUrl: "https://127.0.0.1:58422/auth/callback",
          },
        ],
      },
      {
        dependentProfiles: [
          {
            name: "Dependent",
            targets: ["primary"],
            applicationUrl: "http://localhost:58322/",
          },
        ],
      },
    ]) {
      const root = await makeTopology(options);
      await expect(loadRuntimeTopology({ projectRoot: root })).rejects.toThrow(
        /Application endpoint .* conflicts with configured/u,
      );
    }
  });

  it("allows targets to share an application address when no native service uses its port", async () => {
    const root = await makeTopology({
      primaryApplicationUrl: "http://localhost:5175/",
      dependentApplicationUrl: "http://127.0.0.1:5175/",
      dependentReadinessUrl: "http://[::1]:5175/health",
      primaryProfiles: [
        {
          name: "Both targets",
          targets: ["primary", "publication"],
          applicationUrl: "http://localhost:5175/auth/callback",
        },
      ],
    });
    expect(
      (await loadRuntimeTopology({ projectRoot: root })).targets,
    ).toHaveLength(2);
  });
});
