import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAndActivateBaseline } from "../../../../dist/src/baseline/artifact.mjs";
import {
  applyRehearsalCleanup,
  planRehearsalCleanup,
  parsePosixDiskUsage,
  selectOlderUnusedSupabaseImages,
} from "../../../../dist/src/runtime/resources/cleanup.mjs";

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
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeTreeWritable(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Rehearsal cleanup", () => {
  it("reviews only explicitly selected images without selecting baselines or runtime data", async () => {
    const projectRoot = await makeProject();
    const id = `sha256:${"a".repeat(64)}`;
    let candidates = [
      {
        id,
        tags: ["public.ecr.aws/supabase/postgres:old"],
        createdAt: "2026-09-01T00:00:00Z",
        bytes: 100,
      },
    ];
    const inspection = {
      inspectDockerUsage: () => ({
        available: true,
        resources: [],
        disk: null,
      }),
      runtimeDetected: async () => {
        throw new Error("Image-only review must not inspect the runtime");
      },
      inspectUnusedImages: () => candidates,
    };
    const plan = await planRehearsalCleanup({
      projectRoot,
      imagesOnly: true,
      includeImages: true,
      selectedImageIds: [id],
      inspection,
    });
    expect(plan.baselines.removed).toEqual([]);
    expect(plan.runtime).toMatchObject({ included: false, detected: false });
    expect(plan.images.candidates.map((i) => i.id)).toEqual([id]);
    candidates = [];
    await expect(
      applyRehearsalCleanup({
        projectRoot,
        plan,
        confirmation: plan.digest,
        inspection,
      }),
    ).rejects.toThrow("no longer an eligible");
    expect(
      await readdir(join(projectRoot, ".rehearsal/generations")),
    ).toHaveLength(3);
    await expect(
      planRehearsalCleanup({
        projectRoot,
        imagesOnly: true,
        includeRuntime: true,
        inspection,
      }),
    ).rejects.toThrow("cannot include a database");
  });
  it("rejects protected runtime cleanup while preserving ordinary baseline policy", async () => {
    const projectRoot = await makeProject();
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(projectRoot, "rehearsal.config.mjs"), "utf8"),
    );
    await writeFile(
      join(projectRoot, "rehearsal.config.mjs"),
      source.replace("runtime: {", "runtime: { protected: true,"),
    );
    await expect(
      planRehearsalCleanup({
        projectRoot,
        includeRuntime: true,
        inspection: isolatedInspection,
      }),
    ).rejects.toThrow("protected");
    expect(
      (
        await planRehearsalCleanup({
          projectRoot,
          inspection: isolatedInspection,
        })
      ).runtime.protected,
    ).toBe(true);
  });
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

  it("selects the same newest tag when Docker returns equal timestamps in any order", () => {
    const images = [
      {
        Id: "sha256:v16.1",
        Created: "2026-08-02T15:45:07Z",
        Size: 101,
        RepoTags: ["public.ecr.aws/supabase/postgrest:v16.1"],
      },
      {
        Id: "sha256:v16.4",
        Created: "2026-08-02T15:45:07Z",
        Size: 104,
        RepoTags: ["public.ecr.aws/supabase/postgrest:v16.4"],
      },
      {
        Id: "sha256:v16.2",
        Created: "2026-08-02T15:45:07Z",
        Size: 102,
        RepoTags: ["public.ecr.aws/supabase/postgrest:v16.2"],
      },
    ];
    const select = (input) =>
      selectOlderUnusedSupabaseImages({
        images: input,
        usedImageIds: new Set(),
      }).map(({ id }) => id);

    expect(select(images)).toEqual(["sha256:v16.1", "sha256:v16.2"]);
    expect(select([...images].reverse())).toEqual([
      "sha256:v16.1",
      "sha256:v16.2",
    ]);
  });
});

const boundCleanupFixture = () => {
  const oldId = "sha256:" + "a".repeat(64),
    newestId = "sha256:" + "b".repeat(64);
  const oldTag = "public.ecr.aws/supabase/postgres:old";
  const state = {
    context: "reviewed",
    endpoint: "unix:///synthetic/cleanup.sock",
    daemon: "reviewed-daemon",
    afterTag: () => {},
  };
  const calls = [],
    removed = [];
  const run = (_command, args, _cwd, env) => {
    calls.push({ args: [...args], env });
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "context") {
      if (args[1] === "show") return ok(state.context);
      if (args[1] === "ls") return ok(state.context);
      return ok(
        args[3] ===
          "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}"
          ? "false"
          : JSON.stringify(state.endpoint),
      );
    }
    expect(args[0]).toBe("--host");
    expect(env.DOCKER_HOST).toBe(args[1]);
    const a = args.slice(2);
    if (a[0] === "info") return ok(JSON.stringify(state.daemon));
    if (a[0] === "system") return ok();
    if (a[0] === "container" && a[1] === "ls") return ok();
    if (a[0] === "image" && a[1] === "ls") return ok(oldId + "\n" + newestId);
    if (a[0] === "image" && a[1] === "inspect" && a[3] === "{{json .}}")
      return ok(
        [
          {
            Id: oldId,
            Created: "2026-01-01T00:00:00Z",
            Size: 100,
            RepoTags: [oldTag],
          },
          {
            Id: newestId,
            Created: "2026-02-01T00:00:00Z",
            Size: 100,
            RepoTags: ["public.ecr.aws/supabase/postgres:new"],
          },
        ]
          .map(JSON.stringify)
          .join("\n"),
      );
    if (a[0] === "image" && a[1] === "inspect" && a[3] === "{{.Id}}") {
      state.afterTag();
      return ok(oldId);
    }
    if (a[0] === "image" && a[1] === "rm") {
      removed.push(a[2]);
      return ok();
    }
    throw new Error("Unexpected synthetic cleanup command");
  };
  return { state, calls, removed, inspection: { run }, oldTag };
};
describe("selected cleanup engine binding", () => {
  it("preserves explicit context/config and removes only reviewed unused tags on the pinned host", async () => {
    const root = await makeProject(),
      f = boundCleanupFixture();
    vi.stubEnv("DOCKER_CONTEXT", f.state.context);
    vi.stubEnv("DOCKER_HOST", "ssh://ignored-by-context");
    vi.stubEnv("DOCKER_CONFIG", root);
    const plan = await planRehearsalCleanup({
      projectRoot: root,
      includeImages: true,
      imagesOnly: true,
      inspection: f.inspection,
    });
    expect(plan.docker).toMatchObject({
      engineIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      daemonId: f.state.daemon,
      disk: null,
    });
    const done = await applyRehearsalCleanup({
      projectRoot: root,
      plan,
      confirmation: plan.digest,
      inspection: f.inspection,
    });
    expect(done.imagesRemoved).toEqual([f.oldTag]);
    expect(f.removed).toEqual([f.oldTag]);
    const canonical = await realpath(root);
    expect(
      f.calls.every(
        ({ env }) => env.DOCKER_CONFIG === canonical && !env.DOCKER_CONTEXT,
      ),
    ).toBe(true);
    expect(
      f.calls
        .filter(({ args }) => args[0] !== "context")
        .every(
          ({ args }) =>
            args.slice(0, 2).join(" ") === `--host ${f.state.endpoint}`,
        ),
    ).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(canonical);
    expect(
      f.calls.some(
        ({ args }) => args.includes("prune") || args.includes("--force"),
      ),
    ).toBe(false);
  });
  it.each(["endpoint", "daemon"])(
    "refuses %s drift after preview before removing any image",
    async (field) => {
      const root = await makeProject(),
        f = boundCleanupFixture();
      const plan = await planRehearsalCleanup({
        projectRoot: root,
        includeImages: true,
        imagesOnly: true,
        inspection: f.inspection,
      });
      if (field === "endpoint")
        f.state.endpoint = "unix:///synthetic/replacement.sock";
      else f.state.daemon = "replacement-daemon";
      await expect(
        applyRehearsalCleanup({
          projectRoot: root,
          plan,
          confirmation: plan.digest,
          inspection: f.inspection,
        }),
      ).rejects.toThrow("changed after the preview");
      expect(f.removed).toEqual([]);
    },
  );
  it.each(["endpoint", "daemon"])(
    "rechecks %s immediately before mutation",
    async (field) => {
      const root = await makeProject(),
        f = boundCleanupFixture();
      const plan = await planRehearsalCleanup({
        projectRoot: root,
        includeImages: true,
        imagesOnly: true,
        inspection: f.inspection,
      });
      f.state.afterTag = () => {
        if (field === "endpoint")
          f.state.endpoint = "unix:///synthetic/replacement.sock";
        else f.state.daemon = "replacement-daemon";
      };
      await expect(
        applyRehearsalCleanup({
          projectRoot: root,
          plan,
          confirmation: plan.digest,
          inspection: f.inspection,
        }),
      ).rejects.toThrow("daemon changed after preview");
      expect(f.removed).toEqual([]);
    },
  );
  it("refuses a legacy unbound image plan and unknown daemon identity", async () => {
    const root = await makeProject(),
      f = boundCleanupFixture();
    const plan = await planRehearsalCleanup({
      projectRoot: root,
      includeImages: true,
      imagesOnly: true,
      inspection: f.inspection,
    });
    const legacyIdentity = {
      projectId: plan.projectId,
      engineIdentity: plan.docker.engineIdentity,
      imagesOnly: plan.imagesOnly,
      protectedRuntime: plan.runtime.protected,
      retainBaselineGenerations: plan.retainBaselineGenerations,
      baselineGenerations: plan.baselines.removed,
      runtime: plan.runtime.included && plan.runtime.detected,
      images: plan.images.candidates.map(({ id, tags }) => ({ id, tags })),
    };
    const legacy = {
      ...plan,
      docker: { ...plan.docker, daemonId: undefined },
      digest: createHash("sha256")
        .update(JSON.stringify(legacyIdentity))
        .digest("hex"),
    };
    await expect(
      applyRehearsalCleanup({
        projectRoot: root,
        plan: legacy,
        confirmation: legacy.digest,
        inspection: f.inspection,
      }),
    ).rejects.toThrow();
    expect(f.removed).toEqual([]);
    f.state.daemon = "";
    const unknown = await planRehearsalCleanup({
      projectRoot: root,
      includeImages: true,
      imagesOnly: true,
      inspection: f.inspection,
    });
    expect(unknown.docker.available).toBe(false);
    expect(unknown.images.inspected).toBe(false);
  });
  it("keeps baseline-only preview usable when Docker is unknown without contacting fallback", async () => {
    const root = await makeProject();
    const run = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }));
    const plan = await planRehearsalCleanup({
      projectRoot: root,
      inspection: { run },
    });
    expect(plan.docker).toMatchObject({ available: false, disk: null });
    expect(plan.baselines.available).toBe(true);
    expect(run.mock.calls.every(([, args]) => args[0] === "context")).toBe(
      true,
    );
  });
  it.each([{ DOCKER_HOST: "ssh://remote" }, { DOCKER_TLS_VERIFY: "1" }])(
    "refuses explicit foreign selection without fallback: %s",
    async (env) => {
      const root = await makeProject(),
        f = boundCleanupFixture();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      await expect(
        planRehearsalCleanup({
          projectRoot: root,
          includeImages: true,
          inspection: f.inspection,
        }),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
      expect(f.removed).toEqual([]);
    },
  );
});
