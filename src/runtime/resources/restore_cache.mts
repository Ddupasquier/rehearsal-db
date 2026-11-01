/** Optional owner-private COPY encoding cache; not a database snapshot or a security boundary against its local owner. */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { encodeBaselineRecordForCopy } from "../recovery/restore.mjs";
import { REHEARSAL_VERSION } from "../../shared/diagnostics.mjs";

interface CopyCachePolicy {
  enabled: boolean;
  maximumBytes?: number;
  minimumFreeBytes?: number;
}
interface CopyCacheInput {
  artifactRoot: string;
  dataPath: string;
  generationId: string;
  sourceSha256: string;
  sanitizationPolicySha256: string;
  target: "postgresql" | "supabase";
  policy?: CopyCachePolicy;
  signal?: AbortSignal;
}
interface Identity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
const CHUNK_BYTES = 65536,
  MAXIMUM_ENTRIES = 2048,
  MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;
const AUTHENTICATION_KEY = ".authentication-key",
  WRITER_LOCK = ".writer-lock";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const same = (left: Identity, right: Identity) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;
const privateDirectory = async (path: string) => {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("COPY cache requires a private owned directory.");
};
const openBound = async (
  path: string,
  {
    maximumBytes,
    expected,
    privateOwned = false,
  }: {
    maximumBytes?: number;
    expected?: Identity;
    privateOwned?: boolean;
  } = {},
) => {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !Number.isSafeInteger(before.size) ||
    (maximumBytes !== undefined && before.size > maximumBytes)
  )
    throw new Error("Unverified COPY file.");
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat(),
      current = await lstat(path);
    if (
      !info.isFile() ||
      current.isSymbolicLink() ||
      !same(before, info) ||
      !same(current, info) ||
      (expected && !same(expected, info)) ||
      (maximumBytes !== undefined && info.size > maximumBytes) ||
      (privateOwned &&
        (info.mode & 0o077 ||
          (process.getuid && info.uid !== process.getuid())))
    )
      throw new Error("Unverified COPY file.");
    return { handle, identity: info };
  } catch (error) {
    await handle.close();
    throw error;
  }
};
const readBounded = async (
  path: string,
  maximumBytes: number,
  privateOwned: boolean,
  expected?: Identity,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const source = await openBound(path, {
    maximumBytes,
    privateOwned,
    ...(expected ? { expected } : {}),
  });
  try {
    const bytes = Buffer.alloc(source.identity.size + 1);
    let count = 0;
    while (count < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.handle.read(
        bytes,
        count,
        Math.min(CHUNK_BYTES, bytes.length - count),
        count,
      );
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (
      count !== source.identity.size ||
      !same(source.identity, await source.handle.stat())
    )
      throw new Error("COPY input changed during verification.");
    return bytes.subarray(0, count);
  } finally {
    await source.handle.close();
  }
};
const originalCopy = async function* (dataPath: string, signal?: AbortSignal) {
  const input = createReadStream(dataPath, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      signal?.throwIfAborted();
      if (line) yield `${encodeBaselineRecordForCopy(line)}\n`;
    }
  } finally {
    reader.close();
    input.destroy();
  }
};
const chunksFromBytes = async function* (bytes: Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // UTF-8 text boundaries are preserved: no split multi-byte character is decoded alone.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    signal?.throwIfAborted();
    const text = decoder.decode(
      bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK_BYTES)),
      { stream: true },
    );
    if (text) yield text;
  }
  const tail = decoder.decode();
  signal?.throwIfAborted();
  if (tail) yield tail;
};
const verifySourceHandle = async (
  handle: FileHandle,
  identity: Identity,
  digest: string,
  signal?: AbortSignal,
) => {
  const checksum = createHash("sha256"),
    buffer = Buffer.alloc(CHUNK_BYTES);
  let position = 0;
  while (position <= identity.size) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(CHUNK_BYTES, identity.size - position + 1),
      position,
    );
    if (!bytesRead) break;
    position += bytesRead;
    checksum.update(buffer.subarray(0, bytesRead));
    if (position > identity.size)
      throw new Error(
        "Baseline input changed; no cached COPY stream may be used.",
      );
  }
  if (
    position !== identity.size ||
    !same(identity, await handle.stat()) ||
    checksum.digest("hex") !== digest
  )
    throw new Error(
      "Baseline input changed; no cached COPY stream may be used.",
    );
};
/** Verify and consume one descriptor. The restore transaction cannot commit on a drift error. */
const verifiedSourceChunks = async function* (
  input: CopyCacheInput,
  expected: Identity,
) {
  input.signal?.throwIfAborted();
  const source = await openBound(input.dataPath, { expected });
  try {
    await verifySourceHandle(
      source.handle,
      source.identity,
      input.sourceSha256,
      input.signal,
    );
    const checksum = createHash("sha256"),
      decoder = new TextDecoder("utf-8", { fatal: true }),
      buffer = Buffer.alloc(CHUNK_BYTES);
    let position = 0,
      pending = "";
    const encode = (line: string) =>
      Buffer.from(`${encodeBaselineRecordForCopy(line)}\n`);
    while (position < source.identity.size) {
      input.signal?.throwIfAborted();
      if (!same(source.identity, await source.handle.stat()))
        throw new Error("Baseline input changed during COPY consumption.");
      const { bytesRead } = await source.handle.read(
        buffer,
        0,
        Math.min(CHUNK_BYTES, source.identity.size - position),
        position,
      );
      if (!bytesRead)
        throw new Error("Baseline input changed during COPY consumption.");
      position += bytesRead;
      checksum.update(buffer.subarray(0, bytesRead));
      pending += decoder.decode(buffer.subarray(0, bytesRead), {
        stream: true,
      });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > MAXIMUM_LINE_BYTES)
          throw new Error("COPY source record exceeded its streaming bound.");
        if (line) yield* chunksFromBytes(encode(line), input.signal);
      }
      if (Buffer.byteLength(pending) > MAXIMUM_LINE_BYTES)
        throw new Error("COPY source record exceeded its streaming bound.");
    }
    pending += decoder.decode();
    if (pending)
      yield* chunksFromBytes(encode(pending.replace(/\r$/u, "")), input.signal);
    input.signal?.throwIfAborted();
    if (
      !same(source.identity, await source.handle.stat()) ||
      checksum.digest("hex") !== input.sourceSha256
    )
      throw new Error("Baseline input changed during COPY consumption.");
  } finally {
    await source.handle.close();
  }
};
const knownEntry =
  /^(?:[a-f0-9]{64}\.(?:copy|json)(?:\.[a-f0-9-]{36}\.tmp)?|\.authentication-key|\.writer-lock)$/u;
const retainedBytes = async (root: string) => {
  const directory = await opendir(root);
  let bytes = 0,
    count = 0;
  for await (const entry of directory) {
    if (++count > MAXIMUM_ENTRIES)
      throw new Error("COPY cache inventory exceeds its bound.");
    const name = entry.name;
    if (!knownEntry.test(name))
      throw new Error("Unknown COPY cache material is preserved.");
    const info = await lstat(join(root, name));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid()) ||
      !Number.isSafeInteger(info.size)
    )
      throw new Error("Unverified COPY cache inventory.");
    bytes += info.size;
    if (!Number.isSafeInteger(bytes))
      throw new Error("COPY cache inventory exceeds its bound.");
  }
  return bytes;
};
const sign = (key: Buffer, record: object) =>
  createHmac("sha256", key).update(JSON.stringify(record)).digest("hex");
const verifyAuthentication = (
  key: Buffer,
  record: object,
  authentication: unknown,
) => {
  if (
    typeof authentication !== "string" ||
    !/^[a-f0-9]{64}$/u.test(authentication)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(sign(key, record), "hex"),
    Buffer.from(authentication, "hex"),
  );
};
export const restoreCopyChunks = async (
  input: CopyCacheInput,
): Promise<{
  state: "disabled" | "verified-hit" | "created" | "safe-fallback";
  chunks: AsyncIterable<string>;
}> => {
  input.signal?.throwIfAborted();
  if (!input.policy?.enabled)
    return {
      state: "disabled",
      chunks: originalCopy(input.dataPath, input.signal),
    };
  const maximumBytes = input.policy.maximumBytes,
    minimumFreeBytes = input.policy.minimumFreeBytes;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes! <= 0 ||
    maximumBytes! > 536870912 ||
    !Number.isSafeInteger(minimumFreeBytes) ||
    minimumFreeBytes! <= 0
  )
    throw new Error("Invalid COPY cache budget.");
  if (
    ![input.sourceSha256, input.sanitizationPolicySha256].every((d) =>
      /^[a-f0-9]{64}$/u.test(d),
    )
  )
    throw new Error("COPY cache requires verified immutable input hashes.");
  const sourceInfo = await lstat(input.dataPath);
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    !Number.isSafeInteger(sourceInfo.size)
  )
    throw new Error("COPY input must be a regular immutable baseline file.");
  const fallback = () => ({
    state: "safe-fallback" as const,
    chunks: verifiedSourceChunks(input, sourceInfo),
  });
  if (sourceInfo.size > maximumBytes!) return fallback();
  const source = await readBounded(
    input.dataPath,
    maximumBytes!,
    false,
    sourceInfo,
    input.signal,
  );
  if (hash(source) !== input.sourceSha256)
    throw new Error(
      "Baseline input changed; no cached COPY stream may be used.",
    );
  const key = hash(
    JSON.stringify({
      version: 2,
      encoder: "postgresql-copy-v1",
      core: REHEARSAL_VERSION,
      target: input.target,
      generationId: input.generationId,
      sourceSha256: input.sourceSha256,
      sanitizationPolicySha256: input.sanitizationPolicySha256,
    }),
  );
  const cacheRoot = join(resolve(input.artifactRoot), "restore-cache");
  // Recheck source identity when an already-prepared cached iterator is consumed.
  const boundChunks = (data: Buffer) =>
    (async function* () {
      input.signal?.throwIfAborted();
      const current = await openBound(input.dataPath, { expected: sourceInfo });
      try {
        await verifySourceHandle(
          current.handle,
          sourceInfo,
          input.sourceSha256,
          input.signal,
        );
      } finally {
        await current.handle.close();
      }
      yield* chunksFromBytes(data, input.signal);
      input.signal?.throwIfAborted();
      const after = await lstat(input.dataPath);
      if (after.isSymbolicLink() || !same(sourceInfo, after))
        throw new Error("Baseline input changed during COPY consumption.");
    })();
  let lock: { handle: FileHandle; identity: Identity } | null = null;
  const temporaryPaths: { path: string; identity: Identity }[] = [];
  try {
    if ((await realpath(input.artifactRoot)) !== resolve(input.artifactRoot))
      throw new Error("Unverified cache parent.");
    const parent = await lstat(input.artifactRoot);
    if (
      !parent.isDirectory() ||
      parent.mode & 0o077 ||
      (process.getuid && parent.uid !== process.getuid())
    )
      throw new Error("Unverified cache parent.");
    await privateDirectory(cacheRoot);
    if ((await retainedBytes(cacheRoot)) > maximumBytes!)
      throw new Error("COPY cache total budget exhausted.");
    try {
      const authenticationKey = await readBounded(
        join(cacheRoot, AUTHENTICATION_KEY),
        32,
        true,
        undefined,
        input.signal,
      );
      if (authenticationKey.length !== 32)
        throw new Error("Unverified cache authentication key.");
      const receipt = JSON.parse(
        (
          await readBounded(
            join(cacheRoot, `${key}.json`),
            1024,
            true,
            undefined,
            input.signal,
          )
        ).toString("utf8"),
      );
      const data = await readBounded(
        join(cacheRoot, `${key}.copy`),
        maximumBytes!,
        true,
        undefined,
        input.signal,
      );
      const base = {
        schemaVersion: 2,
        key,
        bytes: data.length,
        sha256: hash(data),
      };
      if (
        Object.keys(receipt).sort().join(",") !==
          "authenticationSha256,bytes,key,schemaVersion,sha256" ||
        receipt.schemaVersion !== 2 ||
        receipt.key !== key ||
        receipt.bytes !== data.length ||
        receipt.sha256 !== base.sha256 ||
        !verifyAuthentication(
          authenticationKey,
          base,
          receipt.authenticationSha256,
        )
      )
        throw new Error("Unverified COPY cache binding.");
      input.signal?.throwIfAborted();
      return { state: "verified-hit", chunks: boundChunks(data) };
    } catch {
      input.signal?.throwIfAborted();
    }
    // No stale-lock stealing. Concurrent misses take the verified source fallback.
    const lockPath = join(cacheRoot, WRITER_LOCK);
    const handle = await open(
      lockPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    lock = { handle, identity: await handle.stat() };
    let total = await retainedBytes(cacheRoot);
    let authenticationKey: Buffer;
    try {
      authenticationKey = await readBounded(
        join(cacheRoot, AUTHENTICATION_KEY),
        32,
        true,
        undefined,
        input.signal,
      );
      if (authenticationKey.length !== 32)
        throw new Error("Unverified cache authentication key.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (total + 32 > maximumBytes!)
        throw new Error("COPY cache total budget exhausted.");
      authenticationKey = randomBytes(32);
      await writeFile(join(cacheRoot, AUTHENTICATION_KEY), authenticationKey, {
        mode: 0o600,
        flag: "wx",
      });
      total += 32;
    }
    const parts: string[] = [];
    let size = 0;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    for (const line of text.split(/\r?\n/u)) {
      input.signal?.throwIfAborted();
      if (!line) continue;
      const value = `${encodeBaselineRecordForCopy(line)}\n`;
      size += Buffer.byteLength(value);
      if (total + size + 1024 > maximumBytes!)
        throw new Error("COPY cache total budget exhausted.");
      parts.push(value);
    }
    const encoded = Buffer.from(parts.join(""));
    const base = {
      schemaVersion: 2,
      key,
      bytes: encoded.length,
      sha256: hash(encoded),
    };
    const receipt = Buffer.from(
      JSON.stringify({
        ...base,
        authenticationSha256: sign(authenticationKey, base),
      }) + "\n",
    );
    if (total + encoded.length + receipt.length > maximumBytes!)
      throw new Error("COPY cache total budget exhausted.");
    const disk = await statfs(cacheRoot),
      available = disk.bavail * disk.bsize;
    if (
      !Number.isSafeInteger(available) ||
      available < minimumFreeBytes! + encoded.length + receipt.length
    )
      throw new Error("Insufficient cache headroom.");
    const suffix = `.${randomUUID()}.tmp`,
      dataPath = join(cacheRoot, `${key}.copy`),
      receiptPath = join(cacheRoot, `${key}.json`);
    // Inventory already refused unknown types/symlinks; preserve every unrelated file.
    for (const [path, bytes] of [
      [dataPath + suffix, encoded],
      [receiptPath + suffix, receipt],
    ] as const) {
      const temporary = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      temporaryPaths.push({ path, identity: await temporary.stat() });
      try {
        await temporary.writeFile(bytes);
      } finally {
        await temporary.close();
      }
    }
    input.signal?.throwIfAborted();
    await rename(dataPath + suffix, dataPath);
    temporaryPaths.splice(
      temporaryPaths.findIndex((entry) => entry.path === dataPath + suffix),
      1,
    );
    await rename(receiptPath + suffix, receiptPath);
    temporaryPaths.splice(
      temporaryPaths.findIndex((entry) => entry.path === receiptPath + suffix),
      1,
    );
    return { state: "created", chunks: boundChunks(encoded) };
  } catch {
    input.signal?.throwIfAborted();
    return fallback();
  } finally {
    for (const entry of temporaryPaths) {
      const current = await lstat(entry.path);
      if (
        current.dev !== entry.identity.dev ||
        current.ino !== entry.identity.ino ||
        !current.isFile() ||
        current.isSymbolicLink()
      )
        throw new Error(
          "COPY cache temporary identity changed; foreign material preserved.",
        );
      await rm(entry.path);
    }
    if (lock) {
      await lock.handle.close();
      const current = await lstat(join(cacheRoot, WRITER_LOCK));
      if (
        current.dev !== lock.identity.dev ||
        current.ino !== lock.identity.ino ||
        !current.isFile() ||
        current.isSymbolicLink()
      )
        throw new Error(
          "COPY cache writer lock changed; foreign material preserved.",
        );
      await rm(join(cacheRoot, WRITER_LOCK));
    }
  }
};
