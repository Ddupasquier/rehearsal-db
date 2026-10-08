/**
 * Purpose: Plan and apply conservative first-run Rehearsal scaffolding without
 * contacting hosted services or overwriting project-owned files.
 */

import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  findRehearsalConfigPath,
  inspectDetectedProject,
  loadRehearsalConfig,
  renderDetectedConfig,
  renderDetectedPostgresqlConfig,
} from "./configuration.mjs";
import { resolveRuntimeTarget } from "../targets/target.mjs";
export {
  assertSupportedRehearsalNodeRuntime,
  inspectRehearsalNodeRuntime,
} from "../shared/node_runtime.mjs";
import { assertSupportedRehearsalNodeRuntime } from "../shared/node_runtime.mjs";
import type { DetectedProject } from "./configuration.mjs";
import type { FileHandle } from "node:fs/promises";
import type { RehearsalRuntimeTargetId } from "../targets/target.mjs";

const CONFIG_PATH = "rehearsal.config.mjs";
const LOCAL_SUPABASE_CONFIG_PATH =
  "infrastructure/rehearsal/supabase/config.toml";
const GITIGNORE_PATH = ".gitignore";
const PORT_OFFSETS = Object.freeze({
  shadow: 0,
  api: 1,
  database: 2,
  studio: 3,
  smtp: 4,
  pooler: 9,
});

type PortAvailability = (port: number) => boolean | Promise<boolean>;

interface SupabasePorts {
  shadow: number;
  api: number;
  database: number;
  studio: number;
  smtp: number;
  pooler: number;
}

interface SetupFile {
  path: string;
  absolutePath: string;
  action: "create" | "update" | "unchanged";
  mode: number;
  content: string | null;
  originalContent?: string | null;
}

export interface PlanRehearsalSetupOptions {
  projectRoot?: string;
  configPath?: string;
  isPortAvailable?: PortAvailability;
  target?: RehearsalRuntimeTargetId;
}

export interface RehearsalSetupPlan {
  projectRoot: string;
  configurationPath: string;
  project: string;
  projectId: string;
  target: RehearsalRuntimeTargetId;
  applicationUrl: string;
  detected: DetectedProject;
  ports: Record<string, number> & { database: number };
  requiresAvailablePorts: boolean;
  isPortAvailable: PortAvailability;
  files: SetupFile[];
  safety: string[];
}

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

const readOptionalFile = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
};

const canConnectToPort = (port: number): Promise<boolean> =>
  new Promise<boolean>((resolveAvailability) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (result: boolean): void => {
      socket.destroy();
      resolveAvailability(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });

const canBindToPort = (port: number): Promise<boolean> =>
  new Promise<boolean>((resolveAvailability) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveAvailability(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolveAvailability(true));
    });
  });

export const isRehearsalPortAvailable = async (
  port: number,
): Promise<boolean> => {
  if (await canConnectToPort(port)) return false;
  return canBindToPort(port);
};

export const findAvailableRehearsalPorts = async ({
  isAvailable = isRehearsalPortAvailable,
}: {
  isAvailable?: PortAvailability;
} = {}): Promise<SupabasePorts> => {
  for (let base = 58_320; base <= 65_520; base += 20) {
    const entries = Object.entries(PORT_OFFSETS).map(([name, offset]) => [
      name,
      base + offset,
    ]);
    const availability = await Promise.all(
      entries.map(([, port]) => isAvailable(port as number)),
    );
    if (availability.every(Boolean))
      return Object.fromEntries(entries) as unknown as SupabasePorts;
  }
  throw new Error(
    "Rehearsal could not find an available local port block between 58320 and 65529.",
  );
};

const databaseMajorVersionFrom = (source: string | null): number => {
  const match = /^\s*major_version\s*=\s*(\d+)\s*(?:#.*)?$/imu.exec(
    source ?? "",
  );
  return match ? Number(match[1]) : 17;
};

export const renderSafeLocalSupabaseConfig = ({
  projectId,
  applicationUrl,
  ports,
  databaseMajorVersion = 17,
}: {
  projectId: string;
  applicationUrl: string;
  ports: SupabasePorts;
  databaseMajorVersion?: number;
}): string => `# Generated by Rehearsal for a disposable, local-only runtime.
# Review project-specific Auth or Storage additions before enabling them here.
project_id = ${JSON.stringify(projectId)}

[api]
enabled = true
port = ${ports.api}
schemas = ["public"]
extra_search_path = ["public", "extensions"]

[db]
port = ${ports.database}
shadow_port = ${ports.shadow}
major_version = ${databaseMajorVersion}

[db.pooler]
enabled = false
port = ${ports.pooler}

[db.migrations]
enabled = true
schema_paths = []

[db.seed]
enabled = false
sql_paths = []

[studio]
enabled = true
port = ${ports.studio}
api_url = "http://127.0.0.1"

[local_smtp]
enabled = false
port = ${ports.smtp}

[auth]
enabled = true
site_url = ${JSON.stringify(applicationUrl)}
enable_signup = false

[storage]
enabled = true

[realtime]
enabled = false

[edge_runtime]
enabled = false

[analytics]
enabled = false
`;

export const appendRehearsalGitignoreEntries = (
  source: string | null,
): string => {
  const original = source ?? "";
  const lines = new Set(
    original
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const entries = [".rehearsal/", ".env.rehearsal-service.local"];
  const missing = entries.filter(
    (entry) =>
      !lines.has(entry) &&
      !lines.has(`/${entry}`) &&
      !lines.has(entry.replace(/\/$/u, "")),
  );
  if (missing.length === 0) return original;
  const prefix =
    original && !original.endsWith("\n") ? `${original}\n` : original;
  const separator = prefix && !prefix.endsWith("\n\n") ? "\n" : "";
  return `${prefix}${separator}# Rehearsal local artifacts\n${missing.join("\n")}\n`;
};

const findExistingConfigPath = async ({
  projectRoot,
  configPath,
}: {
  projectRoot: string;
  configPath?: string;
}): Promise<string | null> => {
  try {
    return await findRehearsalConfigPath({
      projectRoot,
      ...(configPath === undefined ? {} : { configPath }),
    });
  } catch (error) {
    if (
      (error instanceof Error ? error.message : String(error)).startsWith(
        "No Rehearsal configuration",
      )
    ) {
      return null;
    }
    throw error;
  }
};

const deriveSupabasePorts = (runtimePorts: {
  api?: number;
  database: number;
  studio?: number;
}): SupabasePorts => {
  if (runtimePorts.api === undefined || runtimePorts.studio === undefined) {
    throw new Error("The Supabase runtime requires API and Studio ports.");
  }
  return {
    shadow: runtimePorts.database - 2,
    api: runtimePorts.api,
    database: runtimePorts.database,
    studio: runtimePorts.studio,
    smtp: runtimePorts.database + 2,
    pooler: runtimePorts.database + 7,
  };
};

const applyGitignoreChange = async (file: SetupFile): Promise<void> => {
  if (file.action === "unchanged") return;
  if (file.action === "create") {
    if (file.content === null) {
      throw new Error(`Rehearsal setup content is missing for ${file.path}.`);
    }
    await writeFile(file.absolutePath, file.content, {
      flag: "wx",
      mode: file.mode,
    });
    return;
  }

  const lockPath = `${file.absolutePath}.rehearsal.lock`;
  let lock: FileHandle | undefined;
  let temporaryPath: string | null | undefined;
  try {
    lock = await open(lockPath, "wx", 0o600);
    const current = await readOptionalFile(file.absolutePath);
    if (current !== file.originalContent) {
      throw new Error(
        ".gitignore changed after the setup preview; rerun rehearsal setup before writing.",
      );
    }
    temporaryPath = join(
      dirname(file.absolutePath),
      `.${basename(file.absolutePath)}.rehearsal-${process.pid}-${randomUUID()}.tmp`,
    );
    if (file.content === null) {
      throw new Error(`Rehearsal setup content is missing for ${file.path}.`);
    }
    await writeFile(temporaryPath, file.content, {
      flag: "wx",
      mode: file.mode,
    });
    await rename(temporaryPath, file.absolutePath);
    temporaryPath = null;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST") && !lock) {
      throw new Error(
        "Another Rehearsal process is updating .gitignore; rerun setup after it finishes.",
      );
    }
    throw error;
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true });
    if (lock) {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
};

const assertCreateTargetAvailable = async (file: SetupFile): Promise<void> => {
  if (file.action === "create" && (await pathExists(file.absolutePath))) {
    throw new Error(
      `Rehearsal setup will not overwrite the existing file at ${file.path}.`,
    );
  }
};

export const planRehearsalSetup = async ({
  projectRoot = process.cwd(),
  configPath,
  isPortAvailable,
  target,
}: PlanRehearsalSetupOptions = {}): Promise<RehearsalSetupPlan> => {
  const root = resolve(projectRoot);
  const detected = await inspectDetectedProject({ projectRoot: root });
  const existingConfigPath = await findExistingConfigPath({
    projectRoot: root,
    ...(configPath === undefined ? {} : { configPath }),
  });
  const existing = existingConfigPath
    ? await loadRehearsalConfig({
        projectRoot: root,
        ...(configPath === undefined ? {} : { configPath }),
      })
    : null;
  const requestedTarget = resolveRuntimeTarget(
    target ?? existing?.config.runtime.target ?? "supabase",
  ).id;
  const runtimeTarget = existing?.config.runtime.target ?? requestedTarget;
  if (existing && target && runtimeTarget !== requestedTarget) {
    throw new Error(
      `The existing Rehearsal configuration targets ${runtimeTarget}; setup will not replace it with ${requestedTarget}.`,
    );
  }
  const ports = existing
    ? runtimeTarget === "supabase"
      ? deriveSupabasePorts(existing.config.runtime.ports)
      : { database: existing.config.runtime.ports.database }
    : await findAvailableRehearsalPorts({
        ...(isPortAvailable ? { isAvailable: isPortAvailable } : {}),
      });
  const applicationUrl =
    existing?.config.runtime.applicationUrl ?? "http://localhost:5175";
  const projectId =
    existing?.config.runtime.projectId ?? `${detected.projectName}-rehearsal`;
  const sourceSupabaseConfig =
    runtimeTarget === "supabase"
      ? await readOptionalFile(join(root, "supabase/config.toml"))
      : null;
  const originalGitignore = await readOptionalFile(join(root, GITIGNORE_PATH));
  const nextGitignore = appendRehearsalGitignoreEntries(originalGitignore);
  const rehearsalConfigPath = existing?.paths.rehearsalConfig;
  const localSupabasePath = rehearsalConfigPath
    ? relative(root, rehearsalConfigPath)
    : LOCAL_SUPABASE_CONFIG_PATH;
  const localSupabaseExists = rehearsalConfigPath
    ? await pathExists(rehearsalConfigPath)
    : false;
  const supabasePorts =
    runtimeTarget === "supabase" ? deriveSupabasePorts(ports) : null;
  const localRuntimeFiles: SetupFile[] =
    runtimeTarget === "supabase"
      ? [
          {
            path: localSupabasePath,
            absolutePath:
              rehearsalConfigPath ?? join(root, LOCAL_SUPABASE_CONFIG_PATH),
            action: localSupabaseExists ? "unchanged" : "create",
            mode: 0o600,
            content: localSupabaseExists
              ? null
              : renderSafeLocalSupabaseConfig({
                  projectId,
                  applicationUrl,
                  ports: supabasePorts!,
                  databaseMajorVersion:
                    databaseMajorVersionFrom(sourceSupabaseConfig),
                }),
          },
        ]
      : [];
  const files: SetupFile[] = [
    {
      path: existingConfigPath
        ? relative(root, existingConfigPath)
        : CONFIG_PATH,
      absolutePath: existingConfigPath ?? join(root, CONFIG_PATH),
      action: existingConfigPath ? "unchanged" : "create",
      mode: 0o600,
      content: existingConfigPath
        ? null
        : runtimeTarget === "supabase"
          ? renderDetectedConfig(detected, {
              applicationUrl,
              ports: supabasePorts!,
            })
          : renderDetectedPostgresqlConfig(detected, {
              applicationUrl,
              databasePort: ports.database,
            }),
    },
    ...localRuntimeFiles,
    {
      path: GITIGNORE_PATH,
      absolutePath: join(root, GITIGNORE_PATH),
      action:
        nextGitignore === (originalGitignore ?? "")
          ? "unchanged"
          : originalGitignore === null
            ? "create"
            : "update",
      mode: 0o644,
      originalContent: originalGitignore,
      content: nextGitignore,
    },
  ];
  return {
    projectRoot: root,
    configurationPath: existingConfigPath
      ? relative(root, existingConfigPath)
      : CONFIG_PATH,
    project: detected.projectName,
    projectId,
    target: runtimeTarget,
    applicationUrl,
    detected,
    ports: runtimeTarget === "supabase" ? ports : { database: ports.database },
    requiresAvailablePorts: files.some(
      (file) =>
        file.action === "create" &&
        [CONFIG_PATH, localSupabasePath].includes(file.path),
    ),
    isPortAvailable: isPortAvailable ?? isRehearsalPortAvailable,
    files,
    safety: [
      "hosted access remains disabled",
      runtimeTarget === "supabase"
        ? "the Supabase runtime binds to dedicated local ports"
        : "PostgreSQL binds only to a dedicated loopback port",
      ...(runtimeTarget === "supabase"
        ? [
            "external identity providers, realtime, edge functions, and analytics start disabled",
          ]
        : [
            "the runtime uses an already-installed official PostgreSQL image and never pulls implicitly",
          ]),
      "configuration files are never overwritten and .gitignore updates are concurrency-checked",
    ],
  };
};

export const applyRehearsalSetup = async (plan: RehearsalSetupPlan) => {
  assertSupportedRehearsalNodeRuntime();
  const unavailablePorts = plan.requiresAvailablePorts
    ? (
        await Promise.all(
          Object.values(plan.ports).map(async (port) => ({
            port,
            available: await plan.isPortAvailable(port),
          })),
        )
      ).filter(({ available }) => !available)
    : [];
  if (unavailablePorts.length) {
    throw new Error(
      `Rehearsal setup ports became occupied after the preview (${unavailablePorts.map(({ port }) => port).join(", ")}); rerun setup to choose another local port block.`,
    );
  }
  for (const file of plan.files) await assertCreateTargetAvailable(file);
  const gitignore = plan.files.find((file) => file.path === GITIGNORE_PATH);
  if (gitignore) await applyGitignoreChange(gitignore);
  for (const file of plan.files.filter(
    (entry) => entry.action !== "unchanged" && entry.path !== GITIGNORE_PATH,
  )) {
    await mkdir(dirname(file.absolutePath), { recursive: true, mode: 0o700 });
    if (file.content === null) {
      throw new Error(`Rehearsal setup content is missing for ${file.path}.`);
    }
    await writeFile(file.absolutePath, file.content, {
      flag: file.action === "create" ? "wx" : "w",
      mode: file.mode,
    });
  }
  return {
    projectRoot: plan.projectRoot,
    files: plan.files.map((file) => ({
      path: relative(plan.projectRoot, file.absolutePath),
      action: file.action,
    })),
  };
};

export const summarizeRehearsalSetup = (
  plan: RehearsalSetupPlan,
  { mode }: { mode: "preview" | "written" },
): {
  mode: "preview" | "written";
  configurationPath: string;
  configurationAction: "create" | "update" | "unchanged";
  rootConfigGenerationSkipped: boolean;
  project: string;
  projectId: string;
  target: "supabase" | "postgresql";
  applicationUrl: string;
  detected: RehearsalSetupPlan["detected"];
  ports: Readonly<Record<string, number>> & { readonly database: number };
  files: readonly { path: string; action: "create" | "update" | "unchanged" }[];
  safety: readonly string[];
  nextAction: string;
} => ({
  mode,
  configurationPath: plan.configurationPath,
  configurationAction:
    plan.files.find((file) => file.path === plan.configurationPath)?.action ??
    "unchanged",
  rootConfigGenerationSkipped: plan.configurationPath !== CONFIG_PATH,
  project: plan.project,
  projectId: plan.projectId,
  target: plan.target,
  applicationUrl: plan.applicationUrl,
  detected: plan.detected,
  ports:
    plan.target === "supabase"
      ? {
          api: plan.ports.api!,
          database: plan.ports.database,
          studio: plan.ports.studio!,
        }
      : { database: plan.ports.database },
  files: plan.files.map((file) => ({ path: file.path, action: file.action })),
  safety: plan.safety,
  nextAction:
    mode === "written"
      ? `Review ${plan.configurationPath}, including its commands and sanitization policy path, then run rehearsal doctor.`
      : "Review this plan, then rerun rehearsal setup --write to create it.",
});
