import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const exists = (path) =>
  access(path)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });

const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
};

describe("repository structure", () => {
  it("keeps production code in named domains and removes the legacy layout", async () => {
    const expectedDomains = [
      "application",
      "baseline",
      "cli",
      "identity",
      "project",
      "runtime",
      "shared",
      "source",
      "targets",
    ];
    const actualDomains = (
      await readdir(join(root, "src"), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(actualDomains).toEqual(expectedDomains);
    await expect(exists(join(root, "scripts/lib"))).resolves.toBe(false);
    await expect(exists(join(root, "scripts/operations"))).resolves.toBe(false);
  });

  it("keeps shipped source independent from tests and repository-only scripts", async () => {
    const sources = (await walk(join(root, "src"))).filter((path) =>
      path.endsWith(".mts"),
    );
    for (const path of sources) {
      const content = await readFile(path, "utf8");
      expect(content).not.toMatch(/(?:^|\/)tests\//u);
      expect(content).not.toMatch(/scripts\/verification/u);
    }
  });

  it("keeps public exports inside shipped source", async () => {
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    const targets = Object.values(manifest.exports).flatMap((declaration) =>
      typeof declaration === "string"
        ? [declaration]
        : Object.values(declaration),
    );
    for (const target of targets) {
      expect(target).toMatch(/^\.\/(?:dist|types)\//u);
      await expect(exists(join(root, target))).resolves.toBe(true);
    }
  });

  it("keeps CLI modules focused enough to review independently", async () => {
    const modules = (await readdir(join(root, "src/cli")))
      .filter((file) => file.endsWith(".mts"))
      .sort();

    for (const module of modules) {
      const source = await readFile(join(root, "src/cli", module), "utf8");
      expect(source.split("\n").length, module).toBeLessThanOrEqual(1_000);
    }
  });

  it("keeps the CLI entry point and typed handler families from becoming catch-alls", async () => {
    const entry = await readFile(join(root, "src/cli/rehearsal.mts"), "utf8");
    expect(entry.split("\n").length).toBeLessThanOrEqual(300);

    const handlerModules = (await readdir(join(root, "src/cli"))).filter(
      (file) =>
        file.endsWith("_command_handlers.mts") ||
        file.endsWith("_action_handlers.mts"),
    );
    expect(handlerModules.length).toBeGreaterThanOrEqual(7);
    for (const module of handlerModules) {
      const source = await readFile(join(root, "src/cli", module), "utf8");
      expect(source.split("\n").length, module).toBeLessThanOrEqual(350);
    }
  });

  it("keeps configuration phases separated behind a small public facade", async () => {
    const projectDirectory = join(root, "src/project");
    const facade = await readFile(
      join(projectDirectory, "configuration.mts"),
      "utf8",
    );
    expect(facade.split("\n").length).toBeLessThanOrEqual(50);

    const phases = [
      "configuration_contract.mts",
      "configuration_discovery.mts",
      "configuration_schema.mts",
      "configuration_normalization.mts",
      "configuration_resolution.mts",
      "configuration_rendering.mts",
      "configuration_validation.mts",
      "project_detection.mts",
    ];
    for (const phase of phases) {
      const source = await readFile(join(projectDirectory, phase), "utf8");
      expect(source.split("\n").length, phase).toBeLessThanOrEqual(700);
    }
  });

  it("keeps identity claims in explicit auditable stages", async () => {
    const identityDirectory = join(root, "src/identity");
    const facade = await readFile(join(identityDirectory, "claim.mts"), "utf8");
    expect(facade.split("\n").length).toBeLessThanOrEqual(50);

    const stages = [
      "claim_contract.mts",
      "claim_policy.mts",
      "claim_plan.mts",
      "claim_sql.mts",
      "claim_identity_lookup.mts",
      "claim_verification.mts",
      "claim_executor.mts",
    ];
    for (const stage of stages) {
      const source = await readFile(join(identityDirectory, stage), "utf8");
      expect(source.split("\n").length, stage).toBeLessThanOrEqual(600);
    }
  });

  it("keeps database drivers behind the shared lifecycle engine", async () => {
    const lifecycle = await readFile(
      join(root, "src/runtime/lifecycle_engine.mts"),
      "utf8",
    );
    expect(lifecycle.split("\n").length).toBeLessThanOrEqual(300);

    for (const target of ["postgresql.mts", "supabase.mts"]) {
      const source = await readFile(join(root, "src/targets", target), "utf8");
      expect(source).toContain('from "../runtime/lifecycle_engine.mjs"');
      expect(source.split("\n").length, target).toBeLessThanOrEqual(900);
    }
  });
});
