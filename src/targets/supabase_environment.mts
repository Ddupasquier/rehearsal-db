/**
 * Purpose: Start and inspect local-only Supabase workdirs without inheriting hosted
 * credentials. Do not run directly; this module is reusable script infrastructure.
 */

import { spawnSync } from "node:child_process";
import {
  createCleanProcessEnvironment,
  type ProcessEnvironment,
} from "../shared/process_environment.mjs";

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
  const shouldPipe = capture || input !== undefined;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment({ overrides: environment }),
    input,
    maxBuffer,
    stdio: shouldPipe ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
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
    env: createCleanProcessEnvironment({ overrides: environment }),
    stdio: "ignore",
  }).status === 0;

export const ensureLocalContainerRuntime = ({
  cwd = process.cwd(),
  autoStartColima = true,
}: {
  cwd?: string | undefined;
  autoStartColima?: boolean;
} = {}): void => {
  if (localCommandSucceeds("docker", ["info"], { cwd })) return;
  if (autoStartColima && localCommandSucceeds("colima", ["version"], { cwd })) {
    runLocalCommand("colima", ["start"], { cwd });
  }
  if (!localCommandSucceeds("docker", ["info"], { cwd })) {
    throw new Error(
      "A local Docker-compatible runtime is required. Install Docker or Colima, then rerun the command.",
    );
  }
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
  environment = {},
  applyMigrations = true,
  autoStartColima = true,
}: SupabaseCommandOptions & {
  exclude?: readonly string[];
  applyMigrations?: boolean;
  autoStartColima?: boolean;
} = {}): LocalSupabaseEnvironment => {
  ensureLocalContainerRuntime({ cwd, autoStartColima });
  const startArguments = withWorkdir(
    ["start", ...(exclude.length ? ["--exclude", exclude.join(",")] : [])],
    workdir,
  );
  runLocalCommand("supabase", startArguments, {
    capture: true,
    cwd,
    environment,
  });
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
}: SupabaseCommandOptions = {}): void => {
  if (!localCommandSucceeds("docker", ["info"], { cwd })) return;
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
  if (containers.length) {
    runLocalCommand("docker", ["rm", "--force", ...containers], {
      capture: true,
      cwd,
    });
  }
  const volumes = list("volume", "{{.Name}}");
  if (volumes.length) {
    runLocalCommand("docker", ["volume", "rm", "--force", ...volumes], {
      capture: true,
      cwd,
    });
  }
  const networks = list("network", "{{.ID}}");
  if (networks.length) {
    runLocalCommand("docker", ["network", "rm", ...networks], {
      capture: true,
      cwd,
    });
  }
};
