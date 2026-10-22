/** Precreate private worker roots before any parallel test starts. */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

export default async function setup(project) {
  const root = await realpath(project.config.root);
  const reports = join(root, "test-results");
  await mkdir(reports, { recursive: true });
  if ((await realpath(reports)) !== reports)
    throw new Error("Unit scratch must stay inside the canonical checkout.");
  const count = project.config.maxWorkers;
  if (!Number.isSafeInteger(count) || count < 1 || count > 256)
    throw new Error("Unit scratch requires the resolved bounded worker count.");
  const directory = await mkdtemp(join(reports, "unit-scratch-"));
  const identity = await lstat(directory, { bigint: true });
  const workers = Array.from({ length: count }, (_, index) =>
    join(directory, `worker-${index + 1}`),
  );
  for (const worker of workers) await mkdir(worker, { mode: 0o700 });
  project.provide("rehearsalUnitTemporaryRoots", workers);
  return async () => {
    const current = await lstat(directory, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new Error("Owned unit scratch identity changed; cleanup refused.");
    let entries = 0;
    const writable = async (path, depth = 0) => {
      if (++entries > 100000 || depth > 256)
        throw new Error("Owned unit scratch cleanup exceeded its bound.");
      const detail = await lstat(path);
      if (detail.isSymbolicLink()) return; // Never follow a fixture's escape link.
      if (detail.isDirectory()) {
        await chmod(path, 0o700);
        for (const name of await readdir(path))
          await writable(join(path, name), depth + 1);
      } else if (detail.isFile()) await chmod(path, 0o600);
      else throw new Error("Owned unit scratch contains an unsupported entry.");
    };
    await writable(directory);
    await rm(directory, { recursive: true, force: true });
  };
}
