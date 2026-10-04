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

const pathExists = (path) =>
  access(path)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const isInside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

const pathSegments = (path) => resolve(path).split(sep).filter(Boolean);

const isCachePath = (path) =>
  pathSegments(path).some((segment) => CACHE_SEGMENTS.has(segment));

const isInstalledPackagePath = (packageRoot) => {
  const segments = pathSegments(packageRoot);
  return (
    segments.at(-3) === "node_modules" &&
    segments.at(-2) === "@rehearsal-db" &&
    segments.at(-1) === "core"
  );
};

const declaresRehearsal = (manifest) =>
  DEPENDENCY_GROUPS.some((group) =>
    Object.hasOwn(manifest[group] ?? {}, PACKAGE_NAME),
  );

const readProject = async (root) => {
  const path = join(root, "package.json");
  if (!(await pathExists(path))) return null;
  const metadata = await stat(path);
  if (!metadata.isFile()) return null;
  return { root: resolve(root), manifest: await readJson(path) };
};

const workspacePatterns = (manifest) => {
  const value = manifest.workspaces;
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.packages)) return value.packages;
  return [];
};

const expandWorkspacePattern = async (root, pattern) => {
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
      if (error?.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => join(parent, entry.name));
};

const workspaceProjectsFromManifest = async (project) => {
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
  ).filter(Boolean);
};

const workspaceProjectsFromLock = async (root) => {
  const path = join(root, "package-lock.json");
  if (!(await pathExists(path))) return [];
  const lock = await readJson(path);
  return (
    await Promise.all(
      Object.entries(lock.packages ?? {})
        .filter(
          ([name, manifest]) =>
            name &&
            !name.split("/").includes("node_modules") &&
            declaresRehearsal(manifest),
        )
        .map(([name]) => readProject(resolve(root, name))),
    )
  ).filter(Boolean);
};

const uniqueProjects = (projects) => [
  ...new Map(
    projects.filter(Boolean).map((entry) => [entry.root, entry]),
  ).values(),
];

const skip = (reason) => ({ status: "skipped", reason });

export const resolveRehearsalConsumerRoot = async ({
  packageRoot,
  initCwd,
  localPrefix,
  globalInstall = false,
  workspace,
} = {}) => {
  if (globalInstall === true || ["1", "true"].includes(globalInstall)) {
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

  const anchorRoots = [...new Set([initCwd, localPrefix].filter(Boolean))]
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
      return { status: "resolved", projectRoot: selected[0].root };
    }
    if (selected.length > 1) {
      return skip("the npm workspace selector matched multiple applications");
    }
  }
  const candidates = uniqueProjects(declared);
  if (candidates.length === 1) {
    return { status: "resolved", projectRoot: candidates[0].root };
  }
  if (candidates.length > 1) {
    return skip(
      `multiple workspace applications declare ${PACKAGE_NAME}; run Rehearsal inside each application`,
    );
  }

  const exact = initCwd ? await readProject(resolve(initCwd)) : null;
  const workspaceRoot = installationAnchors.some(
    (project) => workspacePatterns(project.manifest).length > 0,
  );
  if (
    exact &&
    installationAnchors.some((anchor) => isInside(anchor.root, exact.root)) &&
    (!workspaceRoot || exact.root !== installationAnchors[0].root)
  ) {
    return { status: "resolved", projectRoot: exact.root };
  }
  if (!workspaceRoot && installationAnchors.length === 1) {
    return {
      status: "resolved",
      projectRoot: installationAnchors[0].root,
    };
  }
  return skip("the workspace application root is ambiguous");
};

export const createInstalledRehearsalScaffold = async ({
  packageRoot,
  environment = process.env,
  isPortAvailable,
} = {}) => {
  const resolution = await resolveRehearsalConsumerRoot({
    packageRoot,
    initCwd: environment.INIT_CWD,
    localPrefix: environment.npm_config_local_prefix,
    globalInstall: environment.npm_config_global,
    workspace: environment.npm_config_workspace,
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
        String(error?.message ?? error).startsWith("No Rehearsal configuration")
      ) {
        return false;
      }
      throw error;
    });
  const plan = await planRehearsalSetup({
    projectRoot: resolution.projectRoot,
    target: hasExistingConfig
      ? undefined
      : detected.hasSupabaseConfig
        ? "supabase"
        : "postgresql",
    isPortAvailable,
  });
  const result = await applyRehearsalSetup(plan);
  await loadRehearsalConfig({ projectRoot: resolution.projectRoot });
  return {
    status: "ready",
    projectRoot: resolution.projectRoot,
    target: plan.target,
    files: result.files,
  };
};
