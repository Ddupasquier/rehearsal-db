import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAndActivateBaseline } from "../../../dist/src/baseline/artifact.mjs";
import {
  applyRehearsalCleanup,
  planRehearsalCleanup,
  parsePosixDiskUsage,
  selectOlderUnusedSupabaseImages,
} from "../../../dist/src/runtime/cleanup.mjs";

const roots = [];
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
const metadata = {
  migrationCutoff: "20260101000000",
  migrationHistorySha256: "a".repeat(64),
  sanitizationPolicySha256: "b".repeat(64),
};
const isolatedInspection = Object.freeze({
  inspectDockerUsage: () => ({ available: false, resources: [], disk: null }),
  runtimeDetected: async () => false,
});

const makeProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-cleanup-test-"));
  roots.push(root);
  await mkdir(join(root, "supabase/migrations"), { recursive: true });
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `export default {
      schemaVersion: 1,
      project: { name: "cleanup-test" },
      supabase: {
        workdir: ".",
        migrationDirectory: "supabase/migrations",
        rehearsalConfig: "supabase/config.toml",
        runtimeWorkdir: ".rehearsal/runtime",
      },
      baseline: {
        artifactDirectory: ".rehearsal",
        sanitizationPolicy: "rehearsal/policy.json",
      },
      cleanup: { retainBaselineGenerations: 2 },
      application: { startCommand: "npm run dev", proofCommand: "npm test" },
      runtime: {
        applicationUrl: "http://localhost:5175",
        projectId: "cleanup-test-rehearsal",
        apiPort: 58321,
        databasePort: 58322,
        studioPort: 58323,
      },
      safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
    };\n`,
  );
  for (const generationId of [
    "20261002T120000Z-aaaaaaaaaaaa",
    "20261002T120100Z-bbbbbbbbbbbb",
    "20261002T120200Z-cccccccccccc",
  ]) {
    await createAndActivateBaseline({
      artifactRoot: join(root, ".rehearsal"),
      generationId,
      metadata,
      records: [],
    });
  }
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

describe("Rehearsal cleanup", () => {
  it("parses container disk capacity without depending on localized labels", () => {
    expect(
      parsePosixDiskUsage(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vdb1 41943040 37748736 1468006 97% /var/lib/docker\n",
      ),
    ).toEqual({
      totalBytes: 42_949_672_960,
      usedBytes: 38_654_705_664,
      availableBytes: 1_503_238_144,
      usedPercent: 97,
    });
  });

  it("previews and removes only baseline generations outside configured retention", async () => {
    const projectRoot = await makeProject();
    const plan = await planRehearsalCleanup({
      projectRoot,
      inspection: isolatedInspection,
    });

    expect(plan.baselines).toMatchObject({
      available: true,
      retained: [
        "20261002T120200Z-cccccccccccc",
        "20261002T120100Z-bbbbbbbbbbbb",
      ],
      removed: ["20261002T120000Z-aaaaaaaaaaaa"],
    });
    expect(plan.runtime.included).toBe(false);
    expect(plan.images).toMatchObject({ requested: false, inspected: false });

    const removeRuntime = vi.fn();
    const result = await applyRehearsalCleanup({
      plan,
      confirmation: plan.digest,
      projectRoot,
      removeRuntime,
      inspection: isolatedInspection,
    });

    expect(removeRuntime).not.toHaveBeenCalled();
    expect(result.baselines.removed).toEqual(["20261002T120000Z-aaaaaaaaaaaa"]);
    expect(
      (await readdir(join(projectRoot, ".rehearsal/generations"))).sort(),
    ).toEqual([
      "20261002T120100Z-bbbbbbbbbbbb",
      "20261002T120200Z-cccccccccccc",
    ]);
  });

  it("refuses cleanup when the selected baseline set changes after preview", async () => {
    const projectRoot = await makeProject();
    const plan = await planRehearsalCleanup({
      projectRoot,
      inspection: isolatedInspection,
    });
    await createAndActivateBaseline({
      artifactRoot: join(projectRoot, ".rehearsal"),
      generationId: "20261002T120300Z-dddddddddddd",
      metadata,
      records: [],
    });

    await expect(
      applyRehearsalCleanup({
        plan,
        confirmation: plan.digest,
        projectRoot,
        inspection: isolatedInspection,
      }),
    ).rejects.toThrow("changed after the preview");
    await expect(
      stat(
        join(
          projectRoot,
          ".rehearsal/generations/20261002T120000Z-aaaaaaaaaaaa",
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it("requires the exact cleanup digest before applying anything", async () => {
    const projectRoot = await makeProject();
    const plan = await planRehearsalCleanup({
      projectRoot,
      inspection: isolatedInspection,
    });

    await expect(
      applyRehearsalCleanup({
        plan,
        projectRoot,
        inspection: isolatedInspection,
      }),
    ).rejects.toThrow("exact --confirm-cleanup digest");
    await expect(
      applyRehearsalCleanup({
        plan,
        confirmation: "not-the-reviewed-plan",
        projectRoot,
        inspection: isolatedInspection,
      }),
    ).rejects.toThrow("exact --confirm-cleanup digest");
    await expect(
      stat(
        join(
          projectRoot,
          ".rehearsal/generations/20261002T120000Z-aaaaaaaaaaaa",
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it("selects only older, unused Supabase images and keeps each newest version", () => {
    const images = [
      {
        Id: "sha256:new",
        Created: "2026-10-02T12:00:00Z",
        Size: 200,
        RepoTags: ["public.ecr.aws/supabase/studio:new"],
      },
      {
        Id: "sha256:used",
        Created: "2026-10-01T12:00:00Z",
        Size: 150,
        RepoTags: ["public.ecr.aws/supabase/studio:used"],
      },
      {
        Id: "sha256:old",
        Created: "2026-09-01T12:00:00Z",
        Size: 100,
        RepoTags: ["public.ecr.aws/supabase/studio:old"],
      },
      {
        Id: "sha256:other",
        Created: "2026-08-01T12:00:00Z",
        Size: 90,
        RepoTags: ["example.com/private/studio:old"],
      },
    ];

    expect(
      selectOlderUnusedSupabaseImages({
        images,
        usedImageIds: new Set(["sha256:used"]),
      }),
    ).toEqual([
      {
        id: "sha256:old",
        createdAt: "2026-09-01T12:00:00Z",
        bytes: 100,
        tags: ["public.ecr.aws/supabase/studio:old"],
      },
    ]);
  });
});
