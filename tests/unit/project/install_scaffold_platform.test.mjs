import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  inspectHostPlatform: vi.fn(),
  inspectDetectedProject: vi.fn(),
  loadRehearsalConfig: vi.fn(),
  findRehearsalConfigPath: vi.fn(),
  planRehearsalSetup: vi.fn(),
  applyRehearsalSetup: vi.fn(),
}));

vi.mock("../../../dist/src/shared/host_platform.mjs", () => ({
  inspectHostPlatform: boundary.inspectHostPlatform,
}));
vi.mock(
  "../../../dist/src/project/configuration.mjs",
  async (importOriginal) => ({
    ...(await importOriginal()),
    inspectDetectedProject: boundary.inspectDetectedProject,
    loadRehearsalConfig: boundary.loadRehearsalConfig,
    findRehearsalConfigPath: boundary.findRehearsalConfigPath,
  }),
);
vi.mock("../../../dist/src/project/setup.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  planRehearsalSetup: boundary.planRehearsalSetup,
  applyRehearsalSetup: boundary.applyRehearsalSetup,
}));

import {
  createInstalledRehearsalScaffold,
  renderInstalledRehearsalScaffold,
} from "../../../dist/src/project/install_scaffold.mjs";

const roots = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const workspaceConsumer = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-install-platform-"));
  roots.push(root);
  const projectRoot = join(root, "apps/consumer");
  const packageRoot = join(root, "node_modules/@rehearsal-db/core");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "workspace",
      private: true,
      workspaces: ["apps/*"],
    }),
  );
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({
      name: "consumer",
      devDependencies: { "@rehearsal-db/core": "1.0.1" },
    }),
  );
  await writeFile(
    join(projectRoot, "rehearsal.config.mjs"),
    'throw new Error("PROJECT_CONFIG_EXECUTED");\n',
  );
  return { root, projectRoot, packageRoot };
};

describe("install scaffold host boundary", () => {
  it.each(["windows", "wsl2"])(
    "skips %s preparation using the exact resolved workspace, before project code or files",
    async (kind) => {
      const { root, projectRoot, packageRoot } = await workspaceConsumer();
      boundary.inspectHostPlatform.mockResolvedValue({
        kind,
        supported: false,
        detail: "This project filesystem is unsupported.",
        remediation: "Use WSL2 with the project in its Linux home filesystem.",
      });
      const result = await createInstalledRehearsalScaffold({
        packageRoot,
        environment: { INIT_CWD: root, npm_config_local_prefix: root },
      });

      expect(boundary.inspectHostPlatform).toHaveBeenCalledExactlyOnceWith({
        projectRoot,
      });
      expect(result).toMatchObject({ status: "skipped" });
      expect(renderInstalledRehearsalScaffold(result)).toContain(
        "Linux home filesystem",
      );
      expect(boundary.inspectDetectedProject).not.toHaveBeenCalled();
      expect(boundary.findRehearsalConfigPath).not.toHaveBeenCalled();
      expect(boundary.loadRehearsalConfig).not.toHaveBeenCalled();
      expect(boundary.planRehearsalSetup).not.toHaveBeenCalled();
      expect(boundary.applyRehearsalSetup).not.toHaveBeenCalled();
      expect((await readdir(projectRoot)).sort()).toEqual([
        "package.json",
        "rehearsal.config.mjs",
      ]);
      expect(
        await readFile(join(projectRoot, "rehearsal.config.mjs"), "utf8"),
      ).toContain("PROJECT_CONFIG_EXECUTED");
    },
  );

  it("continues existing preparation for a supported resolved workspace", async () => {
    const { root, projectRoot, packageRoot } = await workspaceConsumer();
    boundary.inspectHostPlatform.mockResolvedValue({
      kind: "linux",
      supported: true,
    });
    boundary.inspectDetectedProject.mockResolvedValue({
      hasSupabaseConfig: false,
    });
    boundary.findRehearsalConfigPath.mockResolvedValue(
      join(projectRoot, "rehearsal.config.mjs"),
    );
    boundary.planRehearsalSetup.mockResolvedValue({ target: "postgresql" });
    boundary.applyRehearsalSetup.mockResolvedValue({ files: [] });
    boundary.loadRehearsalConfig.mockResolvedValue({
      configPath: join(projectRoot, "rehearsal.config.mjs"),
    });

    const result = await createInstalledRehearsalScaffold({
      packageRoot,
      environment: { INIT_CWD: root, npm_config_local_prefix: root },
    });
    expect(result).toMatchObject({
      status: "ready",
      projectRoot,
      target: "postgresql",
    });
    expect(boundary.inspectHostPlatform).toHaveBeenCalledExactlyOnceWith({
      projectRoot,
    });
    expect(boundary.planRehearsalSetup).toHaveBeenCalledExactlyOnceWith({
      projectRoot,
    });
    expect(boundary.applyRehearsalSetup).toHaveBeenCalledExactlyOnceWith({
      target: "postgresql",
    });
  });

  it("does not inspect a filesystem or prepare files when no consumer resolves", async () => {
    const result = await createInstalledRehearsalScaffold({
      packageRoot: process.cwd(),
      environment: {},
    });
    expect(result.status).toBe("skipped");
    expect(boundary.inspectHostPlatform).not.toHaveBeenCalled();
    expect(boundary.planRehearsalSetup).not.toHaveBeenCalled();
  });
});
