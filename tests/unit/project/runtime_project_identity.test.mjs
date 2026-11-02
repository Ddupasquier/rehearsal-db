import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRuntimeProjectId,
  createRuntimeProjectId,
} from "../../../dist/src/project/runtime_project_identity.mjs";
import { normalizeRehearsalConfig } from "../../../dist/src/project/configuration_normalization.mjs";
import { assertIdentifier } from "../../../dist/src/project/configuration_validation.mjs";
import { loadRuntimeTopology } from "../../../dist/src/runtime/lifecycle/topology.mjs";
import { serializeRehearsalError } from "../../../dist/src/shared/diagnostics.mjs";

const roots = [];
const execute = promisify(execFile);
const configuration = (projectId, target = "supabase") => ({
  schemaVersion: 1,
  project: { name: "identity-fixture" },
  ...(target === "supabase"
    ? {
        supabase: {
          workdir: ".",
          migrationDirectory: "supabase/migrations",
          rehearsalConfig: "infrastructure/rehearsal/supabase/config.toml",
          runtimeWorkdir: ".rehearsal/runtime",
        },
      }
    : { postgresql: { migrationDirectory: "database/migrations" } }),
  baseline: { sanitizationPolicy: "policy.json" },
  application: {
    startCommand: "node --version",
    proofCommand: "node --version",
  },
  runtime: {
    target,
    projectId,
    databasePort: 58322,
    ...(target === "supabase" ? { apiPort: 58321, studioPort: 58323 } : {}),
  },
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider-bound runtime project identity", () => {
  it.each([2, 40])(
    "preserves exact valid Supabase IDs of length %i",
    (length) => {
      const id = "a".repeat(length);
      expect(assertRuntimeProjectId(id, "supabase")).toBe(id);
      expect(
        normalizeRehearsalConfig(configuration(id)).runtime.projectId,
      ).toBe(id);
    },
  );

  it.each([1, 41, 47, 64])(
    "refuses unsafe Supabase length %i without truncating or echoing the ID",
    (length) => {
      const id = "a".repeat(length);
      let failure;
      try {
        normalizeRehearsalConfig(configuration(id));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(failure.exitCode).toBe(2);
      expect(serializeRehearsalError(failure).error).toMatchObject({
        category: "configuration_invalid",
        code: "CONFIGURATION_INVALID",
        expected: "2–40 lowercase letters, digits, or hyphens",
        actual: { length },
        context: {
          field: "runtime.projectId",
          target: "supabase",
          maximumLength: 40,
        },
        refused: expect.stringContaining("never truncates"),
      });
      if (length > 40) expect(failure.message).not.toContain(id);
    },
  );

  it("preserves PostgreSQL and unrelated identifier limits", () => {
    expect(assertRuntimeProjectId("a".repeat(63), "postgresql")).toHaveLength(
      63,
    );
    expect(
      normalizeRehearsalConfig(configuration("a".repeat(63), "postgresql"))
        .runtime.projectId,
    ).toHaveLength(63);
    expect(() => assertRuntimeProjectId("a".repeat(64), "postgresql")).toThrow(
      "2–63",
    );
    expect(
      assertIdentifier("a".repeat(63), "config.project.name"),
    ).toHaveLength(63);
    expect(() => assertRuntimeProjectId("Uppercase", "supabase")).toThrow(
      "lowercase letters",
    );
  });

  it("applies Supabase's limit when the runtime target is omitted", () => {
    const input = configuration("a".repeat(40));
    delete input.runtime.target;
    expect(normalizeRehearsalConfig(input).runtime.projectId).toHaveLength(40);
    input.runtime.projectId += "a";
    expect(() => normalizeRehearsalConfig(input)).toThrow("2–40");
  });

  it.each(["supabase", "postgresql"])(
    "keeps the omitted project-ID default for %s",
    (target) => {
      const input = configuration(undefined, target);
      delete input.runtime.target;
      if (target === "postgresql") input.runtime.target = target;
      expect(normalizeRehearsalConfig(input).runtime.projectId).toBe(
        "rehearsal-local",
      );
    },
  );

  it("keeps valid generated IDs and hashes only overlong new identities", () => {
    expect(createRuntimeProjectId("fixture", "supabase")).toBe(
      "fixture-rehearsal",
    );
    expect(createRuntimeProjectId("a".repeat(30), "supabase")).toBe(
      `${"a".repeat(30)}-rehearsal`,
    );
    expect(createRuntimeProjectId("a".repeat(52), "postgresql")).toBe(
      `${"a".repeat(52)}-rehearsal`,
    );
    const name = `${"a".repeat(51)}b`;
    const id = createRuntimeProjectId(name, "supabase");
    expect(id).toHaveLength(40);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*-[a-f0-9]{12}-rehearsal$/u);
    expect(createRuntimeProjectId(name, "supabase")).toBe(id);
    expect(createRuntimeProjectId(`${"a".repeat(51)}c`, "supabase")).not.toBe(
      id,
    );
    expect(
      createRuntimeProjectId(
        "a".repeat(52),
        "supabase",
        `${"a".repeat(52)}-one`,
      ),
    ).not.toBe(
      createRuntimeProjectId(
        "a".repeat(52),
        "supabase",
        `${"a".repeat(52)}-two`,
      ),
    );
  });

  it.each(["primary", "dependent"])(
    "refuses an overlong %s before invoking any provider",
    async (location) => {
      const root = await mkdtemp(join(tmpdir(), "rehearsal-project-identity-"));
      roots.push(root);
      const commands = join(root, "commands");
      await mkdir(commands);
      const log = join(root, "provider-called.log");
      for (const command of ["docker", "colima", "supabase"]) {
        const path = join(commands, command);
        await writeFile(
          path,
          `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(log)}\nexit 97\n`,
        );
        await chmod(path, 0o755);
      }
      const primary = configuration(
        location === "primary" ? "a".repeat(47) : "primary-rehearsal",
      );
      if (location === "dependent") {
        primary.dependentTargets = [
          { name: "publication", configPath: "publication.config.mjs" },
        ];
        await writeFile(
          join(root, "publication.config.mjs"),
          `export default ${JSON.stringify(configuration("a".repeat(47)))};\n`,
        );
      }
      await writeFile(
        join(root, "rehearsal.config.mjs"),
        `export default ${JSON.stringify(primary)};\n`,
      );
      if (location === "dependent")
        await expect(
          loadRuntimeTopology({ projectRoot: root }),
        ).rejects.toMatchObject({ category: "configuration_invalid" });
      let failure;
      try {
        await execute(
          process.execPath,
          [
            join(process.cwd(), "dist/src/cli/rehearsal.mjs"),
            "start",
            "--json",
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${commands}${delimiter}${process.env.PATH ?? ""}`,
            },
            timeout: 10000,
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 2 });
      expect(JSON.parse(failure.stdout).error).toMatchObject({
        category: "configuration_invalid",
        context: {
          field: "runtime.projectId",
          target: "supabase",
          maximumLength: 40,
        },
      });
      await expect(readFile(log, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
