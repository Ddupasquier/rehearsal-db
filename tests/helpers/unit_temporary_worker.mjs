/** Test-only environment; never change the production path-change guard. */
import { isAbsolute } from "node:path";
import { inject } from "vitest";

const roots = inject("rehearsalUnitTemporaryRoots");
const id = Number(process.env.VITEST_POOL_ID);
if (
  !Array.isArray(roots) ||
  !Number.isSafeInteger(id) ||
  id < 1 ||
  id > roots.length ||
  typeof roots[id - 1] !== "string" ||
  !isAbsolute(roots[id - 1])
)
  throw new Error("The test worker has no owned temporary directory.");
for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = roots[id - 1];
