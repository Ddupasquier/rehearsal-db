/** Run one installed-consumer scenario from the shared release-gate catalog. */

import { spawnSync } from "node:child_process";
import {
  findVerificationScenario,
  verificationScenarios,
} from "./scenarios/catalog.mjs";

const [id, ...extra] = process.argv.slice(2);
if (id === "--help" || id === "-h" || !id) {
  console.log(`Usage: node scripts/verification/run_scenario.mjs <scenario>

Scenarios: ${verificationScenarios.map((scenario) => scenario.id).join(", ")}`);
  process.exit(id ? 0 : 1);
}
if (extra.length > 0) throw new Error("A scenario does not accept arguments.");

const scenario = findVerificationScenario(id);
if (!scenario) throw new Error(`Unknown verification scenario: ${id}`);

const result = spawnSync(process.execPath, [scenario.file], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
