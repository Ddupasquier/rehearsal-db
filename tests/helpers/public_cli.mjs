import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publicCliFailureSummary } from "../../scripts/verification/scenarios/process.mjs";
export { publicCliFailureSummary };

const execute = promisify(execFile);
const maximumOutputBytes = 64 * 1024;
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
