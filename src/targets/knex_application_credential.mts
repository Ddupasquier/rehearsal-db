/** Private stable application credential; never overwrite or silently rotate it. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { holdPathAncestry } from "../shared/held_path_ancestry.mjs";

export interface KnexApplicationCredential {
  schemaVersion: 1;
  kind: "knex-application-credential";
  projectId: string;
  generationId: string;
  role: string;
  roleOid: number;
  databaseOid: number;
  systemIdentifier: string;
  database: string;
  password: string;
}
const invalid = () =>
  new Error(
    "Private Knex application credential is unverified; automatic rotation is refused.",
  );
const parse = (source: string): KnexApplicationCredential => {
  let record;
  try {
    record = JSON.parse(source);
  } catch {
    throw invalid();
  }
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join(",") !==
      "database,databaseOid,generationId,kind,password,projectId,role,roleOid,schemaVersion,systemIdentifier" ||
    ![
      record.projectId,
      record.generationId,
      record.role,
      record.systemIdentifier,
      record.database,
      record.password,
    ].every((value) => typeof value === "string") ||
    record.schemaVersion !== 1 ||
    record.kind !== "knex-application-credential" ||
    !/^[a-z0-9-]{2,63}$/u.test(record.projectId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u.test(record.generationId) ||
    !/^rehearsal_knex_[a-f0-9]{16}_application$/u.test(record.role) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(record.database) ||
    !/^[a-f0-9]{64}$/u.test(record.password) ||
    !/^[1-9][0-9]{0,19}$/u.test(record.systemIdentifier) ||
    ![record.roleOid, record.databaseOid].every(
      (value) =>
        Number.isSafeInteger(value) && value > 0 && value <= 4294967295,
    )
  )
    throw invalid();
  return record;
};
const filename = "knex-application-credential.json";
const privateParent = async (directory: string) => {
  const value = await lstat(directory);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== process.getuid?.() ||
    (value.mode & 0o077) !== 0
  )
    throw invalid();
  return value;
};
export const readKnexApplicationCredential = async (
  directory: string,
): Promise<KnexApplicationCredential | null> => {
  const held = await holdPathAncestry(directory);
  try {
    await privateParent(directory);
    const path = join(directory, filename);
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
        before.nlink !== 1 ||
        before.uid !== process.getuid?.() ||
        (before.mode & 0o077) !== 0 ||
        before.size < 1 ||
        before.size > 4096 ||
        before.ino !== leaf.ino ||
        before.dev !== leaf.dev
      )
        throw invalid();
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const next = await fd.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!next.bytesRead) break;
        offset += next.bytesRead;
      }
      const after = await fd.stat(),
        fresh = await lstat(path);
      if (
        offset !== before.size ||
        [after, fresh].some(
          (value) =>
            !value.isFile() ||
            value.isSymbolicLink() ||
            value.nlink !== 1 ||
            value.ino !== before.ino ||
            value.dev !== before.dev ||
            value.size !== before.size ||
            value.mtimeMs !== before.mtimeMs ||
            value.ctimeMs !== before.ctimeMs ||
            value.mode !== before.mode ||
            value.uid !== before.uid,
        )
      )
        throw invalid();
      await held.assertUnchanged();
      return parse(
        new TextDecoder("utf8", { fatal: true }).decode(
          bytes.subarray(0, offset),
        ),
      );
    } finally {
      await fd.close();
    }
  } finally {
    await held.close();
  }
};
export const writeKnexApplicationCredential = async (
  directory: string,
  record: KnexApplicationCredential,
): Promise<void> => {
  const source = JSON.stringify(record);
  parse(source);
  const held = await holdPathAncestry(directory);
  try {
    const before = await privateParent(directory);
    await held.assertUnchanged();
    const fd = await open(
      join(directory, filename),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.writeFile(source);
      await fd.sync();
    } finally {
      await fd.close();
    }
    const after = await privateParent(directory);
    if (before.ino !== after.ino || before.dev !== after.dev) throw invalid();
  } finally {
    await held.close();
  }
};
