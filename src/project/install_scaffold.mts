/**
 * Purpose: Resolve an npm consumer root conservatively and create the same
 * project-owned scaffolding used by the guided setup command.
 */

import { access, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyRehearsalSetup, planRehearsalSetup } from "./setup.mjs";
import {
  findRehearsalConfigPath,
  inspectDetectedProject,
  loadRehearsalConfig,
} from "./configuration.mjs";

const PACKAGE_NAME = "@rehearsal-db/core";
const DEPENDENCY_GROUPS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const CACHE_SEGMENTS = new Set(["_cacache", "_npx", ".cache"]);

type PackageManifest = Record<string, unknown> & {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
};

interface PackageProject {
  root: string;
  manifest: PackageManifest;
}

export type ConsumerRootResolution =
  | { status: "skipped"; reason: string }
  | { status: "resolved"; projectRoot: string };

export interface ResolveConsumerRootOptions {
  packageRoot?: string;
  initCwd?: string;
  localPrefix?: string;
  globalInstall?: boolean | string;
  workspace?: string;
}

export interface InstalledScaffoldOptions {
  packageRoot?: string;
  environment?: NodeJS.ProcessEnv;
  isPortAvailable?: (port: number) => boolean | Promise<boolean>;
}

export interface InstalledScaffoldFile {
  path: string;
  action: string;
}

export type InstalledScaffoldResult =
  | { status: "skipped"; reason: string }
  | {
      status: "ready";
      projectRoot: string;
      target: string;
      files: InstalledScaffoldFile[];
      configurationPath: string;
      configurationAction: string;
      rootConfigGenerationSkipped: boolean;
    };

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

const pathExists = (path: string): Promise<boolean> =>
  access(path)
    .then(() => true)
    .catch((error) => {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    });

const readJson = async (path: string): Promise<PackageManifest> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${path}.`);
  }
  return value as PackageManifest;
};

const isInside = (parent: string, child: string): boolean => {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

const pathSegments = (path: string): string[] =>
  resolve(path).split(sep).filter(Boolean);

const isCachePath = (path: string): boolean =>
  pathSegments(path).some((segment) => CACHE_SEGMENTS.has(segment));

const isInstalledPackagePath = (packageRoot: string): boolean => {
  const segments = pathSegments(packageRoot);
  return (
    segments.at(-3) === "node_modules" &&
    segments.at(-2) === "@rehearsal-db" &&
    segments.at(-1) === "core"
  );
};

const declaresRehearsal = (manifest: PackageManifest): boolean =>
  DEPENDENCY_GROUPS.some((group) =>
    Object.hasOwn(
      typeof manifest[group] === "object" && manifest[group] !== null
        ? manifest[group]
        : {},
      PACKAGE_NAME,
    ),
  );

const readProject = async (root: string): Promise<PackageProject | null> => {
  const path = join(root, "package.json");
  if (!(await pathExists(path))) return null;
  const metadata = await stat(path);
  if (!metadata.isFile()) return null;
  return { root: resolve(root), manifest: await readJson(path) };
};

const workspacePatterns = (manifest: PackageManifest): string[] => {
  const value = manifest.workspaces;
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.packages)) return value.packages;
  return [];
};

const expandWorkspacePattern = async (
  root: string,
  pattern: string,
): Promise<string[]> => {
  if (
    typeof pattern !== "string" ||
    !pattern ||
    isAbsolute(pattern) ||
    pattern.split(/[\\/]/u).includes("..")
  ) {
    return [];
  }
  if (!pattern.includes("*")) return [resolve(root, pattern)];
  if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
    return [];
  }
  const parent = resolve(root, pattern.slice(0, -2));
  const entries = await readdir(parent, { withFileTypes: true }).catch(
    (error) => {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => join(parent, entry.name));
};

const workspaceProjectsFromManifest = async (
  project: PackageProject,
): Promise<PackageProject[]> => {
  const roots = (
    await Promise.all(
      workspacePatterns(project.manifest).map((pattern) =>
        expandWorkspacePattern(project.root, pattern),
      ),
    )
  ).flat();
  return (
    await Promise.all(
      roots.map((root) =>
        isInside(project.root, root) ? readProject(root) : null,
      ),
    )
  ).filter((entry): entry is PackageProject => entry !== null);
};

const workspaceProjectsFromLock = async (
  root: string,
): Promise<PackageProject[]> => {
  const path = join(root, "package-lock.json");
  if (!(await pathExists(path))) return [];
  const lock = await readJson(path);
  const packages =
    typeof lock.packages === "object" && lock.packages !== null
      ? (lock.packages as Record<string, PackageManifest>)
      : {};
  return (
    await Promise.all(
      Object.entries(packages)
        .filter(
          ([name, manifest]) =>
            name &&
            !name.split("/").includes("node_modules") &&
            declaresRehearsal(manifest),
        )
        .map(([name]) => readProject(resolve(root, name))),
    )
  ).filter((entry): entry is PackageProject => entry !== null);
};

const uniqueProjects = (
  projects: readonly (PackageProject | null)[],
): PackageProject[] => [
  ...new Map(
    projects
      .filter((entry): entry is PackageProject => entry !== null)
      .map((entry) => [entry.root, entry]),
  ).values(),
];

const skip = (reason: string): ConsumerRootResolution => ({
  status: "skipped",
  reason,
});

export const renderInstalledRehearsalScaffold = (
  result: InstalledScaffoldResult,
): string => {
  if (result.status !== "ready") {
    return `Rehearsal did not create project files: ${result.reason}.\nNext: run npx rehearsal from the application directory.`;
  }
  const changed = result.files.filter((file) => file.action !== "unchanged");
  return [
    "Rehearsal is ready in this project.",
    `Configuration: ${result.configurationPath} (${result.configurationAction === "create" ? "created" : "existing"})`,
    ...(result.rootConfigGenerationSkipped
      ? [
          `  Existing supported configuration detected at ${result.configurationPath}.`,
          "  rehearsal.config.mjs was not created because Rehearsal preserves one active configuration and never creates a competing file.",
        ]
      : []),
    ...(changed.length
      ? [
          ...changed.map(
            (file) => `  ${file.action === "create" ? "+" : "~"} ${file.path}`,
          ),
        ]
      : ["  Existing Rehearsal files preserved."]),
    `Next: review ${result.configurationPath}, then run npx rehearsal.`,
  ].join("\n");
};

export const resolveRehearsalConsumerRoot = async ({
  packageRoot,
  initCwd,
  localPrefix,
  globalInstall = false,
  workspace,
}: ResolveConsumerRootOptions = {}): Promise<ConsumerRootResolution> => {
  if (
    globalInstall === true ||
    (typeof globalInstall === "string" && ["1", "true"].includes(globalInstall))
  ) {
    return skip("global installations do not own an application project");
  }
  if (!packageRoot || !isInstalledPackagePath(packageRoot)) {
    return skip("the package is not running from a consumer node_modules tree");
  }
  if (isCachePath(packageRoot)) {
    return skip(
      "package-cache and temporary npx installs are not project roots",
    );
  }

  const anchorRoots = [
    ...new Set(
      [initCwd, localPrefix].filter(
        (path): path is string => typeof path === "string",
      ),
    ),
  ]
    .map((path) => resolve(path))
    .filter(
      (path) =>
        !pathSegments(path).includes("node_modules") && !isCachePath(path),
    );
  const anchors = uniqueProjects(
    await Promise.all(anchorRoots.map((root) => readProject(root))),
  );
  if (anchors.length === 0) {
    return skip("no application package.json was found for this installation");
  }
  const installationAnchors = anchors.filter((project) =>
    isInside(project.root, packageRoot),
  );
  if (installationAnchors.length === 0) {
    return skip(
      "the installed package is outside the candidate application root",
    );
  }

  const declared = [];
  const workspaces = [];
  for (const anchor of installationAnchors) {
    if (declaresRehearsal(anchor.manifest)) declared.push(anchor);
    const [manifestWorkspaces, lockWorkspaces] = await Promise.all([
      workspaceProjectsFromManifest(anchor),
      workspaceProjectsFromLock(anchor.root),
    ]);
    workspaces.push(...manifestWorkspaces, ...lockWorkspaces);
    declared.push(
      ...manifestWorkspaces.filter((project) =>
        declaresRehearsal(project.manifest),
      ),
      ...lockWorkspaces,
    );
  }
  if (workspace) {
    const requested = String(workspace).trim().replace(/\\/gu, "/");
    const selected = uniqueProjects(workspaces).filter(
      (project) =>
        project.manifest.name === requested ||
        installationAnchors.some(
          (anchor) =>
            relative(anchor.root, project.root).replace(/\\/gu, "/") ===
            requested.replace(/^\.\//u, ""),
        ),
    );
    if (selected.length === 1) {
      return { status: "resolved", projectRoot: selected[0]!.root };
    }
    if (selected.length > 1) {
      return skip("the npm workspace selector matched multiple applications");
    }
  }
  const candidates = uniqueProjects(declared);
  if (candidates.length === 1) {
    return { status: "resolved", projectRoot: candidates[0]!.root };
  }
  if (candidates.length > 1) {
    return skip(
      `multiple workspace applications declare ${PACKAGE_NAME}; run Rehearsal inside each application`,
    );
  }

  const exact = initCwd ? await readProject(resolve(initCwd)) : null;
  const primaryInstallationAnchor = installationAnchors[0]!;
  const workspaceRoot = installationAnchors.some(
    (project) => workspacePatterns(project.manifest).length > 0,
  );
  if (
    exact &&
    installationAnchors.some((anchor) => isInside(anchor.root, exact.root)) &&
    (!workspaceRoot || exact.root !== primaryInstallationAnchor.root)
  ) {
    return { status: "resolved", projectRoot: exact.root };
  }
  if (!workspaceRoot && installationAnchors.length === 1) {
    return {
      status: "resolved",
      projectRoot: primaryInstallationAnchor.root,
    };
  }
  return skip("the workspace application root is ambiguous");
};

export const createInstalledRehearsalScaffold = async ({
  packageRoot,
  environment = process.env,
  isPortAvailable,
}: InstalledScaffoldOptions = {}): Promise<InstalledScaffoldResult> => {
  const resolution = await resolveRehearsalConsumerRoot({
    ...(packageRoot === undefined ? {} : { packageRoot }),
    ...(environment.INIT_CWD === undefined
      ? {}
      : { initCwd: environment.INIT_CWD }),
    ...(environment.npm_config_local_prefix === undefined
      ? {}
      : { localPrefix: environment.npm_config_local_prefix }),
    ...(environment.npm_config_global === undefined
      ? {}
      : { globalInstall: environment.npm_config_global }),
    ...(environment.npm_config_workspace === undefined
      ? {}
      : { workspace: environment.npm_config_workspace }),
  });
  if (resolution.status !== "resolved") return resolution;

  const detected = await inspectDetectedProject({
    projectRoot: resolution.projectRoot,
  });
  const hasExistingConfig = await findRehearsalConfigPath({
    projectRoot: resolution.projectRoot,
  })
    .then(() => true)
    .catch((error) => {
      if (
        (error instanceof Error ? error.message : String(error)).startsWith(
          "No Rehearsal configuration",
        )
      ) {
        return false;
      }
      throw error;
    });
  const plan = await planRehearsalSetup({
    projectRoot: resolution.projectRoot,
    ...(hasExistingConfig
      ? {}
      : { target: detected.hasSupabaseConfig ? "supabase" : "postgresql" }),
    ...(isPortAvailable === undefined ? {} : { isPortAvailable }),
  });
  const result = await applyRehearsalSetup(plan);
  const loaded = await loadRehearsalConfig({
    projectRoot: resolution.projectRoot,
  });
  const configurationPath = relative(resolution.projectRoot, loaded.configPath);
  const configurationAction =
    result.files.find(({ path }) => path === configurationPath)?.action ??
    "unchanged";
  return {
    status: "ready",
    projectRoot: resolution.projectRoot,
    target: plan.target,
    files: result.files,
    configurationPath,
    configurationAction,
    rootConfigGenerationSkipped: configurationPath !== "rehearsal.config.mjs",
  };
};
