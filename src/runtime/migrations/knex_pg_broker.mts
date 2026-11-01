/** Only validated startup bytes reach one fixed, independently proven target. */
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import {
  KNEX_WORKER_LIMITS,
  validateKnexPgStartup,
  type KnexFrameKind,
} from "./knex_worker_protocol.mjs";
const refused = () =>
  new Error(
    "Isolated Knex database transport was refused; private protocol output is withheld.",
  );
const channelBytes = (id: number, body = Buffer.alloc(0)) => {
  const bytes = Buffer.alloc(4 + body.length);
  bytes.writeUInt32BE(id, 0);
  body.copy(bytes, 4);
  return bytes;
};
interface Channel {
  id: number;
  socket: Socket | null;
  startup: Buffer;
  started: boolean;
  closing: boolean;
}
export const createKnexPgBroker = ({
  port,
  user,
  database,
  assertOwnedTarget,
  send,
  signal,
}: {
  port: number;
  user: string;
  database: string;
  assertOwnedTarget: () => string;
  send: (kind: KnexFrameKind, bytes: Buffer) => Promise<void>;
  signal: AbortSignal;
}) => {
  if (
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !/^rehearsal_knex_[a-f0-9]{16}$/u.test(user) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(database)
  )
    throw refused();
  const target = assertOwnedTarget();
  if (!/^[a-f0-9]{64}$/u.test(target)) throw refused();
  let active: Channel | null = null,
    connections = 0,
    wireBytes = 0,
    failure: unknown,
    closed = false;
  const sessions: Array<{ pid: number; key: number }> = [],
    readers: Promise<void>[] = [];
  const closeChannel = (channel: Channel) => {
    channel.closing = true;
    channel.socket?.destroy();
    if (active === channel) active = null;
    channel.startup = Buffer.alloc(0);
  };
  const onAbort = () => {
    if (active) closeChannel(active);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const readServer = async (channel: Channel, socket: Socket) => {
    let header = Buffer.alloc(5),
      have = 0,
      remaining = 0,
      kind = 0,
      keyBytes = Buffer.alloc(0),
      keyOffset = 0,
      hasKey = false;
    const observe = (bytes: Buffer) => {
      let at = 0;
      while (at < bytes.length) {
        if (have < 5) {
          const n = Math.min(5 - have, bytes.length - at);
          bytes.copy(header, have, at, at + n);
          have += n;
          at += n;
          if (have < 5) continue;
          kind = header[0]!;
          remaining = header.readUInt32BE(1) - 4;
          if (remaining < 0 || remaining > KNEX_WORKER_LIMITS.maximumWireBytes)
            throw refused();
          if (kind === 75) {
            if (remaining !== 8 || hasKey) throw refused();
            keyBytes = Buffer.alloc(8);
            keyOffset = 0;
          }
        }
        const n = Math.min(remaining, bytes.length - at);
        if (kind === 75) {
          bytes.copy(keyBytes, keyOffset, at, at + n);
          keyOffset += n;
        }
        at += n;
        remaining -= n;
        if (!remaining) {
          if (kind === 75) {
            const pid = keyBytes.readInt32BE(0),
              key = keyBytes.readInt32BE(4);
            if (pid <= 0) throw refused();
            sessions.push({ pid, key });
            hasKey = true;
          }
          have = 0;
        }
      }
    };
    try {
      for await (const chunk of socket) {
        const bytes = Buffer.from(chunk);
        if ((wireBytes += bytes.length) > KNEX_WORKER_LIMITS.maximumWireBytes)
          throw refused();
        observe(bytes);
        for (
          let at = 0;
          at < bytes.length;
          at += KNEX_WORKER_LIMITS.maximumFrameBytes - 4
        )
          await send(
            "P",
            channelBytes(
              channel.id,
              bytes.subarray(at, at + KNEX_WORKER_LIMITS.maximumFrameBytes - 4),
            ),
          );
      }
      if (!channel.closing) await send("E", channelBytes(channel.id));
    } catch {
      if (!channel.closing && !closed) failure = refused();
    } finally {
      if (active === channel) active = null;
      socket.destroy();
    }
  };
  return {
    async accept(kind: KnexFrameKind, bytes: Buffer) {
      if (signal.aborted || failure || closed || bytes.length < 4)
        throw refused();
      const id = bytes.readUInt32BE(0),
        body = bytes.subarray(4);
      if (kind === "O") {
        if (
          body.length ||
          active ||
          id !== connections + 1 ||
          id > KNEX_WORKER_LIMITS.maximumConnections ||
          assertOwnedTarget() !== target
        )
          throw refused();
        connections = id;
        active = {
          id,
          socket: null,
          startup: Buffer.alloc(0),
          started: false,
          closing: false,
        };
        return;
      }
      if (kind === "C") {
        if (body.length || id < 1 || id > connections) throw refused();
        if (active?.id === id) closeChannel(active);
        return;
      }
      const channel = active;
      if (
        kind !== "D" ||
        !channel ||
        channel.id !== id ||
        !body.length ||
        (wireBytes += body.length) > KNEX_WORKER_LIMITS.maximumWireBytes
      )
        throw refused();
      let data = body;
      if (!channel.started) {
        if (
          channel.startup.length + body.length >
          KNEX_WORKER_LIMITS.maximumStartupBytes
        )
          throw refused();
        channel.startup = Buffer.concat([channel.startup, body]);
        if (channel.startup.length < 4) return;
        const n = channel.startup.readUInt32BE(0);
        if (
          n < 9 ||
          n > KNEX_WORKER_LIMITS.maximumStartupBytes ||
          channel.startup.length > n
        )
          throw refused();
        if (channel.startup.length < n) return;
        validateKnexPgStartup(channel.startup, { user, database });
        if (assertOwnedTarget() !== target) throw refused();
        const socket = connect({ host: "127.0.0.1", port });
        channel.socket = socket;
        socket.setTimeout(5000, () => socket.destroy(refused()));
        socket.on("error", () => {});
        const reader = readServer(channel, socket);
        readers.push(reader);
        await once(socket, "connect", { signal });
        socket.setTimeout(0);
        data = channel.startup;
        channel.startup = Buffer.alloc(0);
        channel.started = true;
      }
      const socket = channel.socket;
      if (!socket || channel.closing) throw refused();
      await new Promise<void>((resolve, reject) =>
        socket.write(data, (error) => (error ? reject(refused()) : resolve())),
      );
    },
    assertHealthy() {
      if (failure || signal.aborted) throw refused();
    },
    async close(assertBackendGone: (pid: number) => Promise<void>) {
      closed = true;
      signal.removeEventListener("abort", onAbort);
      if (active) closeChannel(active);
      let timer: NodeJS.Timeout | undefined;
      const settled = await Promise.race([
        Promise.allSettled(readers).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      let failed = !settled;
      for (const session of sessions) {
        try {
          if (assertOwnedTarget() !== target) throw refused();
          const request = Buffer.alloc(16);
          request.writeInt32BE(16, 0);
          request.writeInt32BE(80877102, 4);
          request.writeInt32BE(session.pid, 8);
          request.writeInt32BE(session.key, 12);
          await new Promise<void>((resolve, reject) => {
            const cancel = connect({ host: "127.0.0.1", port });
            let connected = false,
              done = false;
            const finish = (error?: Error) => {
              if (done) return;
              done = true;
              clearTimeout(timeout);
              cancel.destroy();
              error ? reject(error) : resolve();
            };
            const timeout = setTimeout(() => finish(refused()), 1000);
            cancel.once("connect", () => {
              connected = true;
              cancel.end(request);
            });
            cancel.once("error", () => finish(refused()));
            cancel.once("close", () =>
              finish(connected ? undefined : refused()),
            );
          });
          await assertBackendGone(session.pid);
        } catch {
          failed = true;
        }
      }
      if (failed)
        throw new Error(
          "Isolated Knex backend cleanup is unconfirmed; owned database and recovery state are retained.",
        );
    },
  };
};
