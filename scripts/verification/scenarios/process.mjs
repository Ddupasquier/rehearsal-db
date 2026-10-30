/** Shared process boundary for installed-consumer verification scenarios. */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";
import { REHEARSAL_EXIT_CODES } from "../../../dist/src/shared/diagnostics.mjs";

const maximumDiagnosticOutputBytes = 64 * 1024;
const diagnosticSignals = new Set([
  "SIGINT",
  "SIGTERM",
  "SIGKILL",
  "SIGABRT",
  "SIGSEGV",
]);
const diagnosticSpawnCodes = new Set([
  "ENOENT",
  "EACCES",
  "ENOBUFS",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  "ETIMEDOUT",
]);
const diagnosticByteLength = (value) =>
  typeof value === "string" || Buffer.isBuffer(value)
    ? Buffer.byteLength(value)
    : 0;

/** Closed diagnostic projection; never retain child Error, argv, message or cause. */
export const publicCliFailureSummary = (error) => {
  const summary = {
    exitCode:
      Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255
        ? error.code
        : null,
    signal: diagnosticSignals.has(error?.signal) ? error.signal : null,
    spawnCode: diagnosticSpawnCodes.has(error?.code) ? error.code : null,
    killed: error?.killed === true,
    stdoutBytes: diagnosticByteLength(error?.stdout),
    stderrBytes: diagnosticByteLength(error?.stderr),
    category: null,
    code: null,
    reason: "unclassified",
  };
  if (
    typeof error?.stdout !== "string" ||
    summary.stdoutBytes > maximumDiagnosticOutputBytes
  )
    return summary;
  let result;
  try {
    result = JSON.parse(error.stdout);
  } catch {
    return summary;
  }
  const category = result?.error?.category;
  if (
    result?.schemaVersion !== 1 ||
    result?.status !== "error" ||
    typeof category !== "string" ||
    !Object.hasOwn(REHEARSAL_EXIT_CODES, category) ||
    category === "success"
  )
    return summary;
  summary.category = category;
  if (result.error.code === category.toUpperCase())
    summary.code = result.error.code;
  const message = result.error.message;
  if (
    typeof message === "string" &&
    /^Rehearsal setup ports became occupied after the preview \([0-9, ]{1,80}\); rerun setup to choose another local port block\.$/u.test(
      message,
    )
  )
    summary.reason = "setup_port_race";
  else if (
    message ===
    ".gitignore changed after the setup preview; rerun rehearsal setup before writing."
  )
    summary.reason = "setup_source_drift";
  return summary;
};

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
