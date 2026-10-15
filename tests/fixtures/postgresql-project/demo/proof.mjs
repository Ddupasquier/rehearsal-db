/** Project-owned proof, exercising the application's HTTP and database path. */
import config from "../rehearsal.config.mjs";
import { assertDemoObservation } from "./contract.mjs";

const expectedRows = Number(process.argv[2]);
const phase = process.argv[3];
if (!["nullable", "required"].includes(phase)) {
  throw new Error("The synthetic application proof needs an explicit phase.");
}
const response = await fetch(config.runtime.applicationUrl, {
  signal: AbortSignal.timeout(8_000),
});
if (response.status !== 200) {
  throw new Error(
    "The synthetic PostgreSQL application did not respond successfully.",
  );
}
assertDemoObservation(await response.json(), {
  expectedRows,
  descriptionRequired: phase === "required",
});
console.log("Data-shaped PostgreSQL application proof passed.");
