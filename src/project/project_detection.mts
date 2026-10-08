/** Inspect project-local files used to render a conservative starter config. */

import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export interface DetectedProject {
  projectName: string;
  packageManager: "npm" | "pnpm" | "yarn";
  hasSupabaseConfig: boolean;
  hasMigrations: boolean;
  hasPostgresqlMigrations: boolean;
  postgresqlMigrationDirectory: string;
  applicationCommand: string;
  verificationCommand: string;
}

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

export const inspectDetectedProject = async ({
  projectRoot = process.cwd(),
}: {
  projectRoot?: string;
} = {}): Promise<DetectedProject> => {
  const root = resolve(projectRoot);
  const packageJsonPath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const hasPath = async (path: string): Promise<boolean> =>
    stat(join(root, path))
      .then(() => true)
      .catch((error) => {
        if (hasErrorCode(error, "ENOENT")) return false;
        throw error;
      });
  const packageManager = (await hasPath("pnpm-lock.yaml"))
    ? "pnpm"
    : (await hasPath("yarn.lock"))
      ? "yarn"
      : "npm";
  const scripts = packageJson.scripts ?? {};
  const postgresqlMigrationDirectory = (
    await Promise.all(
      ["database/migrations", "db/migrations", "migrations"].map(
        async (path) => ({ path, exists: await hasPath(path) }),
      ),
    )
  ).find(({ exists }) => exists)?.path;
  const normalizedProjectName = String(packageJson.name ?? basename(root))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-|-$/gu, "");
  const projectName =
    normalizedProjectName.slice(0, 52).replace(/-$/u, "") ||
    "rehearsal-project";
  return {
    projectName,
    packageManager,
    hasSupabaseConfig: await hasPath("supabase/config.toml"),
    hasMigrations: await hasPath("supabase/migrations"),
    hasPostgresqlMigrations: Boolean(postgresqlMigrationDirectory),
    postgresqlMigrationDirectory:
      postgresqlMigrationDirectory ?? "database/migrations",
    applicationCommand:
      ["dev:rehearsal", "dev", "start"]
        .find((name) => typeof scripts[name] === "string")
        ?.replace(/^/u, `${packageManager} run `) ??
      `${packageManager} run dev`,
    verificationCommand:
      ["verify:feature", "test", "check"]
        .find((name) => typeof scripts[name] === "string")
        ?.replace(/^/u, `${packageManager} run `) ?? `${packageManager} test`,
  };
};
