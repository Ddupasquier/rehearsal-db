import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const cli = join(process.cwd(), "dist/src/cli/rehearsal.mjs");
const roots = [];
const histories = [];
const createProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-cli-activity-"));
  roots.push(root);
  await cp(join(process.cwd(), "tests/fixtures/rehearsal-project"), root, {
    recursive: true,
  });
  const projectHash = createHash("sha256")
    .update(await realpath(root))
    .digest("hex");
  histories.push(
    join(tmpdir(), "rehearsal-db-operation-activity", `${projectHash}.json`),
  );
  return root;
};
const runCli = async (root, args) =>
  JSON.parse(
    (
      await execute(process.execPath, [cli, ...args, "--json", "--plain"], {
        cwd: root,
        timeout: 10_000,
      })
    ).stdout,
  );
const makeOwnedTreeWritable = async (root) => {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory())
      await makeOwnedTreeWritable(join(root, entry.name));
    else if (!entry.isSymbolicLink())
      await chmod(join(root, entry.name), 0o600);
  }
};

afterEach(async () => {
  for (const history of histories.splice(0)) await rm(history, { force: true });
  for (const root of roots.splice(0)) {
    await makeOwnedTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("actual CLI operation activity contract", () => {
  it("archives completed local work before releasing ownership and does not invent read-only history", async () => {
    const root = await createProject();
    const baseline = await runCli(root, [
      "baseline",
      "create",
      "--records=rehearsal/sanitized-data.ndjson",
      "--ledger=rehearsal/migration-ledger.json",
    ]);
    expect(baseline.status).toBe("success");
    const activity = await runCli(root, ["activity"]);
    expect(activity.data).toMatchObject({
      state: "idle",
      operation: null,
      recent: [
        {
          kind: "baseline create",
          progress: { state: "completed", currentStage: null },
        },
      ],
    });
    expect(activity.data.recent).toHaveLength(1);
    expect(activity.data.recent[0].progress.completedStages).toEqual([]);
    const historyBefore = await readFile(histories.at(-1), "utf8");
    await runCli(root, ["candidates"]);
    await runCli(root, ["activity"]);
    expect(await readFile(histories.at(-1), "utf8")).toBe(historyBefore);
    expect(JSON.stringify(activity.data)).not.toMatch(
      /ownerToken|"pid"|"token"|private-key/u,
    );
  });

  it("records a refused mutation honestly without claiming a runtime phase occurred", async () => {
    const root = await createProject();
    let failure;
    try {
      await runCli(root, ["run"]);
    } catch (error) {
      failure = JSON.parse(error.stdout);
    }
    expect(failure.status).toBe("error");
    const activity = await runCli(root, ["activity"]);
    expect(activity.data).toMatchObject({
      state: "idle",
      operation: null,
      recent: [
        {
          kind: "run",
          progress: {
            state: "failed",
            currentStage: null,
            completedStages: [],
          },
        },
      ],
    });
    expect(
      activity.data.recent[0].progress.events.map((event) => event.code),
    ).toEqual(["operation.started", "operation.failed"]);
    expect(JSON.stringify(activity.data)).not.toContain(root);
  });
});
