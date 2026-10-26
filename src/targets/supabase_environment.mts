/**
 * Purpose: Start and inspect local-only Supabase workdirs without inheriting hosted
 * credentials. Do not run directly; this module is reusable script infrastructure.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createCleanProcessEnvironment,
  type ProcessEnvironment,
} from "../shared/process_environment.mjs";
import { throwIfOperationCancelled } from "../shared/cancellation.mjs";
import { assertContainerCapacityForRuntime } from "../runtime/resource_inventory.mjs";
import {
  writeContainerEngineStartReceipt,
  CONTAINER_ENGINE_RECEIPT_FILENAME,
  assertDefaultColimaCanBeStarted,
  type ContainerEngineReceiptInput,
} from "../runtime/container_engine_ownership.mjs";
import {
  bindRuntimeDockerEnvironment,
  runtimeDockerEnvironment,
  runtimeDockerContext,
} from "../runtime/local_docker_context.mjs";
import { assertOwnedSupabaseResourceInspection } from "./docker_resource_ownership.mjs";
import { captureRuntimeStartupOwnership } from "../runtime/runtime_startup_ownership.mjs";
import { summarizeSupabaseStartupFailure } from "./supabase_start_failure.mjs";

type ContainerRuntimePolicy = Readonly<{
  autoStartColima: boolean;
  diskWarningPercent: number;
  minimumFreeBytes: number;
}>;

const APPLICATION_PROFILE_EXCLUDES = Object.freeze([
  "edge-runtime",
  "logflare",
  "vector",
  "realtime",
  "studio",
  "imgproxy",
]);

export const supabaseExcludedServicesForProfile = (
  profile: "application" | "full",
): readonly string[] =>
  profile === "application" ? APPLICATION_PROFILE_EXCLUDES : Object.freeze([]);

export interface LocalSupabaseEnvironment {
  readonly apiUrl: string;
  readonly databaseUrl: string;
  readonly publishableKey: string;
  readonly serviceRoleKey: string;
  readonly studioUrl: string | undefined;
  readonly databaseHost: string;
  readonly databasePort: string;
  readonly databaseName: string;
  readonly databaseUser: string;
  readonly databasePassword: string;
}

interface LocalCommandOptions {
  readonly capture?: boolean;
  readonly cwd?: string | undefined;
  readonly input?: string | Uint8Array;
  readonly environment?: ProcessEnvironment;
  readonly maxBuffer?: number;
}

interface SupabaseCommandOptions {
  readonly cwd?: string | undefined;
  readonly workdir?: string | undefined;
  readonly environment?: ProcessEnvironment;
}

export const parseSupabaseStatusEnvironment = (
  output: string,
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    let value = rawValue.trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") continue;
      value = parsed;
    }
    values[key] = value;
  }
  return values;
};

export const parseLocalSupabaseEnvironment = (
  output: string,
): LocalSupabaseEnvironment => {
  const values = parseSupabaseStatusEnvironment(output);
  const required = (label: string, value: string | undefined): string => {
    if (!value) throw new Error(`Local Supabase status omitted its ${label}.`);
    return value;
  };
  const apiUrl = required("API URL", values.API_URL);
  const databaseUrl = required("database URL", values.DB_URL);
  const publishableKey = required(
    "publishable key",
    values.PUBLISHABLE_KEY ?? values.ANON_KEY,
  );
  const serviceRoleKey = required(
    "service-role key",
    values.SERVICE_ROLE_KEY ?? values.SECRET_KEY,
  );
  const api = new URL(apiUrl);
  const database = new URL(databaseUrl);
  const loopbackHosts = ["127.0.0.1", "::1", "localhost"];
  if (
    !loopbackHosts.includes(api.hostname) ||
    !loopbackHosts.includes(database.hostname) ||
    !["postgres:", "postgresql:"].includes(database.protocol)
  ) {
    throw new Error("Refusing to use a non-local Supabase status target.");
  }
  const databaseName = decodeURIComponent(
    database.pathname.replace(/^\//u, ""),
  );
  if (
    !database.port ||
    !databaseName ||
    !database.username ||
    !database.password
  ) {
    throw new Error(
      "Local Supabase status returned an incomplete database URL.",
    );
  }
  return {
    apiUrl,
    databaseUrl,
    publishableKey,
    serviceRoleKey,
    studioUrl: values.STUDIO_URL,
    databaseHost: database.hostname,
    databasePort: database.port,
    databaseName,
    databaseUser: decodeURIComponent(database.username),
    databasePassword: decodeURIComponent(database.password),
  };
};

export const runLocalCommand = (
  command: string,
  args: readonly string[],
  {
    capture = false,
    cwd = process.cwd(),
    input,
    environment = {},
    maxBuffer = 16 * 1024 * 1024,
  }: LocalCommandOptions = {},
): string => {
  if (
    (command === "supabase" && ["start", "stop"].includes(args[0] ?? "")) ||
    (command === "docker" && args[0] === "container" && args[1] === "rm")
  )
    captureRuntimeStartupOwnership();
  const shouldPipe = capture || input !== undefined;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment({
      overrides: {
        ...environment,
        ...(["docker", "supabase"].includes(command)
          ? runtimeDockerEnvironment()
          : {}),
      },
    }),
    input,
    maxBuffer,
    stdio: shouldPipe ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  throwIfOperationCancelled();
  if (result.error && !(command === "supabase" && args[0] === "start"))
    throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (command === "supabase" && args[0] === "start")
      throw new Error(
        summarizeSupabaseStartupFailure({
          output: detail,
          status: result.status,
          ...(result.error &&
          "code" in result.error &&
          typeof result.error.code === "string"
            ? { processErrorCode: result.error.code }
            : {}),
        }),
      );
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`,
    );
  }
  return result.stdout ?? "";
};

export const localCommandSucceeds = (
  command: string,
  args: readonly string[],
  {
    cwd = process.cwd(),
    environment = {},
  }: Pick<LocalCommandOptions, "cwd" | "environment"> = {},
): boolean =>
  spawnSync(command, args, {
    cwd,
    env: createCleanProcessEnvironment({
      overrides: {
        ...environment,
        ...(["docker", "supabase"].includes(command)
          ? runtimeDockerEnvironment()
          : {}),
      },
    }),
    stdio: "ignore",
  }).status === 0;

export const ensureLocalContainerRuntime = ({
  cwd = process.cwd(),
  autoStartColima = false,
  ownershipReceipt,
}: {
  cwd?: string | undefined;
  autoStartColima?: boolean;
  ownershipReceipt?: ContainerEngineReceiptInput;
} = {}): { readonly startedColima: boolean } => {
  bindRuntimeDockerEnvironment({
    cwd,
    ...(process.env.REHEARSAL_DOCKER_DAEMON_ID
      ? { expectedDaemonId: process.env.REHEARSAL_DOCKER_DAEMON_ID }
      : {}),
    ...(process.env.REHEARSAL_DOCKER_CONTEXT
      ? { context: process.env.REHEARSAL_DOCKER_CONTEXT }
      : {}),
    ...(process.env.REHEARSAL_DOCKER_IDENTITY
      ? { expectedIdentity: process.env.REHEARSAL_DOCKER_IDENTITY }
      : {}),
  });
  if (localCommandSucceeds("docker", ["info"], { cwd }))
    return { startedColima: false };
  let startedColima = false;
  if (autoStartColima && localCommandSucceeds("colima", ["version"], { cwd })) {
    if (runtimeDockerContext() !== "colima")
      throw new Error(
        "Colima auto-start requires the local colima Docker context. Select it explicitly before retrying; Rehearsal will not switch or start another engine.",
      );
    assertDefaultColimaCanBeStarted({ projectRoot: cwd });
    runLocalCommand("colima", ["start"], { cwd });
    startedColima = true;
    bindRuntimeDockerEnvironment({ cwd });
  }
  if (!localCommandSucceeds("docker", ["info"], { cwd })) {
    throw new Error(
      autoStartColima
        ? "A local Docker-compatible runtime is required. Install Docker or Colima, then rerun the command."
        : "A local Docker-compatible runtime is stopped or unavailable. Start Docker or Colima explicitly, or opt in with containerRuntime.autoStartColima: true.",
    );
  }
  if (startedColima && ownershipReceipt) {
    writeContainerEngineStartReceipt({ input: ownershipReceipt });
  }
  if (startedColima) {
    console.log(
      ownershipReceipt
        ? "Started Colima because containerRuntime.autoStartColima is enabled and recorded an owner-only startup receipt."
        : "Started Colima because containerRuntime.autoStartColima is enabled. No shutdown receipt was requested, so Rehearsal will preserve it.",
    );
  }
  return { startedColima };
};

export const ensureConfiguredContainerRuntime = ({
  cwd,
  artifactDirectory,
  projectId,
  policy,
}: {
  readonly cwd: string;
  readonly artifactDirectory: string;
  readonly projectId: string;
  readonly policy: ContainerRuntimePolicy;
}): void => {
  ensureLocalContainerRuntime({
    cwd,
    autoStartColima: policy.autoStartColima,
    ownershipReceipt: {
      path: join(artifactDirectory, CONTAINER_ENGINE_RECEIPT_FILENAME),
      projectRoot: cwd,
      projectId,
      operationId:
        process.env.REHEARSAL_OPERATION_ID ??
        `manager-${process.pid}-${Date.now()}`,
    },
  });
  const capacity = assertContainerCapacityForRuntime({
    cwd,
    warningPercent: policy.diskWarningPercent,
    minimumFreeBytes: policy.minimumFreeBytes,
  });
  if (capacity.warning) console.warn(capacity.warning);
};

export const preventOwnedSupabaseAutoRestart = ({
  cwd = process.cwd(),
  projectId,
}: {
  cwd?: string | undefined;
  projectId: string;
}): readonly string[] => {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(projectId)) {
    throw new Error(
      "Refusing to change container restart policies without an exact safe Supabase project id.",
    );
  }
  const label = `com.supabase.cli.project=${projectId}`;
  const containers = runLocalCommand(
    "docker",
    ["ps", "--all", "--filter", `label=${label}`, "--format", "{{.ID}}"],
    { capture: true, cwd },
  )
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (containers.length) {
    assertOwnedSupabaseResourceInspection({
      output: runLocalCommand(
        "docker",
        [
          "container",
          "inspect",
          "--format",
          "{{json .Config.Labels}}",
          ...containers,
        ],
        { capture: true, cwd },
      ),
      count: containers.length,
      projectId,
    });
    runLocalCommand("docker", ["update", "--restart=no", ...containers], {
      capture: true,
      cwd,
    });
  }
  return Object.freeze(containers);
};

const withWorkdir = (
  args: readonly string[],
  workdir: string | undefined,
): string[] => (workdir ? [...args, "--workdir", workdir] : [...args]);

export const readLocalSupabaseEnvironment = ({
  cwd,
  workdir,
  environment = {},
}: SupabaseCommandOptions = {}): LocalSupabaseEnvironment => {
  const output = runLocalCommand(
    "supabase",
    withWorkdir(["status", "-o", "env"], workdir),
    { capture: true, cwd, environment },
  );
  return parseLocalSupabaseEnvironment(output);
};

export const startLocalSupabase = ({
  cwd,
  workdir,
  exclude = [],
  serviceProfile,
  environment = {},
  applyMigrations = true,
  autoStartColima = false,
  diskWarningPercent = 80,
  minimumFreeBytes = 8 * 1024 * 1024 * 1024,
  containerRuntime,
  ownershipReceipt,
  artifactDirectory,
  projectId,
}: SupabaseCommandOptions & {
  exclude?: readonly string[];
  serviceProfile?: "application" | "full";
  applyMigrations?: boolean;
  autoStartColima?: boolean;
  diskWarningPercent?: number;
  minimumFreeBytes?: number;
  containerRuntime?: {
    readonly autoStartColima: boolean;
    readonly diskWarningPercent: number;
    readonly minimumFreeBytes: number;
  };
  ownershipReceipt?: ContainerEngineReceiptInput;
  artifactDirectory?: string;
  projectId?: string | undefined;
} = {}): LocalSupabaseEnvironment => {
  const runtimePolicy = containerRuntime ?? {
    autoStartColima,
    diskWarningPercent,
    minimumFreeBytes,
  };
  const receipt =
    ownershipReceipt ??
    (artifactDirectory && projectId
      ? {
          path: join(artifactDirectory, CONTAINER_ENGINE_RECEIPT_FILENAME),
          projectRoot: cwd ?? process.cwd(),
          projectId,
          operationId:
            process.env.REHEARSAL_OPERATION_ID ??
            `manager-${process.pid}-${Date.now()}`,
        }
      : undefined);
  ensureLocalContainerRuntime({
    cwd,
    autoStartColima: runtimePolicy.autoStartColima,
    ...(receipt === undefined ? {} : { ownershipReceipt: receipt }),
  });
  const capacity = assertContainerCapacityForRuntime({
    ...(cwd === undefined ? {} : { cwd }),
    warningPercent: runtimePolicy.diskWarningPercent,
    minimumFreeBytes: runtimePolicy.minimumFreeBytes,
  });
  if (capacity.warning) console.warn(capacity.warning);
  const selectedExcludes =
    serviceProfile === undefined
      ? exclude
      : supabaseExcludedServicesForProfile(serviceProfile);
  const startArguments = withWorkdir(
    [
      "start",
      ...(selectedExcludes.length
        ? ["--exclude", selectedExcludes.join(",")]
        : []),
    ],
    workdir,
  );
  runLocalCommand("supabase", startArguments, {
    capture: true,
    cwd,
    environment,
  });
  if (projectId) preventOwnedSupabaseAutoRestart({ cwd, projectId });
  if (applyMigrations) {
    runLocalCommand(
      "supabase",
      withWorkdir(["migration", "up", "--local"], workdir),
      { capture: true, cwd, environment },
    );
  }
  return readLocalSupabaseEnvironment({ cwd, workdir, environment });
};

export const stopLocalSupabase = ({
  cwd,
  workdir,
  environment = {},
  projectId,
}: SupabaseCommandOptions & { readonly projectId: string }): void => {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(projectId) || !workdir)
    throw new Error(
      "Supabase stop requires its exact reviewed project identity and runtime workdir.",
    );
  bindRuntimeDockerEnvironment(cwd === undefined ? {} : { cwd });
  if (!localCommandSucceeds("docker", ["info"], { cwd })) return;
  const containers = runLocalCommand(
    "docker",
    [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `label=com.supabase.cli.project=${projectId}`,
      "--format",
      "{{.ID}}",
    ],
    { capture: true, cwd },
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (!containers.length) return;
  if (
    containers.length > 1000 ||
    new Set(containers).size !== containers.length ||
    containers.some((id) => !/^[a-f0-9]{64}$/u.test(id))
  )
    throw new Error(
      "Supabase stop container identity is unavailable; no target was stopped.",
    );
  assertOwnedSupabaseResourceInspection({
    output: runLocalCommand(
      "docker",
      [
        "container",
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        ...containers,
      ],
      { capture: true, cwd },
    ),
    count: containers.length,
    projectId,
  });
  const configurationPath = join(
    resolve(cwd ?? process.cwd(), workdir),
    "supabase/config.toml",
  );
  const details = lstatSync(configurationPath);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > 1024 * 1024
  )
    throw new Error(
      "Supabase stop runtime configuration is unsafe; no target was stopped.",
    );
  const ids = [
    ...readFileSync(configurationPath, "utf8").matchAll(
      /^\s*project_id\s*=\s*(["'])([a-z0-9][a-z0-9-]{1,62})\1\s*(?:#.*)?$/gmu,
    ),
  ].map((match) => match[2]);
  if (ids.length !== 1 || ids[0] !== projectId)
    throw new Error(
      "Supabase stop workdir identity differs from its reviewed target; no target was stopped.",
    );
  runLocalCommand("supabase", withWorkdir(["stop"], workdir), {
    cwd,
    environment,
  });
};

export const removeLocalSupabaseProjectResources = ({
  cwd = process.cwd(),
  projectId,
}: {
  cwd?: string;
  projectId?: string;
} = {}): void => {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(projectId ?? "")) {
    throw new Error(
      "Refusing to remove local Supabase resources without an exact safe project id.",
    );
  }
  const label = `com.supabase.cli.project=${projectId}`;
  const list = (resource: "volume" | "network", format: string): string[] =>
    runLocalCommand(
      "docker",
      [resource, "ls", "--filter", `label=${label}`, "--format", format],
      { capture: true, cwd },
    )
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  const containers = runLocalCommand(
    "docker",
    ["ps", "--all", "--filter", `label=${label}`, "--format", "{{.ID}}"],
    { capture: true, cwd },
  )
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const volumes = list("volume", "{{.Name}}");
  const networks = list("network", "{{.ID}}");
  for (const [kind, names] of [
    ["container", containers],
    ["volume", volumes],
    ["network", networks],
  ] as const) {
    if (names.length)
      assertOwnedSupabaseResourceInspection({
        output: runLocalCommand(
          "docker",
          [
            kind,
            "inspect",
            "--format",
            kind === "container"
              ? "{{json .Config.Labels}}"
              : "{{json .Labels}}",
            ...names,
          ],
          { capture: true, cwd },
        ),
        count: names.length,
        projectId: projectId!,
      });
  }
  if (containers.length) {
    runLocalCommand("docker", ["rm", "--force", ...containers], {
      capture: true,
      cwd,
    });
  }
  if (volumes.length) {
    runLocalCommand("docker", ["volume", "rm", "--force", ...volumes], {
      capture: true,
      cwd,
    });
  }
  if (networks.length) {
    runLocalCommand("docker", ["network", "rm", ...networks], {
      capture: true,
      cwd,
    });
  }
};
