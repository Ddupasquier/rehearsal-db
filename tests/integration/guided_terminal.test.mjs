import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "@lydell/node-pty";
import { createSyntheticBaselineFromFiles } from "../../dist/src/baseline/builder.mjs";
import { verifyActiveBaseline } from "../../dist/src/baseline/artifact.mjs";

const roots = [];
const retainedRoots = new Set();
const cliPath = join(process.cwd(), "dist/src/cli/rehearsal.mjs");

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

const runInPty = ({
  cwd,
  interactions,
  plain,
  updateState,
  toolPath,
  interactionTimeoutMs = 10_000,
  maximumOutputBytes = 1024 * 1024,
  spawnImplementation = spawn,
}) =>
  new Promise((resolve, reject) => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !["CI", "CODEX_CI", "NO_COLOR", "REHEARSAL_UPDATE_CHECK"].includes(
            key,
          ),
      ),
    );
    const terminal = spawnImplementation(
      process.execPath,
      [cliPath, ...(plain ? ["--plain"] : [])],
      {
        name: "xterm-256color",
        cols: 100,
        rows: 40,
        cwd,
        // This older journey owns setup/navigation, not release checks. Dedicated
        // update-advisory tests exercise default consent and enabled reminders.
        env: {
          ...environment,
          ...(toolPath
            ? { PATH: `${toolPath}${delimiter}${environment.PATH ?? ""}` }
            : {}),
          ...(updateState
            ? { REHEARSAL_UPDATE_STATE_DIR: updateState }
            : { REHEARSAL_UPDATE_CHECK: "off" }),
          COLORTERM: "truecolor",
          TERM: "xterm-256color",
        },
      },
    );
    let output = "";
    let outputBytes = 0;
    let interactionIndex = 0;
    let searchOffset = 0;
    let settled = false;
    let exitObserved = false;
    let failure;
    let forceTimer, exitTimer;
    let dataSubscription, exitSubscription;
    const diagnostic = (reason) =>
      Object.assign(
        new Error(
          `Guided terminal ${reason}; interaction ${interactionIndex}/${interactions.length}, output ${outputBytes} bytes: ${output}`,
        ),
        {
          reason,
          interactionIndex,
          interactionCount: interactions.length,
          outputBytes,
          terminalExitObserved: exitObserved,
        },
      );
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(exitTimer);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      if (error) reject(error);
      else resolve(output);
    };
    const retainUncertain = () => {
      retainedRoots.add(cwd);
      finish(
        Object.assign(
          new AggregateError(
            [failure, diagnostic("exit unconfirmed")],
            "Guided terminal failed and exit was not confirmed; owned fixture retained.",
          ),
          {
            fixtureRetained: true,
            terminalExitObserved: false,
            fixturePath: cwd,
          },
        ),
      );
    };
    const beginFailure = (reason) => {
      if (settled || failure) return;
      failure = diagnostic(reason);
      try {
        terminal.kill();
      } catch {
        /* Wait for exit; never assume a signal reaped it. */
      }
      if (settled) return;
      forceTimer = setTimeout(() => {
        if (exitObserved) return;
        try {
          terminal.kill("SIGKILL");
        } catch {
          /* Uncertainty retains the fixture. */
        }
        if (!settled) exitTimer = setTimeout(retainUncertain, 500);
      }, 500);
    };
    const timeout = setTimeout(
      () => beginFailure("interaction timed out"),
      interactionTimeoutMs,
    );
    dataSubscription = terminal.onData((chunk) => {
      if (settled || failure) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maximumOutputBytes) {
        beginFailure("output limit exceeded");
        return;
      }
      output += chunk;
      while (interactionIndex < interactions.length) {
        const interaction = interactions[interactionIndex];
        const match = output.indexOf(interaction.after, searchOffset);
        if (match === -1) break;
        searchOffset = match + interaction.after.length;
        interactionIndex += 1;
        try {
          terminal.write(interaction.write);
        } catch {
          beginFailure("input write failed");
          break;
        }
        if (interaction.write !== "") break;
      }
    });
    exitSubscription = terminal.onExit(({ exitCode }) => {
      exitObserved = true;
      if (failure) {
        failure.terminalExitObserved = true;
        finish(failure);
      } else if (exitCode === 0 && interactionIndex === interactions.length)
        finish();
      else finish(diagnostic(`exited ${exitCode} before the complete journey`));
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

const makeSupportTools = async (root) => {
  // Both real PTY journeys own navigation/report presentation, not ambient
  // tooling startup. Production probes and installed-tool fixtures stay real.
  const toolPath = join(root, "support-tools");
  const audit = join(root, "support-tool-calls.jsonl");
  await mkdir(toolPath, { mode: 0o700 });
  const toolSource = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const calls = {
  npm: { "--version": "11.21.0" },
  supabase: { "--version": "2.117.0" },
  docker: {
    "--version": "Docker version 28.5.1",
    'context ls --format {"Name":{{json .Name}},"Endpoint":{{json .DockerEndpoint}}}': JSON.stringify({ Name: "support-local", Endpoint: "unix:///synthetic/support.sock" }),
    "context show": "support-local",
    "context inspect --format {{json .Endpoints.docker.Host}} support-local": JSON.stringify("unix:///synthetic/support.sock"),
    "context inspect --format {{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}} support-local": "false",
    '--host unix:///synthetic/support.sock info --format {"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}}}': JSON.stringify({ ID: "support-synthetic-daemon", ServerVersion: "28.5.1" }),
  },
};
const value = calls[command]?.[args.join(" ")];
appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ command, args, accepted: typeof value === "string" }) + "\\n", { mode: 0o600 });
if (typeof value !== "string") process.exit(97);
console.log(value);
`;
  for (const command of ["npm", "supabase", "docker"]) {
    await writeFile(join(toolPath, command), toolSource, { mode: 0o700 });
  }
  return {
    toolPath,
    verify: async () => {
      expect(
        (await readFile(audit, "utf8")).trim().split("\n").map(JSON.parse),
      ).toEqual([
        {
          command: "docker",
          args: [
            "context",
            "ls",
            "--format",
            '{"Name":{{json .Name}},"Endpoint":{{json .DockerEndpoint}}}',
          ],
          accepted: true,
        },
        { command: "docker", args: ["context", "show"], accepted: true },
        {
          command: "docker",
          args: [
            "context",
            "inspect",
            "--format",
            "{{json .Endpoints.docker.Host}}",
            "support-local",
          ],
          accepted: true,
        },
        {
          command: "docker",
          args: [
            "context",
            "inspect",
            "--format",
            "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
            "support-local",
          ],
          accepted: true,
        },
        {
          command: "docker",
          args: [
            "--host",
            "unix:///synthetic/support.sock",
            "info",
            "--format",
            '{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}}}',
          ],
          accepted: true,
        },
        { command: "npm", args: ["--version"], accepted: true },
        { command: "supabase", args: ["--version"], accepted: true },
        { command: "docker", args: ["--version"], accepted: true },
      ]);
    },
  };
};

const makePostgresqlProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-guided-postgresql-"));
  roots.push(root);
  await mkdir(join(root, "database/migrations"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "guided-postgresql-fixture", scripts: { test: "node --test" } })}\n`,
  );
  await writeFile(
    join(root, "database/migrations/20260101000000_create_widgets.sql"),
    "create table public.widgets(id bigint primary key);\n",
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

const makeUnavailableCleanupTools = async (root) => {
  const toolPath = join(root, "cleanup-tools");
  const audit = join(root, "cleanup-tool-calls.log");
  await mkdir(toolPath, { mode: 0o700 });
  for (const command of ["docker", "colima", "supabase"])
    await writeFile(
      join(toolPath, command),
      `#!/bin/sh
umask 077
printf '%s\\n' '${command}' >> '${audit.replaceAll("'", "'\\''")}'
exit 127
`,
      { mode: 0o700 },
    );
  return { toolPath, audit };
};

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .filter((root) => !retainedRoots.has(root))
      .map(async (root) => {
        await makeTreeWritable(root);
        await rm(root, { recursive: true, force: true });
      }),
  );
});

const fakePty = ({ writeFailure = false } = {}) => {
  let data, exit, didKill;
  const killed = new Promise((resolve) => {
    didKill = resolve;
  });
  const signals = [],
    writes = [];
  let disposed = 0;
  return {
    signals,
    writes,
    killed,
    get disposed() {
      return disposed;
    },
    emitData: (chunk) => data(chunk),
    emitExit: (exitCode = 0) => exit({ exitCode }),
    spawn: () => ({
      kill(signal = "SIGTERM") {
        signals.push(signal);
        didKill();
      },
      write(value) {
        if (writeFailure) throw new Error("synthetic private write failure");
        writes.push(value);
      },
      onData(listener) {
        data = listener;
        return {
          dispose() {
            disposed++;
          },
        };
      },
      onExit(listener) {
        exit = listener;
        return {
          dispose() {
            disposed++;
          },
        };
      },
    }),
  };
};

describe("guided PTY fixture lifecycle", () => {
  it("waits for observed exit before rejecting a timed-out fixture", async () => {
    const root = await makeProject();
    const terminal = fakePty();
    let settled = false;
    const result = runInPty({
      cwd: root,
      plain: true,
      interactions: [],
      interactionTimeoutMs: 1,
      spawnImplementation: terminal.spawn,
    }).catch((error) => {
      settled = true;
      return error;
    });
    await terminal.killed;
    expect(settled).toBe(false);
    terminal.emitExit();
    const error = await result;
    expect(error.reason).toBe("interaction timed out");
    expect(error.terminalExitObserved).toBe(true);
    expect(terminal.disposed).toBe(2);
    expect(terminal.signals).toEqual(["SIGTERM"]);
    expect(retainedRoots.has(root)).toBe(false);
  });

  it("retains uncertain fixtures and the first failure after bounded forced cleanup", async () => {
    const root = await makeProject();
    const terminal = fakePty();
    const error = await runInPty({
      cwd: root,
      plain: true,
      interactions: [],
      interactionTimeoutMs: 1,
      spawnImplementation: terminal.spawn,
    }).catch((failure) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0].reason).toBe("interaction timed out");
    expect(error.fixtureRetained).toBe(true);
    expect(error.fixturePath).toBe(root);
    expect(error.terminalExitObserved).toBe(false);
    expect(terminal.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(retainedRoots.has(root)).toBe(true);
    expect(terminal.disposed).toBe(2);
    // This fault used a fake terminal and never created a process; release its
    // deliberate retention only after asserting the preservation boundary.
    retainedRoots.delete(root);
  });

  it("bounds transcript memory and still waits for its owned exit", async () => {
    const root = await makeProject();
    const terminal = fakePty();
    const result = runInPty({
      cwd: root,
      plain: true,
      interactions: [],
      maximumOutputBytes: 32,
      spawnImplementation: terminal.spawn,
    }).catch((error) => error);
    terminal.emitData("x".repeat(33));
    await terminal.killed;
    terminal.emitExit();
    const error = await result;
    expect(error.reason).toBe("output limit exceeded");
    expect(error.outputBytes).toBe(33);
    expect(error.terminalExitObserved).toBe(true);
    expect(error.message).not.toContain("x".repeat(33));
  });

  it("joins owned cleanup when a PTY write fails instead of throwing from its data callback", async () => {
    const root = await makeProject();
    const terminal = fakePty({ writeFailure: true });
    const result = runInPty({
      cwd: root,
      plain: true,
      interactions: [{ after: "CHOICE", write: "1\n" }],
      spawnImplementation: terminal.spawn,
    }).catch((error) => error);
    expect(() => terminal.emitData("CHOICE")).not.toThrow();
    await terminal.killed;
    terminal.emitExit();
    const error = await result;
    expect(error.reason).toBe("input write failed");
    expect(error.terminalExitObserved).toBe(true);
    expect(error.message).not.toContain("synthetic private write failure");
    expect(terminal.disposed).toBe(2);
  });

  it("consumes no-input milestones coalesced with the next prompt", async () => {
    const root = await makeProject();
    const terminal = fakePty();
    const result = runInPty({
      cwd: root,
      plain: true,
      interactions: [
        { after: "A", write: "" },
        { after: "B", write: "" },
        { after: "C", write: "done\n" },
      ],
      spawnImplementation: terminal.spawn,
    });
    terminal.emitData("A--B--C");
    expect(terminal.writes).toEqual(["", "", "done\n"]);
    terminal.emitExit();
    await expect(result).resolves.toBe("A--B--C");
  });
});

describe("guided terminal journey", () => {
  it("exits the real plain first-consent prompt cleanly with one Ctrl+C", async () => {
    const root = await makeProject();
    const updateState = join(await realpath(root), "update-state");
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        updateState,
        interactions: [
          { after: "Check npm for Rehearsal updates? [1]:", write: "\u0003" },
        ],
      }),
    );
    expect(output).toContain("Check npm for Rehearsal updates?");
    expect(output).not.toContain("internal_failure");
    expect(output).not.toContain("Checking the published");
    await expect(access(updateState)).rejects.toThrow();
  });
  it("shows nested PostgreSQL setup choices in the plain guide", async () => {
    const root = await makePostgresqlProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        interactions: [
          { after: "What would you like to do? [1]:", write: "\n" },
          {
            after: "Which database should Rehearsal use? [1]:",
            write: "\n",
          },
          {
            after: "Create these project-local files? (y/N)",
            write: "n\n",
          },
          { after: "What would you like to do? [1]:", write: "4\n" },
        ],
      }),
    ).replaceAll("\r", "");

    expect(output).toContain("1. PostgreSQL");
    expect(output).toContain("2. Supabase");
    expect(output).toContain("Database: PostgreSQL");
    expect(output).toContain(
      "PostgreSQL binds only to a dedicated loopback port",
    );
    await expect(
      readFile(join(root, "rehearsal.config.mjs"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

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
          { after: "What would you like to do? [1]:", write: "6\n" },
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
          { after: "What would you like to do? [1]:", write: "6\n" },
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
          { after: "What would you like to do? [1]:", write: "6\n" },
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
    const tools = await makeSupportTools(root);
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        toolPath: tools.toolPath,
        interactions: [
          { after: "What would you like to do? [1]:", write: "2\n" },
          { after: "What would you like to do? [1]:", write: "4\n" },
        ],
      }),
    ).replaceAll("\r", "");

    await tools.verify();

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
      const lock = join(
        tmpdir(),
        "rehearsal-db-operation-locks",
        createHash("sha256")
          .update(await realpath(root))
          .digest("hex"),
      );
      await expect(access(lock)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 15_000);

  it("runs help actions from the styled menu and returns home", async () => {
    const root = await makeProject();
    const tools = await makeSupportTools(root);
    const output = String(
      await runInPty({
        cwd: root,
        plain: false,
        toolPath: tools.toolPath,
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
    await tools.verify();
  }, 15_000);

  it("keeps every action visible in the completed styled menu", async () => {
    const root = await makeCompleteProject();
    await mkdir(join(root, ".rehearsal/runtime"), { recursive: true });
    await writeFile(join(root, ".rehearsal/runtime/baseline.json"), "{}\n");
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
    expect(output).toContain("Open the sandbox app");
    expect(output).toContain("Clean up disk space");
    expect(output).toContain("Show all commands");
    expect(output).toContain("Exit");
  }, 15_000);

  it("previews cleanup from the completed plain guide without deleting", async () => {
    const root = await makeCompleteProject();
    // This journey owns baseline-preview navigation, not ambient engine latency.
    // Closed unavailable tools prevent contacting the developer/runner's daemon.
    const tools = await makeUnavailableCleanupTools(root);
    const artifactRoot = join(root, ".rehearsal");
    const baseline = await verifyActiveBaseline({ artifactRoot });
    const generation = await realpath(join(artifactRoot, "current"));
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        toolPath: tools.toolPath,
        interactions: [
          { after: "What would you like to do? [1]:", write: "5\n" },
          {
            after: "What may Rehearsal include in the cleanup preview? [1]:",
            write: "\n",
          },
          { after: "What would you like to do? [1]:", write: "8\n" },
        ],
      }),
    ).replaceAll("\r", "");

    expect(output).toContain("REHEARSAL CLEANUP — PREVIEW");
    expect(output).toContain("Nothing has been removed");
    expect(output).toContain("See you at the next rehearsal.");
    expect(await verifyActiveBaseline({ artifactRoot })).toEqual(baseline);
    expect(await realpath(join(artifactRoot, "current"))).toBe(generation);
    const calls = (await readFile(tools.audit, "utf8")).trim().split("\n");
    expect(calls.length).toBeGreaterThan(0);
    expect([...new Set(calls)]).toEqual(["docker"]);
  }, 15_000);
});
