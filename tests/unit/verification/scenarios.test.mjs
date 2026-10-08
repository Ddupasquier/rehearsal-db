import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareCandidateArtifact,
  sha256File,
} from "../../../scripts/verification/scenarios/artifact.mjs";
import {
  findVerificationScenario,
  verificationScenarios,
} from "../../../scripts/verification/scenarios/catalog.mjs";
import {
  runScenarioCommand,
  spawnScenarioCommand,
} from "../../../scripts/verification/scenarios/process.mjs";
import {
  createScenarioWorkspace,
  removeScenarioWorkspace,
} from "../../../scripts/verification/scenarios/workspace.mjs";

describe("installed-consumer scenario harness", () => {
  it("keeps one unique catalog of independently runnable scenario files", async () => {
    const ids = verificationScenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "onboarding",
      "typescript",
      "privacy",
      "postgresql",
      "dependent-target",
      "standalone",
      "supabase",
    ]);
    expect(findVerificationScenario("postgresql")?.id).toBe("postgresql");
    expect(findVerificationScenario("missing")).toBeUndefined();
    for (const scenario of verificationScenarios) {
      await expect(stat(scenario.file)).resolves.toMatchObject({});
    }
  });

  it("copies a fixture into an owned workspace and removes only that root", async () => {
    const fixture = await createScenarioWorkspace({
      prefix: "scenario-source-",
    });
    const source = join(fixture.projectRoot, "canary.txt");
    await writeFile(source, "preserve me\n");
    const workspace = await createScenarioWorkspace({
      prefix: "scenario-copy-",
      fixtureSource: fixture.projectRoot,
    });

    expect(
      await readFile(join(workspace.projectRoot, "canary.txt"), "utf8"),
    ).toBe("preserve me\n");
    await removeScenarioWorkspace(workspace);
    await expect(access(workspace.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(source, "utf8")).resolves.toBe("preserve me\n");
    await removeScenarioWorkspace(fixture);
  });

  it("quarantines blocked inherited credentials while accepting explicit safe values", () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://should-not-reach-child";
    try {
      const result = spawnScenarioCommand(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "console.log(JSON.stringify({ blocked: process.env.DATABASE_URL, safe: process.env.SCENARIO_SAFE }))",
        ],
        { environment: { SCENARIO_SAFE: "yes" } },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ safe: "yes" });
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it("selects and fingerprints one exact package artifact", async () => {
    const workspace = await createScenarioWorkspace({
      prefix: "scenario-artifact-",
    });
    try {
      await writeFile(
        join(workspace.projectRoot, "package.json"),
        `${JSON.stringify({ name: "@rehearsal-db/core", version: "9.9.9" })}\n`,
      );
      await mkdir(workspace.packageOutput, { recursive: true });
      const packed = JSON.parse(
        runScenarioCommand(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            workspace.packageOutput,
          ],
          { cwd: workspace.projectRoot, inheritEnvironment: true },
        ),
      )[0];
      const artifactPath = join(workspace.packageOutput, packed.filename);
      const artifact = await prepareCandidateArtifact({
        repositoryRoot: workspace.projectRoot,
        outputDirectory: workspace.packageOutput,
        requestedArtifact: artifactPath,
      });

      expect(artifact).toMatchObject({
        name: "@rehearsal-db/core",
        version: "9.9.9",
        path: artifactPath,
        source: "provided",
      });
      expect(artifact.sha256).toBe(await sha256File(artifactPath));
    } finally {
      await removeScenarioWorkspace(workspace);
    }
  });
});
