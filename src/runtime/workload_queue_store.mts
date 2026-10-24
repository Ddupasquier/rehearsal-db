/** Private bounded atomic ticket files. A ticket name is never reused. */
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface WorkloadTicket {
  schemaVersion: 1;
  token: string;
  pid: number;
  command: "start" | "run" | "reset" | "migrate";
  phase: "choosing" | "queued" | "held";
  number: number;
  createdAt: string;
}
export interface StoredWorkloadTicket {
  ticket: WorkloadTicket;
  file: string;
  identity: string;
  alive: boolean;
}
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const identity = (stat: Stats): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const privateOwned = (stat: Stats): boolean =>
  stat.uid === process.getuid!() && (stat.mode & 0o077) === 0;
const validTicket = (value: WorkloadTicket, token: string): boolean =>
  value !== null &&
  typeof value === "object" &&
  value.schemaVersion === 1 &&
  value.token === token &&
  Number.isSafeInteger(value.pid) &&
  value.pid > 0 &&
  ["start", "run", "reset", "migrate"].includes(value.command) &&
  ["choosing", "queued", "held"].includes(value.phase) &&
  Number.isSafeInteger(value.number) &&
  value.number >= 0 &&
  (value.phase === "choosing") === (value.number === 0) &&
  typeof value.createdAt === "string" &&
  Number.isFinite(Date.parse(value.createdAt)) &&
  new Date(value.createdAt).toISOString() === value.createdAt &&
  Object.keys(value).sort().join(",") ===
    "command,createdAt,number,phase,pid,schemaVersion,token";

export const workloadOwnerAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM/unknown visibility is never permission to reclaim.
    throw new Error(
      "Cannot prove workload owner liveness; no workload was admitted or recovered.",
    );
  }
};

export class WorkloadQueueStore {
  private rootIdentity: string | undefined;
  constructor(readonly directory: string) {}

  async initialize(create: boolean): Promise<boolean> {
    if (create) {
      await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 });
      await mkdir(this.directory, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    }
    const parent = await lstat(dirname(this.directory)).catch(
      (error: unknown) => {
        if (missing(error)) return null;
        throw error;
      },
    );
    if (!parent) return false;
    if (!parent.isDirectory() || !privateOwned(parent))
      throw new Error(
        "Workload state parent must be a private owned directory, not a link.",
      );
    let stat: Stats;
    try {
      stat = await lstat(this.directory);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    if (!stat.isDirectory() || !privateOwned(stat))
      throw new Error(
        "Workload queue must be a private owned directory, not a link.",
      );
    this.rootIdentity = `${stat.dev}:${stat.ino}`;
    return true;
  }

  async assertRoot(): Promise<void> {
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      !privateOwned(stat) ||
      `${stat.dev}:${stat.ino}` !== this.rootIdentity
    )
      throw new Error(
        "Workload queue directory changed; no further workload phase was started.",
      );
  }

  async read(file: string): Promise<StoredWorkloadTicket | null> {
    await this.assertRoot();
    const match = /^ticket-([a-f0-9-]{36})\.json$/u.exec(file);
    if (!match)
      throw new Error(
        "Unknown workload queue entry; inspect local state without deleting it.",
      );
    for (let attempt = 0; attempt < 4; attempt++) {
      let handle;
      try {
        handle = await open(
          join(this.directory, file),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const before = await handle.stat();
        if (!before.isFile() || !privateOwned(before) || before.size > 4096)
          throw new Error(
            "Invalid workload ticket ownership, type or size; queue refused.",
          );
        const bytes = Buffer.alloc(4097);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 4096)
          throw new Error("Workload ticket exceeds the bounded record size.");
        const after = await lstat(join(this.directory, file));
        if (identity(before) !== identity(after)) continue;
        let ticket: WorkloadTicket;
        try {
          ticket = JSON.parse(
            bytes.subarray(0, bytesRead).toString("utf8"),
          ) as WorkloadTicket;
        } catch {
          throw new Error("Invalid workload ticket JSON; queue refused.");
        }
        if (!validTicket(ticket, match[1]!))
          throw new Error("Invalid workload ticket; queue refused.");
        return {
          ticket,
          file,
          identity: identity(after),
          alive: workloadOwnerAlive(ticket.pid),
        };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      } finally {
        await handle?.close();
      }
    }
    throw new Error("Workload ticket kept changing; no workload was admitted.");
  }

  async list(): Promise<StoredWorkloadTicket[]> {
    await this.assertRoot();
    const entries: StoredWorkloadTicket[] = [];
    const directory = await opendir(this.directory);
    let count = 0;
    for await (const entry of directory) {
      if (++count > 128)
        throw new Error(
          "Workload queue entry limit reached; inspect state before retrying.",
        );
      // Complete files are published by link/rename; private drafts never grant admission.
      if (/^draft-[a-f0-9-]{36}$/u.test(entry.name)) continue;
      const value = await this.read(entry.name);
      if (value) entries.push(value);
    }
    return entries;
  }

  async write(ticket: WorkloadTicket, initial = false): Promise<void> {
    await this.assertRoot();
    const file = join(this.directory, `ticket-${ticket.token}.json`);
    const draft = join(this.directory, `draft-${randomUUID()}`);
    const handle = await open(draft, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(ticket));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertRoot();
      if (initial) await link(draft, file);
      else await rename(draft, file);
    } finally {
      await unlink(draft).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }

  async remove(entry: StoredWorkloadTicket): Promise<void> {
    const current = await this.read(entry.file);
    if (!current) return;
    if (entry.identity !== current.identity)
      throw new Error(
        "Workload ticket changed; this ticket was not recovered.",
      );
    await this.assertRoot();
    await unlink(join(this.directory, entry.file)).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}
