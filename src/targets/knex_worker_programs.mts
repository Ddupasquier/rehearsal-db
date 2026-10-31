/** One authority for immutable trusted worker programs and their exact private copies. */
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { holdPathAncestry } from "../shared/held_path_ancestry.mjs";
import { KNEX_WORKER_PROTOCOL_SOURCE } from "../runtime/knex_worker_protocol.mjs";
import {
  KNEX_WORKER_BOOTSTRAP_SOURCE,
  KNEX_WORKER_CHILD_SOURCE,
} from "./knex_worker_bootstrap.mjs";
export const KNEX_WORKER_PROGRAMS = Object.freeze([
  ["bootstrap.mjs", KNEX_WORKER_BOOTSTRAP_SOURCE],
  ["child.mjs", KNEX_WORKER_CHILD_SOURCE],
  ["protocol.mjs", KNEX_WORKER_PROTOCOL_SOURCE],
] as const);
const fail = () =>
  new Error(
    "Private trusted Knex worker programs changed; execution or success was refused.",
  );
export const assertKnexWorkerPrograms = async (workspace: string) => {
  const root = join(workspace, "runner"),
    held = await holdPathAncestry(root);
  try {
    const names = new Set<string>();
    for await (const entry of await opendir(root)) {
      if (
        names.size >= 3 ||
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !KNEX_WORKER_PROGRAMS.some((p) => p[0] === entry.name)
      )
        throw fail();
      names.add(entry.name);
    }
    if (names.size !== 3) throw fail();
    for (const [name, text] of KNEX_WORKER_PROGRAMS) {
      const expected = Buffer.from(text),
        path = join(root, name),
        leaf = await lstat(path),
        fd = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      try {
        const before = await fd.stat();
        if (
          !before.isFile() ||
          before.size !== expected.length ||
          before.size > 65536 ||
          before.dev !== leaf.dev ||
          before.ino !== leaf.ino
        )
          throw fail();
        const bytes = Buffer.alloc(expected.length + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const r = await fd.read(bytes, offset, bytes.length - offset, offset);
          if (!r.bytesRead) break;
          offset += r.bytesRead;
        }
        const after = await fd.stat(),
          fresh = await lstat(path);
        if (
          offset !== expected.length ||
          !bytes.subarray(0, offset).equals(expected) ||
          [after, fresh].some(
            (s) =>
              !s.isFile() ||
              s.isSymbolicLink() ||
              s.dev !== before.dev ||
              s.ino !== before.ino ||
              s.size !== before.size ||
              s.mtimeMs !== before.mtimeMs ||
              s.ctimeMs !== before.ctimeMs,
          )
        )
          throw fail();
      } finally {
        await fd.close();
      }
    }
    await held.assertUnchanged();
  } finally {
    await held.close();
  }
};
