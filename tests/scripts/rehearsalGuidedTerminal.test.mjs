import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "@lydell/node-pty";

const roots = [];
const cliPath = join(
  process.cwd(),
  "scripts/operations/rehearsal/rehearsal_cli.mjs",
);

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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("guided terminal journey", () => {
  it("returns to the home screen after an action in a real PTY", async () => {
    const root = await makeProject();
    const output = String(
      await runInPty({
        cwd: root,
        plain: true,
        interactions: [
          { after: "What would you like to do? [1]:", write: "2\n" },
          { after: "What would you like to do? [1]:", write: "3\n" },
        ],
      }),
    ).replaceAll("\r", "");

    expect(output.match(/Safe local migration testing/gu)).toHaveLength(2);
    expect(output).toContain("Usage: rehearsal <command> [options]");
    expect(output).toContain("No changes made.");
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
    expect(output).toContain("Stage saved. See you next rehearsal.");
  }, 15_000);
});
