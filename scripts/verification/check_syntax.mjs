/** Check repository JavaScript with Node on every desktop host; no Unix tools. */
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const collect = async (directory) => {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules")
      paths.push(...(await collect(path)));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) paths.push(path);
  }
  return paths.sort();
};

let count = 0;
for (const directory of ["scripts", "tests"]) {
  for (const path of await collect(join(root, directory))) {
    const result = spawnSync(process.execPath, ["--check", path], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      console.error(
        result.stderr ||
          result.error?.message ||
          `Syntax check failed: ${path}`,
      );
      process.exitCode = 1;
    }
    count += 1;
  }
}
console.log(`Checked syntax of ${count} JavaScript files.`);
