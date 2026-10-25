/** Synthetic local protocol exercise. Never uploads data or runs user commands. */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtemp,
  lstat,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = () =>
  new Error(
    "Synthetic managed request is invalid, expired, unconsented or outside the authorized quota.",
  );
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
export interface ManagedPrototypeRequest {
  schemaVersion: 1;
  tenant: string;
  project: string;
  syntheticFixture: "counter-v1";
  artifactSha256: string;
  baselineSha256: string;
  candidateSha256: string;
  expiresAt: string;
  retentionSeconds: number;
  maximumRuntimeMs: number;
  maximumInputBytes: number;
  maximumOldSpaceMiB: number;
  scenario: "success" | "worker-loss" | "cleanup-failure" | "timeout";
}
const fixture = Object.freeze(
  Array.from({ length: 100 }, (_, id) => ({ id, value: id * 2 })),
);
const bindings = Object.freeze({
  artifactSha256: hash("synthetic-core-artifact-v1"),
  baselineSha256: hash(fixture),
  candidateSha256: hash("synthetic-counter-proof-v1"),
});
export const managedPrototypeExample = (
  now = new Date(),
): ManagedPrototypeRequest => ({
  schemaVersion: 1,
  tenant: "synthetic-tenant",
  project: "synthetic-project",
  syntheticFixture: "counter-v1",
  ...bindings,
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  retentionSeconds: 0,
  maximumRuntimeMs: 1000,
  maximumInputBytes: 4096,
  maximumOldSpaceMiB: 32,
  scenario: "success",
});
export const planManagedPrototype = (
  input: unknown,
  authorizedTenant: string,
  now = new Date(),
) => {
  const value = input as ManagedPrototypeRequest;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      Object.keys(managedPrototypeExample(now)).sort().join(",") ||
    value.schemaVersion !== 1 ||
    typeof value.tenant !== "string" ||
    typeof value.project !== "string" ||
    !safeId.test(value.tenant) ||
    value.tenant !== authorizedTenant ||
    !safeId.test(value.project) ||
    value.syntheticFixture !== "counter-v1" ||
    Object.entries(bindings).some(
      ([key, digest]) => value[key as keyof typeof bindings] !== digest,
    ) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= now.getTime() ||
    Date.parse(value.expiresAt) > now.getTime() + 300_000 ||
    value.retentionSeconds !== 0 ||
    !Number.isSafeInteger(value.maximumRuntimeMs) ||
    value.maximumRuntimeMs < 10 ||
    value.maximumRuntimeMs > 5000 ||
    value.maximumInputBytes !== 4096 ||
    value.maximumOldSpaceMiB !== 32 ||
    !["success", "worker-loss", "cleanup-failure", "timeout"].includes(
      value.scenario,
    ) ||
    Buffer.byteLength(JSON.stringify(value)) > 4096
  )
    throw fail();
  // Fixed property order prevents JSON-key order from changing consent semantics.
  const request = Object.fromEntries(
    Object.keys(managedPrototypeExample(now)).map((key) => [
      key,
      value[key as keyof ManagedPrototypeRequest],
    ]),
  ) as unknown as ManagedPrototypeRequest;
  return Object.freeze({
    schemaVersion: 1 as const,
    mode: "synthetic-local-protocol" as const,
    request: Object.freeze(request),
    consentSha256: hash(request),
    uploadsData: false,
    hostedService: false,
    tenantIsolationCertified: false,
    estimatedProviderCost: null,
    memoryBudgetKind: "v8-old-space-limit" as const,
    hardProcessMemoryLimit: false,
    limitations: [
      "Synthetic process/contract exercise only; no database, network, customer input, hosted tenant isolation or provider cost certification. The old-space budget is not a hard process RSS limit.",
    ],
  });
};
export const readManagedPrototypeRequest = async (path: string) => {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 4096)
      throw fail();
    const handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const details = await handle.stat(),
        current = await lstat(path);
      if (
        !details.isFile() ||
        details.size > 4096 ||
        current.isSymbolicLink() ||
        details.dev !== before.dev ||
        details.ino !== before.ino ||
        details.dev !== current.dev ||
        details.ino !== current.ino
      )
        throw fail();
      const buffer = Buffer.alloc(4097);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          count,
          buffer.length - count,
          count,
        );
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > 4096) throw fail();
      const text = buffer.subarray(0, count).toString("utf8");
      if (!Buffer.from(text, "utf8").equals(buffer.subarray(0, count)))
        throw fail();
      const parsed = JSON.parse(text) as unknown;
      // The documented example command uses the normal public CLI envelope.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const result = parsed as Record<string, unknown>;
        if (
          result.schemaVersion === 1 &&
          result.command === "managed example" &&
          result.status === "success"
        )
          return result.data;
      }
      return parsed;
    } finally {
      await handle.close();
    }
  } catch {
    throw fail();
  }
};
const OWNER_MARKER = ".prototype-owner.json",
  RECOVERY_RECEIPT = ".prototype-recovery.json";
const recoveryFailure = () =>
  new Error(
    "Synthetic managed recovery refused: ownership, consent, private files or stopped-worker evidence changed; all unrelated material was preserved.",
  );
const recoveryFields = [
  "schemaVersion",
  "kind",
  "id",
  "root",
  "directoryName",
  "device",
  "inode",
  "markerSha256",
  "workerPid",
  "createdAt",
  "recoveryDueAt",
  "authenticationSha256",
] as const;
export interface ManagedPrototypeRecoveryRequest {
  schemaVersion: 1;
  kind: "synthetic-managed-recovery";
  id: string;
  root: string;
  directoryName: string;
  device: number;
  inode: number;
  markerSha256: string;
  workerPid: number | null;
  createdAt: string;
  recoveryDueAt: string;
  authenticationSha256: string;
}
export const planManagedPrototypeRecovery = (
  input: unknown,
  now = new Date(),
) => {
  const value = input as ManagedPrototypeRecoveryRequest;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      [...recoveryFields].sort().join(",") ||
    value.schemaVersion !== 1 ||
    value.kind !== "synthetic-managed-recovery" ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.id) ||
    typeof value.root !== "string" ||
    value.root.includes("\0") ||
    resolve(value.root) !== value.root ||
    typeof value.directoryName !== "string" ||
    !/^rehearsal-managed-prototype-[A-Za-z0-9]{6}$/u.test(
      value.directoryName,
    ) ||
    !Number.isSafeInteger(value.device) ||
    value.device < 0 ||
    !Number.isSafeInteger(value.inode) ||
    value.inode < 1 ||
    typeof value.markerSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.markerSha256) ||
    typeof value.authenticationSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.authenticationSha256) ||
    !(
      value.workerPid === null ||
      (Number.isSafeInteger(value.workerPid) && value.workerPid > 1)
    ) ||
    typeof value.createdAt !== "string" ||
    typeof value.recoveryDueAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.recoveryDueAt)) ||
    Date.parse(value.recoveryDueAt) <= Date.parse(value.createdAt) ||
    Date.parse(value.recoveryDueAt) - Date.parse(value.createdAt) >
      15 * 60 * 1000 ||
    Buffer.byteLength(JSON.stringify(value)) > 4096
  )
    throw recoveryFailure();
  const request = Object.fromEntries(
    recoveryFields.map((key) => [key, value[key]]),
  ) as unknown as ManagedPrototypeRecoveryRequest;
  return Object.freeze({
    request: Object.freeze(request),
    consentSha256: hash(request),
    overdue: now.getTime() >= Date.parse(request.recoveryDueAt),
    automaticDeletion: false as const,
  });
};
const privatePrototypeFile = async (path: string) => {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.mode & 0o077 ||
    (process.getuid && before.uid !== process.getuid())
  )
    throw recoveryFailure();
  const value = await readManagedPrototypeRequest(path),
    after = await lstat(path);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mode !== before.mode ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    throw recoveryFailure();
  return { value, identity: before };
};
export const recoverManagedPrototype = async ({
  input,
  consentSha256,
  root = tmpdir(),
}: {
  input: unknown;
  consentSha256: string;
  root?: string;
}) => {
  try {
    const plan = planManagedPrototypeRecovery(input),
      request = plan.request;
    if (
      consentSha256 !== plan.consentSha256 ||
      (await realpath(root)) !== request.root
    )
      throw recoveryFailure();
    const directory = join(request.root, request.directoryName);
    const validateDirectory = async () => {
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.dev !== request.device ||
        info.ino !== request.inode ||
        info.mode & 0o077 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw recoveryFailure();
    };
    await validateDirectory();
    const rootInfo = await lstat(request.root);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      rootInfo.mode & 0o077 ||
      (process.getuid && rootInfo.uid !== process.getuid())
    )
      throw recoveryFailure();
    const entries = await readdir(directory);
    if (
      entries.sort().join(",") !==
      [OWNER_MARKER, RECOVERY_RECEIPT].sort().join(",")
    )
      throw recoveryFailure();
    const marker = await privatePrototypeFile(join(directory, OWNER_MARKER));
    const owner = marker.value as {
      schemaVersion: number;
      kind: string;
      id: string;
      device: number;
      inode: number;
      authenticationKey: string;
    };
    if (
      !owner ||
      owner.schemaVersion !== 1 ||
      owner.kind !== "synthetic-managed-owner" ||
      owner.id !== request.id ||
      owner.device !== request.device ||
      owner.inode !== request.inode ||
      typeof owner.authenticationKey !== "string" ||
      !/^[a-f0-9]{64}$/u.test(owner.authenticationKey) ||
      hash(owner) !== request.markerSha256
    )
      throw recoveryFailure();
    const stored = await privatePrototypeFile(
      join(directory, RECOVERY_RECEIPT),
    );
    if (
      planManagedPrototypeRecovery(stored.value).consentSha256 !==
      plan.consentSha256
    )
      throw recoveryFailure();
    const { authenticationSha256, ...base } = request;
    const expected = createHmac(
      "sha256",
      Buffer.from(owner.authenticationKey, "hex"),
    )
      .update(JSON.stringify(base))
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(authenticationSha256, "hex")))
      throw recoveryFailure();
    if (request.workerPid !== null) {
      let gone = false;
      try {
        process.kill(request.workerPid, 0);
      } catch (error) {
        gone = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!gone) throw recoveryFailure();
    }
    // Delete only the two verified metadata files. Never recursively remove a new canary.
    for (const entry of [
      { name: RECOVERY_RECEIPT, identity: stored.identity },
      { name: OWNER_MARKER, identity: marker.identity },
    ]) {
      await validateDirectory();
      const current = await lstat(join(directory, entry.name));
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== entry.identity.dev ||
        current.ino !== entry.identity.ino ||
        current.mode !== entry.identity.mode ||
        current.size !== entry.identity.size ||
        current.mtimeMs !== entry.identity.mtimeMs ||
        current.ctimeMs !== entry.identity.ctimeMs
      )
        throw recoveryFailure();
      await unlink(join(directory, entry.name));
    }
    await validateDirectory();
    await rmdir(directory);
    return Object.freeze({
      schemaVersion: 1 as const,
      status: "recovered" as const,
      cleanup: "removed" as const,
      consentSha256: plan.consentSha256,
      overdue: plan.overdue,
      databasesChanged: false,
      processesStopped: false,
      automaticDeletion: false,
    });
  } catch {
    throw recoveryFailure();
  }
};

export const executeManagedPrototype = async ({
  input,
  authorizedTenant,
  consentSha256,
  signal,
  root = tmpdir(),
}: {
  input: unknown;
  authorizedTenant: string;
  consentSha256: string;
  signal?: AbortSignal;
  root?: string;
}) => {
  const plan = planManagedPrototype(input, authorizedTenant);
  if (consentSha256 !== plan.consentSha256 || signal?.aborted) throw fail();
  const parent = await lstat(resolve(root));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail();
  const canonicalRoot = await realpath(root);
  const directory = await mkdtemp(
    join(canonicalRoot, "rehearsal-managed-prototype-"),
  );
  const directoryIdentity = await lstat(directory);
  const marker = {
    schemaVersion: 1,
    kind: "synthetic-managed-owner",
    id: randomUUID(),
    device: directoryIdentity.dev,
    inode: directoryIdentity.ino,
    authenticationKey: randomBytes(32).toString("hex"),
  };
  let recovery: {
    receiptPath: string | null;
    request: ManagedPrototypeRecoveryRequest;
    consentSha256: string;
    recoveryDueAt: string;
    receiptState: "persisted" | "unavailable";
  } | null = null;
  const events: string[] = ["queued", "leased"];
  let status: "completed" | "failed" | "cancelled" | "quarantined" = "failed";
  let cleanup: "removed" | "retained" = "retained";
  let reason = "worker-failed";
  let ownedPid: number | null = null;
  let stopped = false;
  try {
    await writeFile(
      join(directory, OWNER_MARKER),
      JSON.stringify(marker) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    if (signal?.aborted) {
      status = "cancelled";
      reason = "cancelled";
    } else if (Date.now() >= Date.parse(plan.request.expiresAt))
      reason = "request-expired";
    else {
      events.push("running");
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=32",
          fileURLToPath(
            new URL("./managed_prototype_worker.mjs", import.meta.url),
          ),
        ],
        {
          cwd: directory,
          env: createCleanProcessEnvironment({
            inheritedEnvironment: {
              TMPDIR: directory,
              TMP: directory,
              TEMP: directory,
            },
          }),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      ownedPid = child.pid ?? null;
      let output = "",
        excessive = false,
        timedOut = false;
      const stop = () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      };
      const remainingExpiry = Math.max(
        0,
        Date.parse(plan.request.expiresAt) - Date.now(),
      );
      const expiresFirst = remainingExpiry <= plan.request.maximumRuntimeMs;
      const timeout = setTimeout(
        () => {
          timedOut = true;
          stop();
        },
        Math.min(plan.request.maximumRuntimeMs, remainingExpiry),
      );
      signal?.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length + chunk.length > 4096) {
          excessive = true;
          stop();
        } else output += chunk.toString("utf8");
      });
      child.stderr.on("data", () => undefined); // Raw worker errors never enter evidence.
      child.stdin.on("error", () => undefined);
      child.stdin.end(
        JSON.stringify({ scenario: plan.request.scenario, fixture }),
      );
      let spawnFailed = false;
      const code = await new Promise<number | null>((done) => {
        child.once("error", () => {
          spawnFailed = true;
        });
        child.once("close", done);
      });
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      stopped = child.exitCode !== null || child.signalCode !== null;
      if (signal?.aborted) {
        status = "cancelled";
        reason = "cancelled";
      } else if (timedOut)
        reason = expiresFirst ? "request-expired" : "deadline";
      else if (Date.now() >= Date.parse(plan.request.expiresAt))
        reason = "request-expired";
      else if (code === 0 && !excessive && !spawnFailed) {
        events.push("verifying");
        try {
          const proof = JSON.parse(output) as { rows: number; sha256: string };
          if (
            proof &&
            Object.keys(proof).sort().join(",") === "rows,sha256" &&
            proof.rows === 100 &&
            proof.sha256 === bindings.baselineSha256
          ) {
            status = "completed";
            reason = "synthetic-proof-passed";
          }
        } catch {
          /* Invalid/partial evidence is failure. */
        }
      }
    }
  } finally {
    events.push("cleaning");
    // Deliberate failure injection proves that successful work cannot mask missing cleanup.
    if (
      plan.request.scenario !== "cleanup-failure" &&
      (ownedPid === null || stopped)
    ) {
      try {
        await rm(directory, { recursive: true });
        cleanup = "removed";
      } catch {
        status = "quarantined";
        reason = "cleanup-unconfirmed";
      }
    } else {
      status = "quarantined";
      reason = "cleanup-unconfirmed";
    }
    if (cleanup === "retained") {
      const now = new Date(),
        base = {
          schemaVersion: 1 as const,
          kind: "synthetic-managed-recovery" as const,
          id: marker.id,
          root: canonicalRoot,
          directoryName: directory.slice(canonicalRoot.length + 1),
          device: directoryIdentity.dev,
          inode: directoryIdentity.ino,
          markerSha256: hash(marker),
          workerPid: ownedPid,
          createdAt: now.toISOString(),
          recoveryDueAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
        };
      const request: ManagedPrototypeRecoveryRequest = {
        ...base,
        authenticationSha256: createHmac(
          "sha256",
          Buffer.from(marker.authenticationKey, "hex"),
        )
          .update(JSON.stringify(base))
          .digest("hex"),
      };
      const receiptPath = join(directory, RECOVERY_RECEIPT),
        planned = planManagedPrototypeRecovery(request);
      recovery = {
        receiptPath,
        request,
        consentSha256: planned.consentSha256,
        recoveryDueAt: request.recoveryDueAt,
        receiptState: "persisted",
      };
      try {
        await writeFile(receiptPath, JSON.stringify(request) + "\n", {
          mode: 0o600,
          flag: "wx",
        });
      } catch {
        recovery = {
          ...recovery,
          receiptPath: null,
          receiptState: "unavailable",
        };
      }
    }
  }
  events.push(status);
  return Object.freeze({
    schemaVersion: 1 as const,
    mode: plan.mode,
    status,
    reason,
    cleanup,
    consentSha256: plan.consentSha256,
    events,
    ownedWorkerStopped: stopped,
    retainedDirectory: cleanup === "retained" ? directory : null,
    expiry:
      cleanup === "retained"
        ? "retained-until-explicit-owned-recovery"
        : "not-applicable",
    recovery,
    recoveryDueAt: recovery?.recoveryDueAt ?? null,
    automaticDeletion: false,
    uploadsData: false,
    providerCost: null,
    tenantIsolationCertified: false,
    memoryBudgetKind: plan.memoryBudgetKind,
    hardProcessMemoryLimit: false,
  });
};
