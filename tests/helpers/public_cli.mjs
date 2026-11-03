import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REHEARSAL_EXIT_CODES } from "../../dist/src/shared/diagnostics.mjs";

const execute = promisify(execFile);
const maximumOutputBytes = 64 * 1024;
const signals = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"]);
const spawnCodes = new Set([
  "ENOENT",
  "EACCES",
  "ENOBUFS",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);
const byteLength = (value) =>
  typeof value === "string" || Buffer.isBuffer(value)
    ? Buffer.byteLength(value)
    : 0;

/** Never retain a child Error: its message/argv/cause/output can contain secrets. */
export const publicCliFailureSummary = (error) => {
  const summary = {
    exitCode:
      Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255
        ? error.code
        : null,
    signal: signals.has(error?.signal) ? error.signal : null,
    spawnCode: spawnCodes.has(error?.code) ? error.code : null,
    killed: error?.killed === true,
    stdoutBytes: byteLength(error?.stdout),
    stderrBytes: byteLength(error?.stderr),
    category: null,
    code: null,
    reason: "unclassified",
  };
  if (
    typeof error?.stdout !== "string" ||
    summary.stdoutBytes > maximumOutputBytes
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

/** Bounded test-only execution; callers keep their existing command and deadline. */
export const executePublicCli = async (file, args, options = {}) => {
  try {
    return await execute(file, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: maximumOutputBytes,
    });
  } catch (error) {
    throw new Error(
      `Public CLI child failed: ${JSON.stringify(publicCliFailureSummary(error))}`,
    );
  }
};
