import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publicCliFailureSummary } from "../../scripts/verification/scenarios/process.mjs";
export { publicCliFailureSummary };

const execute = promisify(execFile);
const maximumOutputBytes = 64 * 1024;
const diagnosticPhases = new Set([
  "setup-preview",
  "setup-first-write",
  "setup-repeat-write",
]);
/** Bounded test-only execution; callers keep their existing command and deadline. */
export const executePublicCli = async (file, args, options = {}) => {
  const { diagnosticPhase, ...childOptions } = options;
  if (diagnosticPhase !== undefined && !diagnosticPhases.has(diagnosticPhase)) {
    throw new Error("Unsupported public CLI diagnostic phase.");
  }
  try {
    return await execute(file, args, {
      ...childOptions,
      encoding: "utf8",
      maxBuffer: maximumOutputBytes,
    });
  } catch (error) {
    const summary = publicCliFailureSummary(error);
    if (diagnosticPhase !== undefined) summary.phase = diagnosticPhase;
    throw new Error(`Public CLI child failed: ${JSON.stringify(summary)}`);
  }
};
