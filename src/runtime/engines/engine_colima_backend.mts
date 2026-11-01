/** Qualified macOS Colima default-profile proof; never starts, deletes or claims a VM. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createCleanProcessEnvironment } from "../../shared/process_environment.mjs";

export interface EngineMetadataResult {
  status: number | null;
  stdout: string;
  stderr?: string;
}
export type EngineMetadataRunner = (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => EngineMetadataResult;
export interface ColimaBackendOptions {
  environment: NodeJS.ProcessEnv;
  run: EngineMetadataRunner;
  platform: NodeJS.Platform;
  architecture: string;
}
interface DiskIdentity {
  path: string;
  dev: string;
  ino: string;
  size: string;
}
interface ProcessIdentity {
  pid: number;
  parentPid: number;
  start: string;
  executable: string;
}
export interface QualifiedColimaProof {
  profile: "default";
  environment: NodeJS.ProcessEnv;
  endpoint: string;
  bootId: string;
  daemonId: string;
  vm: ProcessIdentity;
  hostAgent: ProcessIdentity;
  disks: DiskIdentity[];
  configurationSha256: string;
  identity: string;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = () => new Error("Colima profile ownership could not be verified.");
const safeText = (result: EngineMetadataResult, maximum = 65536) => {
  if (
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    Buffer.byteLength(result.stdout) > maximum
  )
    throw fail();
  return result.stdout.trim();
};
const ownedDirectory = async (path: string) => {
  if (
    !isAbsolute(path) ||
    /[\r\n\0]/u.test(path) ||
    (await realpath(path)) !== path
  )
    throw fail();
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== userInfo().uid ||
    s.mode & 0o022
  )
    throw fail();
  return path;
};
const boundedFile = async (path: string, maximum: number) => {
  if ((await realpath(path)) !== path) throw fail();
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== userInfo().uid ||
    before.mode & 0o022 ||
    before.size < 1 ||
    before.size > maximum
  )
    throw fail();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await file.stat();
    if (
      !s.isFile() ||
      s.dev !== before.dev ||
      s.ino !== before.ino ||
      s.size !== before.size ||
      s.uid !== before.uid ||
      s.mode !== before.mode
    )
      throw fail();
    const bytes = Buffer.alloc(s.size + 1),
      r = await file.read(bytes, 0, bytes.length, 0),
      after = await file.stat(),
      current = await lstat(path);
    if (
      r.bytesRead !== s.size ||
      after.size !== s.size ||
      after.mtimeMs !== s.mtimeMs ||
      after.ctimeMs !== s.ctimeMs ||
      current.dev !== s.dev ||
      current.ino !== s.ino ||
      current.mtimeMs !== s.mtimeMs ||
      current.ctimeMs !== s.ctimeMs ||
      (await realpath(path)) !== path
    )
      throw fail();
    return bytes.subarray(0, s.size);
  } finally {
    await file.close();
  }
};
export const colimaProfileEnvironment = async (
  options: ColimaBackendOptions,
) => {
  const raw = options.environment;
  if (raw.COLIMA_PROFILE !== undefined && raw.COLIMA_PROFILE !== "default")
    throw fail();
  const home = await ownedDirectory(raw.HOME ?? userInfo().homedir);
  const colima = await ownedDirectory(raw.COLIMA_HOME ?? join(home, ".colima"));
  const lima = await ownedDirectory(raw.LIMA_HOME ?? join(colima, "_lima"));
  const environment = createCleanProcessEnvironment({
    inheritedEnvironment: raw,
    overrides: {
      HOME: home,
      COLIMA_HOME: colima,
      LIMA_HOME: lima,
      COLIMA_PROFILE: "default",
    },
  });
  if (raw.DOCKER_CONFIG)
    environment.DOCKER_CONFIG = await ownedDirectory(raw.DOCKER_CONFIG);
  return {
    environment,
    colima,
    lima,
    endpoint: `unix://${colima}/default/docker.sock`,
  };
};
export const readColimaDefaultState = (
  run: EngineMetadataRunner,
  environment: NodeJS.ProcessEnv,
): "running" | "stopped" => {
  const output = safeText(run("colima", ["list", "--json"], environment));
  const lines = output.split("\n").filter(Boolean);
  if (lines.length > 32) throw fail();
  const profiles = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  if (
    profiles.some(
      (p) => typeof p.name !== "string" || typeof p.status !== "string",
    )
  )
    throw fail();
  const defaults = profiles.filter((p) => p.name === "default");
  if (defaults.length !== 1) throw fail();
  if (defaults[0]!.status === "Running") return "running";
  if (defaults[0]!.status === "Stopped") return "stopped";
  throw fail();
};
export const parseEngineProcessTable = (output: string): ProcessIdentity[] => {
  if (Buffer.byteLength(output) > 1024 * 1024) throw fail();
  const lines = output.split("\n").filter((l) => l.trim());
  if (lines.length > 8192) throw fail();
  const seen = new Set<number>();
  return lines.map((line) => {
    const m =
      /^\s*([1-9]\d{0,8})\s+(\d{1,9})\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([^\r\n]+?)\s*$/u.exec(
        line,
      );
    if (!m) throw fail();
    const pid = Number(m[1]);
    if (seen.has(pid)) throw fail();
    seen.add(pid);
    return {
      pid,
      parentPid: Number(m[2]),
      start: m[3]!.replace(/\s+/gu, " "),
      executable: basename(m[4]!),
    };
  });
};
const processRows = (options: ColimaBackendOptions) =>
  parseEngineProcessTable(
    safeText(
      options.run("/bin/ps", ["-axo", "pid=,ppid=,lstart=,comm="], {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        TZ: "UTC",
      }),
      1024 * 1024,
    ),
  );
const inspectDisks = async (lima: string): Promise<DiskIdentity[]> =>
  Promise.all(
    [join(lima, "colima/disk"), join(lima, "_disks/colima/datadisk")].map(
      async (path) => {
        if ((await realpath(path)) !== path) throw fail();
        const s = await lstat(path, { bigint: true });
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          s.uid !== BigInt(userInfo().uid) ||
          s.size <= 0n ||
          s.mode & 0o022n
        )
          throw fail();
        return {
          path,
          dev: String(s.dev),
          ino: String(s.ino),
          size: String(s.size),
        };
      },
    ),
  );
export const diskHolderPids = (
  output: string,
  disks: readonly DiskIdentity[],
): number[] => {
  if (Buffer.byteLength(output) > 65536) throw fail();
  const lines = output.split("\n").filter(Boolean);
  if (lines.length > 4096) throw fail();
  const held = new Map<number, Set<string>>();
  let pid = 0,
    entry: Record<string, string> = {};
  const flush = () => {
    if (!Object.keys(entry).length) return;
    if (!pid || !entry.f || !entry.D || !entry.i || !entry.n) throw fail();
    const disk = disks.find((d) => d.path === entry.n);
    if (!disk) throw fail();
    if (
      !/^(?:0x[a-f0-9]+|\d+)$/iu.test(entry.D) ||
      !/^\d+$/u.test(entry.i) ||
      String(BigInt(entry.D)) !== disk.dev ||
      String(BigInt(entry.i)) !== disk.ino
    )
      throw fail();
    const set = held.get(pid) ?? new Set<string>();
    set.add(disk.path);
    held.set(pid, set);
    entry = {};
  };
  for (const line of lines) {
    const key = line[0]!,
      value = line.slice(1);
    if (key === "p") {
      flush();
      if (!/^[1-9]\d{0,8}$/u.test(value)) throw fail();
      pid = Number(value);
    } else if (key === "c") {
      if (!pid || value.length > 256) throw fail();
    } else if (key === "f") {
      flush();
      if (!/^\d+[a-zA-Z]*$/u.test(value)) throw fail();
      entry = { f: value };
    } else if (["D", "i", "n"].includes(key)) {
      if (!entry.f || entry[key] !== undefined) throw fail();
      entry[key] = value;
    } else throw fail();
  }
  flush();
  return [...held]
    .filter(([, set]) => disks.every((d) => set.has(d.path)))
    .map(([p]) => p);
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const COLIMA_GUEST_DAEMON_ID_ARGUMENTS = [
  "ssh",
  "--",
  "/usr/bin/env",
  "-i",
  "PATH=/usr/bin:/bin",
  "docker",
  "--host",
  "unix:///var/run/docker.sock",
  "info",
  "--format",
  "{{.ID}}",
] as const;
export async function qualifyColimaDefault(
  options: ColimaBackendOptions,
  expectedEndpoint: string,
  expectedDaemonId: string,
): Promise<QualifiedColimaProof> {
  if (options.platform !== "darwin" || options.architecture !== "arm64")
    throw fail();
  const homes = await colimaProfileEnvironment(options);
  if (homes.endpoint !== expectedEndpoint) throw fail();
  const version = safeText(
    options.run("colima", ["version"], homes.environment),
    4096,
  );
  if (!/^colima version 0\.10\.3(?:\s|$)/u.test(version)) throw fail();
  if (readColimaDefaultState(options.run, homes.environment) !== "running")
    throw fail();
  const config = await boundedFile(
    join(homes.colima, "default/colima.yaml"),
    131072,
  );
  if (!/^vmType:[\t ]*vz[\t ]*$/mu.test(config.toString("utf8"))) throw fail();
  const generated = await boundedFile(
    join(homes.lima, "colima/lima.yaml"),
    131072,
  );
  const forwards =
    /^portForwards:[\t ]*\n([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9]*:|$(?![\s\S]))/mu.exec(
      generated.toString("utf8"),
    )?.[1];
  if (!forwards) throw fail();
  const decode = (value: string) =>
    value.startsWith('"')
      ? (JSON.parse(value) as unknown)
      : value.startsWith("'")
        ? value.slice(1, -1).replaceAll("''", "'")
        : value;
  const sockets = forwards.split(/\n(?= {4}- )/u).flatMap((block) => {
    const guest =
      /^ {4}(?:- )guestSocket:[\t ]*(.+)$/mu.exec(block)?.[1] ??
      /^ {6}guestSocket:[\t ]*(.+)$/mu.exec(block)?.[1];
    const host = /^ {6}hostSocket:[\t ]*(.+)$/mu.exec(block)?.[1];
    return guest
      ? [
          {
            guest: decode(guest.trim()),
            host: host ? decode(host.trim()) : null,
          },
        ]
      : [];
  });
  const dockerSockets = sockets.filter(
    (pair) => pair.guest === "/var/run/docker.sock",
  );
  const primary = homes.endpoint.slice("unix://".length),
    legacy = join(homes.colima, "docker.sock");
  if (
    dockerSockets.length < 1 ||
    dockerSockets.length > 2 ||
    dockerSockets.filter((pair) => pair.host === primary).length !== 1 ||
    dockerSockets.filter((pair) => pair.host === legacy).length > 1 ||
    dockerSockets.some((pair) => pair.host !== primary && pair.host !== legacy)
  )
    throw fail();
  const bootId = safeText(
    options.run(
      "colima",
      ["ssh", "--", "cat", "/proc/sys/kernel/random/boot_id"],
      homes.environment,
    ),
    128,
  );
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(bootId))
    throw fail();
  const daemonId = safeText(
    options.run("colima", COLIMA_GUEST_DAEMON_ID_ARGUMENTS, homes.environment),
    256,
  );
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(expectedDaemonId) ||
    daemonId !== expectedDaemonId
  )
    throw fail();
  const pid = Number(
    (await boundedFile(join(homes.lima, "colima/ha.pid"), 32))
      .toString("utf8")
      .trim(),
  );
  if (!Number.isSafeInteger(pid) || pid <= 1) throw fail();
  const before = processRows(options),
    hostAgent = before.find((p) => p.pid === pid && p.executable === "limactl");
  if (!hostAgent) throw fail();
  const disks = await inspectDisks(homes.lima);
  const holders = () =>
    diskHolderPids(
      safeText(
        options.run(
          "/usr/sbin/lsof",
          ["-nP", "-FpcfDin", "--", ...disks.map((d) => d.path)],
          { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", TZ: "UTC" },
        ),
      ),
      disks,
    );
  const first = holders(),
    after = processRows(options);
  const candidates = after.filter(
    (p) =>
      first.includes(p.pid) &&
      [
        "Virtualization.VirtualMachine",
        "com.apple.Virtualization.VirtualMachine",
      ].includes(p.executable),
  );
  if (candidates.length !== 1) throw fail();
  const vm = candidates[0]!;
  if (
    !before.some((p) => same(p, vm)) ||
    !after.some((p) => same(p, hostAgent)) ||
    !same(disks, await inspectDisks(homes.lima))
  )
    throw fail();
  if (!same(first, holders()) || !processRows(options).some((p) => same(p, vm)))
    throw fail();
  const configurationSha256 = createHash("sha256")
    .update(config)
    .update(generated)
    .digest("hex");
  const proof = {
    profile: "default" as const,
    environment: homes.environment,
    endpoint: homes.endpoint,
    bootId,
    daemonId,
    vm,
    hostAgent,
    disks,
    configurationSha256,
  };
  return {
    ...proof,
    identity: hash({ vm, hostAgent, disks, configurationSha256, daemonId }),
  };
}
export async function confirmColimaStopped(
  options: ColimaBackendOptions,
  proof: QualifiedColimaProof,
): Promise<{ profileStopped: boolean; vmProcessAbsent: boolean }> {
  const homes = await colimaProfileEnvironment(options);
  if (homes.endpoint !== proof.endpoint) throw fail();
  const profileStopped =
    readColimaDefaultState(options.run, homes.environment) === "stopped";
  const rows = processRows(options);
  const originalAbsent = !rows.some(
    (p) => p.pid === proof.vm.pid && p.start === proof.vm.start,
  );
  const disks = await inspectDisks(homes.lima);
  if (!same(disks, proof.disks)) throw fail();
  const holders = options.run(
    "/usr/sbin/lsof",
    ["-nP", "-FpcfDin", "--", ...disks.map((d) => d.path)],
    { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", TZ: "UTC" },
  );
  return {
    profileStopped,
    vmProcessAbsent:
      originalAbsent &&
      holders.status === 1 &&
      holders.stdout.trim() === "" &&
      holders.stderr === "",
  };
}
/** Already-stopped needs the same two known disks with no holders, not failed Docker. */
export async function inspectStoppedColimaDefault(
  options: ColimaBackendOptions,
): Promise<boolean> {
  if (options.platform !== "darwin" || options.architecture !== "arm64")
    return false;
  const homes = await colimaProfileEnvironment(options);
  if (readColimaDefaultState(options.run, homes.environment) !== "stopped")
    return false;
  const disks = await inspectDisks(homes.lima),
    holders = options.run(
      "/usr/sbin/lsof",
      ["-nP", "-FpcfDin", "--", ...disks.map((d) => d.path)],
      { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", TZ: "UTC" },
    );
  return (
    holders.status === 1 &&
    holders.stdout.trim() === "" &&
    holders.stderr === ""
  );
}
