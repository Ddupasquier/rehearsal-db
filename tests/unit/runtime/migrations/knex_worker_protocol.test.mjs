import { expect, it } from "vitest";
import {
  decodeKnexFrames,
  encodeKnexFrame,
  validateKnexPgStartup,
  KNEX_WORKER_PROTOCOL_SOURCE,
} from "../../../../dist/src/runtime/migrations/knex_worker_protocol.mjs";
const expected = {
  user: "rehearsal_knex_0123456789abcdef",
  database: "postgres",
};
const startup = (
  values = {
    ...expected,
    application_name: "rehearsal-knex-worker",
    client_encoding: "UTF8",
  },
  protocol = 196608,
) => {
  const body = Buffer.from(Object.entries(values).flat().join("\0") + "\0\0"),
    b = Buffer.alloc(body.length + 8);
  b.writeInt32BE(b.length, 0);
  b.writeInt32BE(protocol, 4);
  body.copy(b, 8);
  return b;
};
it("accepts exact native pg Unix-client startup and fragmented bounded frames", async () => {
  expect(() => validateKnexPgStartup(startup(), expected)).not.toThrow();
  const observed = [];
  const bytes = Buffer.concat([
    encodeKnexFrame("O"),
    encodeKnexFrame("D", Buffer.from("private")),
    encodeKnexFrame("C"),
    encodeKnexFrame("X", Buffer.from([0])),
  ]);
  async function* source() {
    for (const byte of bytes) yield Buffer.from([byte]);
  }
  for await (const { kind, bytes: body } of decodeKnexFrames(source(), "ODCX"))
    observed.push([kind, body.toString()]);
  expect(observed.map((x) => x[0])).toEqual(["O", "D", "C", "X"]);
});
it.each([
  { ...expected, user: "postgres" },
  { ...expected, database: "foreign" },
  { ...expected, options: "-c role=postgres" },
  { ...expected, replication: "database" },
  { ...expected, application_name: "foreign" },
  { ...expected, client_encoding: "SQL_ASCII" },
])("refuses role/database/options drift before forwarding %#", (values) => {
  expect(() => validateKnexPgStartup(startup(values), expected)).toThrow(
    /refused/,
  );
});
it.each([80877103, 80877104, 80877102])(
  "refuses SSL/GSS/cancel negotiation %s",
  (code) =>
    expect(() =>
      validateKnexPgStartup(startup(expected, code), expected),
    ).toThrow(),
);
it("refuses duplicate startup keys, oversize and incomplete packets", async () => {
  const good = startup();
  good.writeInt32BE(good.length + 1, 0);
  expect(() => validateKnexPgStartup(good, expected)).toThrow();
  expect(() => validateKnexPgStartup(Buffer.alloc(4097), expected)).toThrow();
  const consume = async (bytes) => {
    async function* source() {
      yield bytes;
    }
    for await (const _ of decodeKnexFrames(source(), "D")) {
    }
  };
  await expect(consume(Buffer.from([68, 0, 0]))).rejects.toThrow();
  const huge = Buffer.alloc(5);
  huge[0] = 68;
  huge.writeUInt32BE(65537, 1);
  await expect(consume(huge)).rejects.toThrow();
  await expect(consume(encodeKnexFrame("O"))).rejects.toThrow();
  expect(() => encodeKnexFrame("OD")).toThrow();
});
it("backpressures a fragmented multi-MiB stream one frame at a time without prefetching producer chunks", async () => {
  let produced = 0,
    consumed = 0;
  const payload = Buffer.alloc(65536, 123);
  async function* source() {
    for (let i = 0; i < 64; i++) {
      produced++;
      const frame = encodeKnexFrame("D", payload);
      yield frame.subarray(0, 7);
      yield frame.subarray(7);
      expect(consumed).toBe(produced);
    }
  }
  for await (const frame of decodeKnexFrames(source(), "D")) {
    expect(produced).toBe(consumed + 1);
    expect(frame.bytes.equals(payload)).toBe(true);
    await Promise.resolve();
    consumed++;
  }
  expect(consumed).toBe(64);
});
it("the exact serialized worker parser handles burst PG-response chunks without a pending-frame queue", async () => {
  const worker = await import(
    `data:text/javascript;base64,${Buffer.from(KNEX_WORKER_PROTOCOL_SOURCE).toString("base64")}`
  );
  const frame = encodeKnexFrame("P", Buffer.alloc(65536, 42)),
    burst = Buffer.concat(Array.from({ length: 16 }, () => frame));
  let produced = 0,
    consumed = 0;
  async function* source() {
    for (let i = 0; i < 4; i++) {
      produced++;
      yield burst;
      expect(consumed).toBe(produced * 16);
    }
  }
  for await (const observed of worker.decodeKnexFrames(source(), "JPE")) {
    expect(produced).toBe(Math.floor(consumed / 16) + 1);
    expect(observed.bytes.length).toBe(65536);
    await Promise.resolve();
    consumed++;
  }
  expect(consumed).toBe(64);
});
