/** Private ownership, independent of container-shell replacement; no passwords. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { holdPathAncestry } from "../shared/held_path_ancestry.mjs";
export type KnexSqlPhase =
  "worker" | "restore" | "verify" | "application" | "application_query";
export const isKnexSqlPhase = (value: unknown): value is KnexSqlPhase =>
  ["worker", "restore", "verify", "application", "application_query"].includes(
    value as string,
  );
const receiptName = (phase: KnexSqlPhase) =>
  phase === "worker" ? "knex-role.json" : `knex-${phase}-role.json`;
export interface KnexRoleReceipt {
  schemaVersion: 1;
  kind: "knex-restricted-role";
  projectId: string;
  role: string;
  roleOid: number;
  databaseOid: number;
  systemIdentifier: string;
}
const invalid = () =>
  new Error(
    "Private Knex role ownership is unverified; no existing role was adopted.",
  );
export const readKnexRoleReceipt = async (
  directory: string,
  phase: KnexSqlPhase = "worker",
): Promise<KnexRoleReceipt | null> => {
  if (!isKnexSqlPhase(phase)) throw invalid();
  const held = await holdPathAncestry(directory);
  try {
    const parent = await lstat(directory);
    if (
      !parent.isDirectory() ||
      (parent.mode & 0o077) !== 0 ||
      parent.uid !== process.getuid?.()
    )
      throw invalid();
    const path = join(directory, receiptName(phase));
    let leaf;
    try {
      leaf = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw invalid();
    }
    const fd = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await fd.stat();
      if (
        !before.isFile() ||
        before.size < 1 ||
        before.size > 4096 ||
        (before.mode & 0o077) !== 0 ||
        before.uid !== process.getuid?.() ||
        before.dev !== leaf.dev ||
        before.ino !== leaf.ino
      )
        throw invalid();
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const r = await fd.read(bytes, offset, bytes.length - offset, offset);
        if (!r.bytesRead) break;
        offset += r.bytesRead;
      }
      const after = await fd.stat(),
        fresh = await lstat(path);
      if (
        offset !== before.size ||
        [after, fresh].some(
          (x) =>
            !x.isFile() ||
            x.isSymbolicLink() ||
            x.dev !== before.dev ||
            x.ino !== before.ino ||
            x.size !== before.size ||
            x.mtimeMs !== before.mtimeMs ||
            x.ctimeMs !== before.ctimeMs ||
            x.uid !== before.uid ||
            x.mode !== before.mode,
        )
      )
        throw invalid();
      await held.assertUnchanged();
      let r;
      try {
        r = JSON.parse(
          new TextDecoder("utf8", { fatal: true }).decode(
            bytes.subarray(0, offset),
          ),
        );
      } catch {
        throw invalid();
      }
      if (
        !r ||
        typeof r !== "object" ||
        Array.isArray(r) ||
        Object.keys(r).length !== 7 ||
        r.schemaVersion !== 1 ||
        r.kind !== "knex-restricted-role" ||
        typeof r.projectId !== "string" ||
        !/^[a-z0-9-]{2,63}$/u.test(r.projectId) ||
        typeof r.role !== "string" ||
        !new RegExp(
          `^rehearsal_knex_[a-f0-9]{16}${phase === "worker" ? "" : "_" + phase}$`,
          "u",
        ).test(r.role) ||
        ![r.roleOid, r.databaseOid].every(
          (x) => Number.isSafeInteger(x) && x > 0 && x <= 4294967295,
        ) ||
        typeof r.systemIdentifier !== "string" ||
        !/^[1-9][0-9]{0,19}$/u.test(r.systemIdentifier)
      )
        throw invalid();
      return r;
    } finally {
      await fd.close();
    }
  } finally {
    await held.close();
  }
};
export const writeKnexRoleReceipt = async (
  directory: string,
  receipt: KnexRoleReceipt,
  phase: KnexSqlPhase = "worker",
) => {
  if (!isKnexSqlPhase(phase)) throw invalid();
  const held = await holdPathAncestry(directory);
  try {
    const parent = await lstat(directory);
    if (
      !parent.isDirectory() ||
      (parent.mode & 0o077) !== 0 ||
      parent.uid !== process.getuid?.()
    )
      throw invalid();
    await held.assertUnchanged();
    const fd = await open(
      join(directory, receiptName(phase)),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.writeFile(JSON.stringify(receipt));
      await fd.sync();
    } finally {
      await fd.close();
    }
    const after = await lstat(directory);
    if (
      parent.dev !== after.dev ||
      parent.ino !== after.ino ||
      (await realpath(directory)) !== directory
    )
      throw invalid();
  } finally {
    await held.close();
  }
};
