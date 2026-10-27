/** Bounded local receipt observation, never proof of the current database or input set. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { holdPathAncestry } from "../shared/held_path_ancestry.mjs";

export const RECEIPT_OBSERVATION_MAXIMUM_BYTES = 2 * 1024 * 1024;
export interface ReceiptProvenance {
  readonly state: "not-requested" | "observed" | "missing" | "refused";
  readonly reason:
    | "not_requested"
    | "recorded_receipt_only"
    | "receipt_missing"
    | "receipt_unverified"
    | "host_filesystem_unqualified";
  readonly target: "postgresql" | "supabase" | null;
  readonly baselineGenerationId: string | null;
  readonly candidateSha256: string | null;
  readonly candidateCount: number | null;
  readonly timestamp: null;
  readonly freshness: "unknown";
  readonly currentInputsMatch: "unknown";
  readonly liveState: "unknown";
}
const result = (
  state: ReceiptProvenance["state"],
  reason: ReceiptProvenance["reason"],
  fields: Partial<
    Pick<
      ReceiptProvenance,
      "target" | "baselineGenerationId" | "candidateSha256" | "candidateCount"
    >
  > = {},
): ReceiptProvenance => ({
  state,
  reason,
  target: null,
  baselineGenerationId: null,
  candidateSha256: null,
  candidateCount: null,
  ...fields,
  timestamp: null,
  freshness: "unknown",
  currentInputsMatch: "unknown",
  liveState: "unknown",
});
const invalid = () =>
  new Error("Local receipt provenance could not be established.");
export const parseRecordedRuntimeReceipt = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const x = value as Record<string, unknown>;
  if (
    Object.keys(x).sort().join(",") !==
      "baselineGenerationId,candidateSha256,candidates,formatVersion,target" ||
    x.formatVersion !== 1 ||
    !["postgresql", "supabase"].includes(x.target as string) ||
    typeof x.baselineGenerationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(x.baselineGenerationId) ||
    typeof x.candidateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(x.candidateSha256) ||
    !Array.isArray(x.candidates) ||
    x.candidates.length > 10000
  )
    throw invalid();
  const names = new Set<string>();
  for (const raw of x.candidates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
    const item = raw as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(",") !== "filename,sha256" ||
      typeof item.filename !== "string" ||
      item.filename.length > 300 ||
      !/^\d{14}_[^/\\\u0000-\u001f\u007f]+\.sql$/u.test(item.filename) ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      names.has(item.filename)
    )
      throw invalid();
    names.add(item.filename);
  }
  return result("observed", "recorded_receipt_only", {
    target: x.target as "postgresql" | "supabase",
    baselineGenerationId: x.baselineGenerationId,
    candidateSha256: x.candidateSha256,
    candidateCount: x.candidates.length,
  });
};
export const inspectReceiptProvenance = async ({
  projectRoot,
  receiptPath,
  filesystemQualified,
}: {
  projectRoot: string;
  receiptPath?: string;
  filesystemQualified: boolean;
}): Promise<ReceiptProvenance> => {
  if (receiptPath === undefined)
    return result("not-requested", "not_requested");
  if (!filesystemQualified)
    return result("refused", "host_filesystem_unqualified");
  try {
    if (
      !receiptPath ||
      receiptPath.length > 2048 ||
      isAbsolute(receiptPath) ||
      receiptPath.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(receiptPath) ||
      receiptPath.split("/").length > 32 ||
      receiptPath
        .split("/")
        .some((p) => !p || p === "." || p === ".." || p.includes(":"))
    )
      throw invalid();
    const root = resolve(projectRoot);
    if ((await realpath(root)) !== root) throw invalid();
    const path = resolve(root, receiptPath),
      local = relative(root, path);
    if (
      !local ||
      local === ".." ||
      local.startsWith(`..${sep}`) ||
      isAbsolute(local)
    )
      throw invalid();
    const held = await holdPathAncestry(dirname(path));
    try {
      const leaf = await lstat(path, { bigint: true });
      if (
        !leaf.isFile() ||
        leaf.isSymbolicLink() ||
        leaf.nlink !== 1n ||
        leaf.size > BigInt(RECEIPT_OBSERVATION_MAXIMUM_BYTES) ||
        (leaf.mode & 0o077n) !== 0n ||
        typeof process.getuid !== "function" ||
        leaf.uid !== BigInt(process.getuid())
      )
        throw invalid();
      const fd = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await fd.stat({ bigint: true });
        if (
          before.dev !== leaf.dev ||
          before.ino !== leaf.ino ||
          before.size !== leaf.size ||
          before.mtimeNs !== leaf.mtimeNs ||
          before.ctimeNs !== leaf.ctimeNs
        )
          throw invalid();
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await fd.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        const after = await fd.stat({ bigint: true }),
          fresh = await lstat(path, { bigint: true });
        if (
          offset !== Number(before.size) ||
          [after, fresh].some(
            (s) =>
              !s.isFile() ||
              s.isSymbolicLink() ||
              s.dev !== before.dev ||
              s.ino !== before.ino ||
              s.size !== before.size ||
              s.mtimeNs !== before.mtimeNs ||
              s.ctimeNs !== before.ctimeNs ||
              s.mode !== before.mode ||
              s.uid !== before.uid ||
              s.nlink !== 1n,
          )
        )
          throw invalid();
        await held.assertUnchanged();
        return parseRecordedRuntimeReceipt(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(0, offset),
            ),
          ),
        );
      } finally {
        await fd.close();
      }
    } finally {
      await held.close();
    }
  } catch (error) {
    return result(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "missing"
        : "refused",
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "receipt_missing"
        : "receipt_unverified",
    );
  }
};
