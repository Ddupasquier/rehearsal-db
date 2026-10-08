/** Remove only Rehearsal's generated TypeScript output before a clean build. */

import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const outputRoot = resolve(
  fileURLToPath(new URL("../../dist", import.meta.url)),
);

if (dirname(outputRoot) !== repositoryRoot || basename(outputRoot) !== "dist") {
  throw new Error("Refusing to clean an unexpected TypeScript output path.");
}

await rm(outputRoot, { recursive: true, force: true });
