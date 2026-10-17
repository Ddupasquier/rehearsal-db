/** Shared process boundary for installed-consumer verification scenarios. */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const spawnScenarioCommand = (
  command,
  args,
  {
    cwd,
    environment = {},
    input,
    inheritEnvironment = false,
    timeout,
    maxBuffer = MAX_OUTPUT_BYTES,
  } = {},
) => {
  if (
    (timeout !== undefined &&
      (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)) ||
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer < 1 ||
    maxBuffer > MAX_OUTPUT_BYTES
  ) {
    throw new Error(
      "Scenario process bounds must be positive bounded integers.",
    );
  }
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: inheritEnvironment
      ? { ...process.env, ...environment }
      : createCleanProcessEnvironment({ overrides: environment }),
    input,
    maxBuffer,
    ...(timeout === undefined ? {} : { timeout, killSignal: "SIGKILL" }),
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
};

export const commandFailureText = (result, fallback) =>
  result.stderr ||
  result.stdout ||
  result.error?.message ||
  (result.signal
    ? `${fallback} was interrupted by ${result.signal}.`
    : `${fallback} exited ${result.status ?? "without a status"}.`);

export const runScenarioCommand = (command, args, options = {}) => {
  const result = spawnScenarioCommand(command, args, options);
  if (result.error || result.status !== 0) {
    throw new Error(
      commandFailureText(result, `${command} ${args.join(" ")}`),
      {
        cause: result.error,
      },
    );
  }
  return result.stdout;
};

export const executeInstalledCli = ({ cwd, args, environment = {} }) =>
  spawnScenarioCommand(join(cwd, "node_modules/.bin/rehearsal"), args, {
    cwd,
    environment,
  });

export const executeInstalledCliOrThrow = ({
  cwd,
  args,
  environment = {},
  label = `rehearsal ${args.join(" ")}`,
}) => {
  const result = executeInstalledCli({ cwd, args, environment });
  if (result.error || result.status !== 0) {
    throw new Error(commandFailureText(result, label), { cause: result.error });
  }
  return result;
};
