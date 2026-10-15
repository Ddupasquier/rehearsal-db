import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectConfigurationMetadata,
  reviewConfigurationProposal,
} from "../../../dist/src/project/configuration_review.mjs";

const roots = [];
const configModule = pathToFileURL(
  join(process.cwd(), "dist/src/project/configuration.mjs"),
).href;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-configuration-review-"));
  roots.push(root);
  const source = `import {defineRehearsalConfig} from ${JSON.stringify(configModule)};
export default defineRehearsalConfig({schemaVersion: 1, project:{name:'fixture'}, postgresql:{migrationDirectory:'database/migrations'}, baseline:{sanitizationPolicy:'rehearsal/privacy.json'}, application:{startCommand:'npm run dev',proofCommand:'npm test'}, runtime:{target:'postgresql',databasePort:58322,projectId:'fixture-rehearsal'}});\n`;
  await writeFile(join(root, "rehearsal.config.mjs"), source);
  return { root, source };
};
const propose = async (root, source, changes, extras = {}, configPath) => {
  await writeFile(
    join(root, "proposal.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceSha256: hash(source),
      changes,
      ...extras,
    }),
  );
  return reviewConfigurationProposal(
    { projectRoot: root, ...(configPath ? { configPath } : {}) },
    "proposal.json",
  );
};
const topologyFixture = async () => {
  const { root } = await fixture();
  const config = (name, port, artifactDirectory, dependents = []) => ({
    schemaVersion: 1,
    project: { name },
    postgresql: {
      migrationDirectory: `${name}/migrations`,
      runtimeWorkdir: `${artifactDirectory}/runtime`,
    },
    baseline: { artifactDirectory, sanitizationPolicy: `${name}/privacy.json` },
    application: {
      startCommand: "npm run dev",
      proofCommand: "npm test",
      environmentFile: `${artifactDirectory}/runtime.env`,
      readiness: { url: "http://localhost:5175/health", expectedStatus: 200 },
    },
    runtime: {
      target: "postgresql",
      projectId: `${name}-rehearsal`,
      databasePort: port,
      applicationUrl: "http://localhost:5175/",
    },
    dependentTargets: dependents,
  });
  const primarySource = `export default ${JSON.stringify(config("primary", 58322, ".rehearsal", [{ name: "publication", configPath: "publication.config.mjs" }]))};\n`;
  const dependentSource = `export default ${JSON.stringify(config("publication", 58422, "publication/.rehearsal"))};\n`;
  await writeFile(join(root, "rehearsal.config.mjs"), primarySource);
  await writeFile(join(root, "publication.config.mjs"), dependentSource);
  return { root, primarySource, dependentSource };
};
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("core configuration review", () => {
  it("reports exact active root/nested paths and bounded policy defaults without reading secrets", async () => {
    const { root, source } = await fixture();
    await writeFile(join(root, ".env"), "PRIVATE_CANARY=do-not-read-or-print");
    const metadata = await inspectConfigurationMetadata({ projectRoot: root });
    expect(metadata.path).toBe("rehearsal.config.mjs");
    expect(metadata.sourceSha256).toBe(hash(source));
    expect(
      metadata.fields.find(
        (field) => field.path === "resources.cleanupSchedule",
      )?.value,
    ).toBe("manual");
    expect(JSON.stringify(metadata)).not.toMatch(
      /do-not-read-or-print|PRIVATE_CANARY/u,
    );
    await mkdir(join(root, "infrastructure/rehearsal"), { recursive: true });
    await writeFile(
      join(root, "infrastructure/rehearsal/rehearsal.config.mjs"),
      source,
    );
    await rm(join(root, "rehearsal.config.mjs"));
    expect(
      (await inspectConfigurationMetadata({ projectRoot: root })).path,
    ).toBe("infrastructure/rehearsal/rehearsal.config.mjs");
  });
  it("validates complete proposed settings without executing commands or writing the configuration", async () => {
    const { root, source } = await fixture();
    const sentinel = join(root, "must-not-exist");
    const result = await propose(root, source, [
      {
        path: "application.proofCommand",
        value: `node -e "require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'bad')"`,
      },
      { path: "runtime.applicationUrl", value: "http://[::1]:5175" },
    ]);
    expect(result.validation).toBe("complete-config-passed");
    expect(result.writesConfiguration).toBe(false);
    expect(result.executesProposedCommands).toBe(false);
    await expect(access(sentinel)).rejects.toThrow();
    expect(await readFile(join(root, "rehearsal.config.mjs"), "utf8")).toBe(
      source,
    );
  });
  it("refuses stale fingerprints, duplicated fields, arbitrary owners and privilege-sensitive changes", async () => {
    const { root, source } = await fixture();
    await expect(
      propose(
        root,
        source,
        [{ path: "runtime.applicationUrl", value: "http://localhost:5175" }],
        { sourceSha256: "a".repeat(64) },
      ),
    ).rejects.toThrow(/changed/u);
    await expect(
      propose(root, source, [
        { path: "runtime.applicationUrl", value: "http://localhost:5175" },
        { path: "runtime.applicationUrl", value: "http://localhost:5176" },
      ]),
    ).rejects.toThrow(/duplicated/u);
    for (const path of [
      "runtime.projectId",
      "identityPolicy",
      "preparation.sourcePolicy",
      "__proto__.polluted",
    ])
      await expect(
        propose(root, source, [{ path, value: "unsafe" }]),
      ).rejects.toThrow(/manual review/u);
    await expect(
      propose(root, source, [
        { path: "runtime.applicationUrl", value: "https://production.example" },
      ]),
    ).rejects.toThrow();
    expect(await readFile(join(root, "rehearsal.config.mjs"), "utf8")).toBe(
      source,
    );
  });
  it("refuses final/ancestor symlink escapes and oversized/malformed proposals without disclosing bytes", async () => {
    const { root, source } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "rehearsal-review-outside-"));
    roots.push(outside);
    await writeFile(
      join(outside, "proposal.json"),
      JSON.stringify({
        schemaVersion: 1,
        sourceSha256: hash(source),
        changes: [
          { path: "runtime.applicationUrl", value: "http://localhost:5175" },
        ],
      }),
    );
    await symlink(
      join(outside, "proposal.json"),
      join(root, "final-link.json"),
    );
    await symlink(outside, join(root, "outside-folder"));
    await expect(
      reviewConfigurationProposal({ projectRoot: root }, "final-link.json"),
    ).rejects.toThrow(/project-local regular file/u);
    await expect(
      reviewConfigurationProposal(
        { projectRoot: root },
        "outside-folder/proposal.json",
      ),
    ).rejects.toThrow(/project-local regular file/u);
    await writeFile(
      join(root, "malformed.json"),
      '{"token":"PRIVATE_JSON_CANARY",BROKEN',
    );
    try {
      await reviewConfigurationProposal(
        { projectRoot: root },
        "malformed.json",
      );
      throw new Error("unexpected pass");
    } catch (error) {
      expect(error.message).toContain("not valid JSON");
      expect(error.message).not.toContain("PRIVATE_JSON_CANARY");
    }
    await writeFile(join(root, "large.json"), "x".repeat(65537));
    await expect(
      reviewConfigurationProposal({ projectRoot: root }, "large.json"),
    ).rejects.toThrow(/bounded/u);
    await expect(
      reviewConfigurationProposal({ projectRoot: root }, "../proposal.json"),
    ).rejects.toThrow(/project-local/u);
  });
  it("rejects a symbolic configuration before importing it", async () => {
    const { root } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "rehearsal-config-outside-"));
    roots.push(outside);
    const sentinel = join(root, "unsafe-import");
    await writeFile(
      join(outside, "config.mjs"),
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},'bad');export default {};`,
    );
    await rm(join(root, "rehearsal.config.mjs"));
    await symlink(
      join(outside, "config.mjs"),
      join(root, "rehearsal.config.mjs"),
    );
    await expect(
      inspectConfigurationMetadata({ projectRoot: root }),
    ).rejects.toThrow(/project-local regular file/u);
    await expect(access(sentinel)).rejects.toThrow();
  });

  it("refuses proposed primary endpoints and profiles that collide with any dependent service without writes", async () => {
    const { root, primarySource, dependentSource } = await topologyFixture();
    for (const changes of [
      [{ path: "runtime.applicationUrl", value: "http://localhost:58422/" }],
      [
        {
          path: "profiles",
          value: [
            {
              name: "All",
              targets: ["primary", "publication"],
              applicationUrl: "http://[::1]:58422/auth/callback",
            },
          ],
        },
      ],
    ]) {
      await expect(propose(root, primarySource, changes)).rejects.toThrow(
        /conflicts with configured publication database port 58422/u,
      );
    }
    expect(await readFile(join(root, "rehearsal.config.mjs"), "utf8")).toBe(
      primarySource,
    );
    expect(await readFile(join(root, "publication.config.mjs"), "utf8")).toBe(
      dependentSource,
    );
  });

  it("substitutes a dependent proposal only into its explicitly selected parent graph", async () => {
    const { root, primarySource, dependentSource } = await topologyFixture();
    await expect(
      propose(
        root,
        dependentSource,
        [
          {
            path: "application.readiness.url",
            value: "http://127.0.0.1:58322/health",
          },
        ],
        { topologyConfigPath: "rehearsal.config.mjs" },
        "publication.config.mjs",
      ),
    ).rejects.toThrow(/conflicts with configured primary database port 58322/u);
    const result = await propose(
      root,
      dependentSource,
      [
        {
          path: "application.readiness.url",
          value: "http://[::1]:5175/auth/callback",
        },
      ],
      { topologyConfigPath: "rehearsal.config.mjs" },
      "publication.config.mjs",
    );
    expect(result.topologyValidation).toBe(
      "complete-configured-topology-passed",
    );
    expect(result.topologyTargets).toEqual(["primary", "publication"]);
    expect(await readFile(join(root, "rehearsal.config.mjs"), "utf8")).toBe(
      primarySource,
    );
    expect(await readFile(join(root, "publication.config.mjs"), "utf8")).toBe(
      dependentSource,
    );
  });

  it("refuses foreign graphs and malformed or symbolic parent paths before accepting a proposal", async () => {
    const { root, primarySource, dependentSource } = await topologyFixture();
    await writeFile(join(root, "foreign.config.mjs"), dependentSource);
    for (const topologyConfigPath of [
      "foreign.config.mjs",
      "../outside.mjs",
      "/private/outside.mjs",
      "C:\\private\\outside.mjs",
      "private\ncanary.mjs",
      "",
    ]) {
      await expect(
        propose(
          root,
          primarySource,
          [{ path: "runtime.applicationUrl", value: "http://localhost:5176/" }],
          { topologyConfigPath },
        ),
      ).rejects.toThrow(/topology|project-local/u);
    }
    await symlink(
      join(root, "rehearsal.config.mjs"),
      join(root, "parent-link.mjs"),
    );
    await expect(
      propose(
        root,
        dependentSource,
        [{ path: "runtime.applicationUrl", value: "http://localhost:5176/" }],
        { topologyConfigPath: "parent-link.mjs" },
        "publication.config.mjs",
      ),
    ).rejects.toThrow(/regular file/u);
    expect(await readFile(join(root, "rehearsal.config.mjs"), "utf8")).toBe(
      primarySource,
    );
  });
});
