/** Bounded destinationless worker framing and PostgreSQL startup gate. No SQL inspection. */
export const KNEX_WORKER_LIMITS = Object.freeze({
  maximumFrameBytes: 65536,
  maximumWireBytes: 64 * 1024 * 1024,
  maximumLogBytes: 1024 * 1024,
  maximumStartupBytes: 4096,
  maximumConnections: 4,
});
const invalid = () =>
  new Error(
    "Isolated Knex worker protocol was refused; private output is withheld.",
  );
export type KnexFrameKind = "O" | "D" | "C" | "L" | "X" | "P" | "E";
export const encodeKnexFrame = (
  kind: KnexFrameKind,
  bytes: Buffer = Buffer.alloc(0),
) => {
  if (
    typeof kind !== "string" ||
    kind.length !== 1 ||
    !"ODCLXPE".includes(kind) ||
    !Buffer.isBuffer(bytes) ||
    bytes.length > KNEX_WORKER_LIMITS.maximumFrameBytes
  )
    throw invalid();
  const b = Buffer.alloc(5 + bytes.length);
  b[0] = kind.charCodeAt(0);
  b.writeUInt32BE(bytes.length, 1);
  bytes.copy(b, 5);
  return b;
};
/** Async iteration backpressures the source while one frame is being forwarded. */
export async function* decodeKnexFrames(
  source: AsyncIterable<Buffer>,
  allowed: string,
): AsyncGenerator<{ kind: KnexFrameKind; bytes: Buffer }> {
  const header = Buffer.alloc(5);
  let have = 0,
    body = Buffer.alloc(0),
    offset = 0,
    total = 0,
    kind: KnexFrameKind = "O";
  for await (const chunk of source) {
    if (
      !Buffer.isBuffer(chunk) ||
      (total += chunk.length) > KNEX_WORKER_LIMITS.maximumWireBytes
    )
      throw invalid();
    let at = 0;
    while (at < chunk.length) {
      if (have < 5) {
        const n = Math.min(5 - have, chunk.length - at);
        chunk.copy(header, have, at, at + n);
        have += n;
        at += n;
        if (have < 5) continue;
        kind = String.fromCharCode(header[0]!) as KnexFrameKind;
        const size = header.readUInt32BE(1);
        if (
          !allowed.includes(kind) ||
          size > KNEX_WORKER_LIMITS.maximumFrameBytes
        )
          throw invalid();
        body = Buffer.alloc(size);
        offset = 0;
      }
      const n = Math.min(body.length - offset, chunk.length - at);
      chunk.copy(body, offset, at, at + n);
      offset += n;
      at += n;
      if (offset === body.length) {
        const bytes = body;
        body = Buffer.alloc(0);
        have = offset = 0;
        yield { kind, bytes };
      }
    }
  }
  if (have || offset) throw invalid();
}
/** The worker runs the same pure parser, not an independently maintained copy.
 * Only Core-owned compiled functions are serialized; no project code is evaluated.
 */
export const KNEX_WORKER_PROTOCOL_SOURCE = `const KNEX_WORKER_LIMITS=${JSON.stringify(KNEX_WORKER_LIMITS)};\nconst invalid=()=>new Error("Worker protocol refused.");\nexport ${decodeKnexFrames.toString()}\n`;
/** Initial packet only: worker cannot select an alternate role, DB, endpoint or negotiation. */
export const validateKnexPgStartup = (
  bytes: Buffer,
  expected: { user: string; database: string },
) => {
  if (
    bytes.length < 9 ||
    bytes.length > KNEX_WORKER_LIMITS.maximumStartupBytes ||
    bytes.readUInt32BE(0) !== bytes.length ||
    bytes.readUInt32BE(4) !== 196608 ||
    bytes.at(-1) !== 0
  )
    throw invalid();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(8));
  } catch {
    throw invalid();
  }
  const parts = text.split("\0");
  if (parts.pop() !== "" || parts.pop() !== "" || parts.length % 2)
    throw invalid();
  const values = new Map<string, string>();
  for (let i = 0; i < parts.length; i += 2) {
    const k = parts[i]!,
      v = parts[i + 1]!;
    if (
      values.has(k) ||
      !["user", "database", "client_encoding", "application_name"].includes(
        k,
      ) ||
      v.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(v)
    )
      throw invalid();
    values.set(k, v);
  }
  if (
    values.get("user") !== expected.user ||
    values.get("database") !== expected.database ||
    (values.has("client_encoding") &&
      !/^(?:UTF8|UTF-8)$/u.test(values.get("client_encoding")!)) ||
    (values.has("application_name") &&
      values.get("application_name") !== "rehearsal-knex-worker")
  )
    throw invalid();
};
