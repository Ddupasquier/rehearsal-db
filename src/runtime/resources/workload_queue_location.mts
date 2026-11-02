/** Stable same-user/boot/process-namespace coordination; never use per-run TMPDIR. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

let scopePromise: Promise<string> | undefined;
const currentScope = async (): Promise<string> => {
  let identity: string;
  if (process.platform === "linux") {
    identity = `${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${await readlink("/proc/self/ns/pid")}`;
  } else if (process.platform === "darwin") {
    const { stdout } = await promisify(execFile)(
      "/usr/sbin/sysctl",
      ["-n", "kern.boottime"],
      {
        env: {},
        timeout: 1000,
        maxBuffer: 1024,
      },
    );
    const boot = /^\{ sec = (\d+), usec = (\d+) \}/u.exec(stdout);
    if (!boot)
      throw new Error(
        "Cannot establish the local workload queue boot identity.",
      );
    identity = `${boot[1]}:${boot[2]}`;
  } else {
    throw new Error(
      "The local workload queue requires macOS or Linux (including WSL).",
    );
  }
  return createHash("sha256")
    .update(`${process.platform}:${userInfo().uid}:${identity}`)
    .digest("hex");
};

export const workloadQueueDirectory = async (
  stateDirectory?: string,
): Promise<string> => {
  const home = userInfo().homedir;
  const root =
    stateDirectory ??
    process.env.REHEARSAL_USER_STATE_DIRECTORY ??
    (process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Rehearsal")
      : join(home, ".local", "state", "rehearsal"));
  if (!isAbsolute(root) || root.includes("\0"))
    throw new Error(
      "REHEARSAL_USER_STATE_DIRECTORY must be an absolute local state directory.",
    );
  scopePromise ??= currentScope();
  return join(root, "workloads-v1", await scopePromise);
};
