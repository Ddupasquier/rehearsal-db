import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ sockets: [], hangCancel: false }));
vi.mock("node:net", () => ({
  connect: (options) => {
    const socket = new EventEmitter();
    socket.options = options;
    socket.writes = [];
    socket.closed = false;
    socket.setTimeout = () => socket;
    socket.write = (bytes, callback) => {
      socket.writes.push(Buffer.from(bytes));
      queueMicrotask(() => callback?.());
      return true;
    };
    socket.destroy = () => {
      if (!socket.closed) {
        socket.closed = true;
        socket.emit("close");
      }
      return socket;
    };
    socket.end = (bytes) => {
      if (bytes) socket.writes.push(Buffer.from(bytes));
      queueMicrotask(() => socket.destroy());
    };
    const index = state.sockets.length;
    socket[Symbol.asyncIterator] = async function* () {
      if (index === 0) {
        const key = Buffer.alloc(13);
        key[0] = 75;
        key.writeInt32BE(12, 1);
        key.writeInt32BE(1234, 5);
        key.writeInt32BE(123456, 9);
        yield key;
      }
      if (!socket.closed)
        await new Promise((resolve) => socket.once("close", resolve));
    };
    state.sockets.push(socket);
    if (!(index > 0 && state.hangCancel))
      queueMicrotask(() => socket.emit("connect"));
    return socket;
  },
}));
import { createKnexPgBroker } from "../../../../dist/src/runtime/migrations/knex_pg_broker.mjs";
afterEach(() => {
  state.sockets = [];
  state.hangCancel = false;
  vi.useRealTimers();
});
const role = "rehearsal_knex_0123456789abcdef",
  identity = "a".repeat(64);
const startup = (user = role, protocol = 196608) => {
  const body = Buffer.from(
      `user\0${user}\0database\0postgres\0application_name\0rehearsal-knex-worker\0\0`,
    ),
    b = Buffer.alloc(body.length + 8);
  b.writeInt32BE(b.length, 0);
  b.writeInt32BE(protocol, 4);
  body.copy(b, 8);
  return b;
};
const tagged = (id, bytes = Buffer.alloc(0)) => {
  const out = Buffer.alloc(bytes.length + 4);
  out.writeUInt32BE(id, 0);
  bytes.copy(out, 4);
  return out;
};
const create = (extra = {}) =>
  createKnexPgBroker({
    port: 59422,
    user: role,
    database: "postgres",
    assertOwnedTarget: () => identity,
    send: async () => {},
    signal: new AbortController().signal,
    ...extra,
  });
it("forwards only fully validated startup to fixed loopback and uses server-issued cancellation keys for cleanup", async () => {
  const b = create();
  await b.accept("O", tagged(1));
  const input = startup();
  await b.accept("D", tagged(1, input.subarray(0, 7)));
  expect(state.sockets).toEqual([]);
  await b.accept("D", tagged(1, input.subarray(7)));
  expect(state.sockets[0].writes[0]).toEqual(input);
  let checked = 0;
  await b.close(async (pid) => {
    expect(pid).toBe(1234);
    checked++;
  });
  expect(checked).toBe(1);
  expect(state.sockets.map((s) => s.options)).toEqual([
    { host: "127.0.0.1", port: 59422 },
    { host: "127.0.0.1", port: 59422 },
  ]);
  expect(state.sockets[1].writes[0].readInt32BE(4)).toBe(80877102);
  expect(state.sockets.every((s) => s.closed)).toBe(true);
});
it.each([
  ["postgres", 196608],
  [role, 80877103],
  [role, 80877104],
  [role, 80877102],
])(
  "refuses untrusted startup %s/%s without forwarding it",
  async (user, protocol) => {
    const b = create();
    await b.accept("O", tagged(1));
    await expect(
      b.accept("D", tagged(1, startup(user, protocol))),
    ).rejects.toThrow(/refused/);
    expect(state.sockets).toEqual([]);
    await b.close(async () => {});
  },
);
it("refuses endpoint/target drift before making a connection", async () => {
  let calls = 0;
  const b = create({
    assertOwnedTarget: () => (++calls === 1 ? identity : "b".repeat(64)),
  });
  await expect(b.accept("O", tagged(1))).rejects.toThrow();
  expect(state.sockets).toEqual([]);
  await b.close(async () => {});
});
it("a cancel socket that never connects cannot leave cleanup waiting forever or claim backend absence", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const b = create();
  await b.accept("O", tagged(1));
  await b.accept("D", tagged(1, startup()));
  await Promise.resolve();
  await Promise.resolve();
  state.hangCancel = true;
  let checked = 0;
  const closing = b.close(async () => {
    checked++;
  });
  const assertion = expect(closing).rejects.toThrow(/cleanup is unconfirmed/);
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(checked).toBe(0);
  expect(state.sockets.at(-1).closed).toBe(true);
});

it("intentional close and stale old-channel close cannot fail or close a newer native connection", async () => {
  const b = create();
  await b.accept("O", tagged(1));
  await b.accept("D", tagged(1, startup()));
  await b.accept("C", tagged(1));
  await b.accept("O", tagged(2));
  await b.accept("D", tagged(2, startup()));
  await b.accept("C", tagged(1));
  expect(state.sockets[1].closed).toBe(false);
  await b.accept("D", tagged(2, Buffer.from("owned-query")));
  expect(state.sockets[1].writes.at(-1).toString()).toBe("owned-query");
  b.assertHealthy();
  await b.close(async () => {});
});
