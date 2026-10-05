import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRefreshWorkflow } from "../../../src/cli/source_commands.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("refresh workflow failure boundaries", () => {
  it("does not touch an edited runtime when baseline preparation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-refresh-workflow-"));
    roots.push(root);
    const runtimeState = join(root, "edited-runtime-state.json");
    await writeFile(runtimeState, '{"draft":"keep this local edit"}\n');
    const runRuntimeStack = vi.fn();
    const prepareDependentTargets = vi.fn();
    const workflow = createRefreshWorkflow({
      runRuntimeStack,
      prepareDependentTargets,
      topologyCommandEnvironment: vi.fn(),
      buildPlan: async () => ({
        loaded: { paths: { artifactDirectory: join(root, ".rehearsal") } },
        plan: { digest: "reviewed-refresh-plan", review: {} },
      }),
      refreshBaseline: async () => {
        throw new Error("synthetic source network loss");
      },
    });

    await expect(
      workflow({
        flags: { refreshConfirmation: "reviewed-refresh-plan" },
        planOptions: { cwd: root },
      }),
    ).rejects.toThrow("source network loss");
    expect(runRuntimeStack).not.toHaveBeenCalled();
    expect(prepareDependentTargets).not.toHaveBeenCalled();
    expect(await readFile(runtimeState, "utf8")).toBe(
      '{"draft":"keep this local edit"}\n',
    );
  });
});
