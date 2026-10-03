/**
 * Purpose: Start and inspect local-only Supabase workdirs without inheriting hosted
 * credentials. Do not run directly; this module is reusable script infrastructure.
 */

import { spawnSync } from "node:child_process";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";

export const parseSupabaseStatusEnvironment = (output) => {
  const values = {};
  for (const line of output.split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    values[match[1]] = value;
  }
  return values;
};

export const parseLocalSupabaseEnvironment = (output) => {
  const values = parseSupabaseStatusEnvironment(output);
  const localEnvironment = {
    apiUrl: values.API_URL,
    databaseUrl: values.DB_URL,
    publishableKey: values.PUBLISHABLE_KEY ?? values.ANON_KEY,
    serviceRoleKey: values.SERVICE_ROLE_KEY ?? values.SECRET_KEY,
    studioUrl: values.STUDIO_URL,
  };
  for (const [label, value] of [
    ["API URL", localEnvironment.apiUrl],
    ["database URL", localEnvironment.databaseUrl],
    ["publishable key", localEnvironment.publishableKey],
    ["service-role key", localEnvironment.serviceRoleKey],
  ]) {
    if (!value) throw new Error(`Local Supabase status omitted its ${label}.`);
  }
  const api = new URL(localEnvironment.apiUrl);
  const database = new URL(localEnvironment.databaseUrl);
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
    ...localEnvironment,
    databaseHost: database.hostname,
    databasePort: database.port,
    databaseName,
    databaseUser: decodeURIComponent(database.username),
    databasePassword: decodeURIComponent(database.password),
  };
};

export const runLocalCommand = (
  command,
  args,
  {
    capture = false,
    cwd = process.cwd(),
    input,
    environment = {},
    maxBuffer = 16 * 1024 * 1024,
  } = {},
) => {
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
  command,
  args,
  { cwd = process.cwd(), environment = {} } = {},
) =>
  spawnSync(command, args, {
    cwd,
    env: createCleanProcessEnvironment({ overrides: environment }),
    stdio: "ignore",
  }).status === 0;

export const ensureLocalContainerRuntime = ({
  cwd = process.cwd(),
  autoStartColima = true,
} = {}) => {
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

const withWorkdir = (args, workdir) =>
  workdir ? [...args, "--workdir", workdir] : args;

export const readLocalSupabaseEnvironment = ({
  cwd,
  workdir,
  environment = {},
} = {}) => {
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
} = {}) => {
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

export const stopLocalSupabase = ({ cwd, workdir, environment = {} } = {}) => {
  if (!localCommandSucceeds("docker", ["info"], { cwd })) return;
  runLocalCommand("supabase", withWorkdir(["stop"], workdir), {
    cwd,
    environment,
  });
};

export const removeLocalSupabaseProjectResources = ({
  cwd = process.cwd(),
  projectId,
} = {}) => {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(projectId ?? "")) {
    throw new Error(
      "Refusing to remove local Supabase resources without an exact safe project id.",
    );
  }
  const label = `com.supabase.cli.project=${projectId}`;
  const list = (resource, format) =>
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
