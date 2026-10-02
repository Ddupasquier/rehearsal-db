import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "@lydell/node-pty";
import { createSyntheticBaselineFromFiles } from "../../scripts/lib/rehearsal/baseline_builder.mjs";

const roots = [];
const cliPath = join(
  process.cwd(),
  "scripts/operations/rehearsal/rehearsal_cli.mjs",
);

const makeTreeWritable = async (path) => {
  await chmod(path, 0o700).catch(() => undefined);
  for (const entry of await readdir(path, { withFileTypes: true }).catch(
    () => [],
  )) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(child);
    else if (!entry.isSymbolicLink()) await chmod(child, 0o600);
  }
};

const runInPty = ({ cwd, interactions, plain }) =>
  new Promise((resolve, reject) => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !["CI", "CODEX_CI", "NO_COLOR"].includes(key),
      ),
    );
    const terminal = spawn(
      process.execPath,
      [cliPath, ...(plain ? ["--plain"] : [])],
      {
        name: "xterm-256color",
        cols: 100,
        rows: 40,
        cwd,
        env: { ...environment, COLORTERM: "truecolor", TERM: "xterm-256color" },
      },
    );
    let output = "";
    let interactionIndex = 0;
    let searchOffset = 0;
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error(`Guided terminal interaction timed out: ${output}`));
    }, 10_000);
    terminal.onData((chunk) => {
      output += chunk;
      const interaction = interactions[interactionIndex];
      if (
        interaction &&
        output.indexOf(interaction.after, searchOffset) !== -1
      ) {
        searchOffset = output.length;
        interactionIndex += 1;
        terminal.write(interaction.write);
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0) resolve(output);
      else reject(new Error(`Guided terminal exited ${exitCode}: ${output}`));
    });
  });

const makeProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-guided-terminal-"));
  roots.push(root);
  await mkdir(join(root, "supabase/migrations"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "guided-terminal-fixture", scripts: { test: "node --test" } })}\n`,
  );
  await writeFile(
    join(root, "supabase/config.toml"),
    'project_id = "fixture"\n',
  );
  return root;
};

const makePolicyProject = async () => {
  const root = await makeProject();
  await mkdir(join(root, "rehearsal"), { recursive: true });
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `export default {
  schemaVersion: 1,
  project: { name: "guided-policy-fixture" },
  supabase: {
    workdir: ".",
    migrationDirectory: "supabase/migrations",
    rehearsalConfig: "supabase/config.toml",
    runtimeWorkdir: ".rehearsal/runtime",
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "rehearsal/sanitization-policy.json",
  },
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm run test",
  },
  runtime: {
    applicationUrl: "http://localhost:5175",
    projectId: "guided-policy-fixture",
    apiPort: 58341,
    databasePort: 58342,
    studioPort: 58343,
  },
  safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
};
`,
  );
  await writeFile(
    join(root, "rehearsal/sanitization-policy.json"),
    `${JSON.stringify(
      {
        policyVersion: 1,
        draft: true,
        migrationCutoff: "20260101000000",
        tables: [
          {
            name: "widgets",
            group: "synthetic",
            sourceRows: "STREAM AND SANITIZE",
            columns: ["created_at", "id", "name"].map((name) => ({
              name,
              action: "REVIEW REQUIRED",
              generated: "REVIEW REQUIRED",
              identity: "REVIEW REQUIRED",
              foreignKey: "REVIEW REQUIRED",
            })),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return root;
};

const makeBaselineInputProject = async () => {
  const root = await makeProject();
  await mkdir(join(root, "rehearsal"), { recursive: true });
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `export default {
  schemaVersion: 1,
  project: { name: "guided-input-fixture" },
  supabase: {
    workdir: ".",
    migrationDirectory: "supabase/migrations",
    rehearsalConfig: "supabase/config.toml",
    runtimeWorkdir: ".rehearsal/runtime",
  },
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "rehearsal/sanitization-policy.json",
  },
  application: { startCommand: "npm run dev", proofCommand: "npm run test" },
  runtime: {
    applicationUrl: "http://localhost:5175",
    projectId: "guided-input-fixture",
    apiPort: 58341,
    databasePort: 58342,
    studioPort: 58343,
  },
  safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
};
`,
  );
  await writeFile(
    join(root, "rehearsal/synthetic-data.ndjson"),
    `${JSON.stringify({ table: "widgets", row: { id: 1, name: "never-print-this-value" } })}\n`,
  );
  await writeFile(
    join(root, "rehearsal/migration-ledger.json"),
    `${JSON.stringify([
      {
        version: "20260101000000",
        name: "create_widgets",
        statements: ["create table public.widgets(id bigint)"],
      },
    ])}\n`,
  );
  return root;
};

const makeCompleteProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-guided-complete-"));
  roots.push(root);
  await cp(join(process.cwd(), "tests/fixtures/rehearsal-project"), root, {
    recursive: true,
  });
  await createSyntheticBaselineFromFiles({
    projectRoot: root,
    recordsPath: "rehearsal/sanitized-data.ndjson",
    ledgerPath: "rehearsal/migration-ledger.json",
  });
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeTreeWritable(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("guided terminal journey", () => {
  it("discovers and preflights baseline inputs before writing a policy draft", async () => {
    const root = await makeBaselineInputProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        interactions: [
          { after: "What would you like to do? [1]:", write: "1\n" },
          {
            after: "Sanitized NDJSON records [1]:",
            write: "\n",
          },
          {
            after: "Migration ledger [1]:",
            write: "\n",
          },
          {
            after:
              "Create the REVIEW REQUIRED draft at rehearsal/sanitization-policy.json? (y/N)",
            write: "y\n",
          },
          { after: "What would you like to do? [1]:", write: "5\n" },
        ],
      }),
    ).replaceAll("\r", "");

    expect(output).toContain("Detected safe local inputs");
    expect(output).toContain("Records: rehearsal/synthetic-data.ndjson");
    expect(output).toContain("BASELINE POLICY — PREVIEW");
    expect(output).toContain("widgets: 1 row; id, name");
    expect(output).not.toContain("never-print-this-value");
    await expect(
      readFile(join(root, "rehearsal/sanitization-policy.json"), "utf8"),
    ).resolves.toContain('"draft": true');
  }, 15_000);

  it("explains invalid baseline inputs and safely returns to the guide", async () => {
    const root = await makeBaselineInputProject();
    await writeFile(
      join(root, "rehearsal/synthetic-data.ndjson"),
      "invalid ndjson\n",
    );
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        interactions: [
          { after: "What would you like to do? [1]:", write: "1\n" },
          {
            after: "Sanitized NDJSON records (required):",
            write: "rehearsal/synthetic-data.ndjson\n",
          },
          {
            after: "Migration ledger [1]:",
            write: "\n",
          },
          { after: "What would you like to do? [1]:", write: "5\n" },
        ],
      }),
    ).replaceAll("\r", "");

    expect(output).toContain("BASELINE INPUTS NEED ATTENTION");
    expect(output).toContain(
      "Synthetic baseline input contains invalid NDJSON",
    );
    expect(output.match(/Safe local migration testing/gu)).toHaveLength(2);
    await expect(
      readFile(join(root, "rehearsal/sanitization-policy.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("accepts each single detected baseline input with Enter in the styled guide", async () => {
    const root = await makeBaselineInputProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: false,
        interactions: [
          { after: "What would you like to do?", write: "\r" },
          { after: "Sanitized NDJSON records", write: "\r" },
          { after: "Migration ledger", write: "\r" },
          {
            after: "Create the REVIEW REQUIRED draft",
            write: "\u0003",
          },
          { after: "What would you like to do?", write: "\u0003" },
        ],
      }),
    )
      .replaceAll("\r", "")
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");

    expect(output).toContain("rehearsal/synthetic-data.ndjson");
    expect(output).toContain("rehearsal/migration-ledger.json");
    expect(output).toContain("BASELINE POLICY — PREVIEW");
    expect(output).not.toContain("Enter a value.");
  }, 15_000);

  it("applies table defaults and reviews only suggested exceptions", async () => {
    const root = await makePolicyProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        interactions: [
          { after: "What would you like to do? [1]:", write: "1\n" },
          {
            after: "widgets: how would you like to review 3 columns? [1]:",
            write: "\n",
          },
          {
            after: "Choose comma-separated numbers, all, or none [1,2]:",
            write: "\n",
          },
          {
            after: "widgets.created_at: how should this value be handled? [1]:",
            write: "3\n",
          },
          {
            after:
              "widgets.created_at: is this column always database-generated? [1]:",
            write: "\n",
          },
          {
            after: "widgets.created_at: is this an identity column? [1]:",
            write: "\n",
          },
          {
            after:
              "widgets.created_at: does this column reference another table? (y/N)",
            write: "\n",
          },
          {
            after: "widgets.id: how should this value be handled? [1]:",
            write: "5\n",
          },
          {
            after: "widgets.id: is this column always database-generated? [1]:",
            write: "\n",
          },
          {
            after: "widgets.id: is this an identity column? [1]:",
            write: "2\n",
          },
          {
            after:
              "widgets.id: does this column reference another table? (y/N)",
            write: "\n",
          },
          {
            after: "Save 3 classified columns and activate this policy? (y/N)",
            write: "y\n",
          },
          { after: "What would you like to do? [1]:", write: "5\n" },
        ],
      }),
    ).replaceAll("\r", "");
    const policy = JSON.parse(
      await readFile(join(root, "rehearsal/sanitization-policy.json"), "utf8"),
    );

    expect(output).toContain("widgets: 1 safe default; 2 individual reviews");
    expect(output).toContain(
      "3 columns classified (1 safe default; 2 individual reviews)",
    );
    expect(policy).not.toHaveProperty("draft");
    expect(policy.tables[0].columns).toEqual([
      {
        name: "created_at",
        action: "DERIVE",
        generated: "NEVER",
        identity: "NO",
        foreignKey: null,
      },
      {
        name: "id",
        action: "KEEP EXACTLY",
        generated: "NEVER",
        identity: "YES",
        foreignKey: null,
      },
      {
        name: "name",
        action: "REPLACE WITH SYNTHETIC",
        generated: "NEVER",
        identity: "NO",
        foreignKey: null,
      },
    ]);
  }, 15_000);

  it("returns to the home screen after an action in a real PTY", async () => {
    const root = await makeProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        interactions: [
          { after: "What would you like to do? [1]:", write: "3\n" },
          { after: "What would you like to do? [1]:", write: "4\n" },
        ],
      }),
    ).replaceAll("\r", "");

    expect(output.match(/Safe local migration testing/gu)).toHaveLength(2);
    expect(output).toContain("Usage: rehearsal <command> [options]");
    expect(output).not.toContain("No changes made.");
    expect(output).toContain("See you at the next rehearsal.");
    expect({
      projectVisible: output.includes("guided-terminal-fixture"),
      setupVisible: output.includes("Set the stage"),
      returnedHome: output.match(/What would you like to do\?/gu)?.length,
    }).toMatchInlineSnapshot(`
      {
        "projectVisible": true,
        "returnedHome": 4,
        "setupVisible": true,
      }
    `);
  }, 15_000);

  it("offers a privacy-safe support report from the guide", async () => {
    const root = await makeProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        interactions: [
          { after: "What would you like to do? [1]:", write: "2\n" },
          { after: "What would you like to do? [1]:", write: "4\n" },
        ],
      }),
    ).replaceAll("\r", "");

    expect(output).toContain("REHEARSAL SUPPORT REPORT");
    expect(output).toContain(
      "Privacy: no row values, credentials, project paths, migration SQL, or baseline identifiers are included.",
    );
    expect(output).toContain("Report a reproducible issue:");
    expect(output).not.toContain(root);
  }, 15_000);

  it("renders the styled guide in a real PTY and handles cancellation", async () => {
    const root = await makeProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: false,
        interactions: [
          { after: "What would you like to do?", write: "\u0003" },
        ],
      }),
    )
      .replaceAll("\r", "")
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");

    expect(output).toContain("REHEARSAL · Safe local migration testing");
    expect(output).toContain("guided-terminal-fixture");
    expect(output).toContain("Set the stage");
    expect(output).toContain("See you at the next rehearsal.");
  }, 15_000);

  it("exits the whole guided session on Ctrl+Z in styled and plain terminals", async () => {
    for (const plain of [false, true]) {
      const root = await makeProject();
      const output = String(
        await runInPty({
          cwd: root,
          plain,
          interactions: [
            { after: "What would you like to do?", write: "\u001A" },
          ],
        }),
      )
        .replaceAll("\r", "")
        .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");

      expect(output).toContain("Rehearsal exited.");
      expect(output).not.toContain("See you at the next rehearsal.");
    }
  }, 15_000);

  it("runs help actions from the styled menu and returns home", async () => {
    const root = await makeProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: false,
        interactions: [
          {
            after: "What would you like to do?",
            write: "\u001B[B\r",
          },
          {
            after: "Report a reproducible issue:",
            write: "",
          },
          {
            after: "↑/↓",
            write: "\u001B[B\u001B[B\r",
          },
          {
            after: "Usage: rehearsal <command> [options]",
            write: "",
          },
          {
            after: "↑/↓",
            write: "\u001B[B\u001B[B\u001B[B\r",
          },
        ],
      }),
    )
      .replaceAll("\r", "")
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");

    expect(output).toContain("REHEARSAL SUPPORT REPORT");
    expect(output).toContain("Usage: rehearsal <command> [options]");
    expect(output).toContain("See you at the next rehearsal.");
  }, 15_000);

  it("keeps every action visible in the completed styled menu", async () => {
    const root = await makeCompleteProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: false,
        interactions: [
          { after: "What would you like to do?", write: "\u0003" },
        ],
      }),
    )
      .replaceAll("\r", "")
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");

    expect(output).toContain("Get help");
    expect(output).toContain("Show all commands");
    expect(output).toContain("Exit");
  }, 15_000);
});
