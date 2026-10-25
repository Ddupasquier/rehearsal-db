import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const removal = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return {
    ...actual,
    rm: (...args) => {
      if (
        removal.fail &&
        String(args[0]).includes("/rehearsal-managed-prototype-")
      )
        return Promise.reject(new Error("PRIVATE cleanup failure"));
      return actual.rm(...args);
    },
  };
});

import {
  executeManagedPrototype,
  managedPrototypeExample,
  planManagedPrototype,
  readManagedPrototypeRequest,
  planManagedPrototypeRecovery,
  recoverManagedPrototype,
} from "../../../dist/src/runtime/managed_prototype.mjs";

const roots = [];
const makeRoot = async () => {
  const path = await mkdtemp(join(tmpdir(), "managed-protocol-test-"));
  roots.push(path);
  return path;
};
const run = (input, root, extra = {}) =>
  executeManagedPrototype({
    input,
    authorizedTenant: input.tenant,
    consentSha256: planManagedPrototype(input, input.tenant).consentSha256,
    root,
    ...extra,
  });
afterEach(async () => {
  removal.fail = false;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("explicitly synthetic managed protocol", () => {
  it("binds consent to exact normalized inputs and declares memory/isolation limits", () => {
    const input = managedPrototypeExample();
    const first = planManagedPrototype(input, input.tenant);
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    expect(planManagedPrototype(reversed, input.tenant).consentSha256).toBe(
      first.consentSha256,
    );
    expect(
      planManagedPrototype({ ...input, project: "changed" }, input.tenant)
        .consentSha256,
    ).not.toBe(first.consentSha256);
    expect(first.request.maximumOldSpaceMiB).toBe(32);
    expect(first.hardProcessMemoryLimit).toBe(false);
    expect(first.tenantIsolationCertified).toBe(false);
    expect(first.uploadsData).toBe(false);
    for (const invalid of [
      { ...input, tenant: "other" },
      { ...input, project: 123 },
      { ...input, project: undefined },
      { ...input, maximumOldSpaceMiB: 33 },
      { ...input, maximumRuntimeMs: 5001 },
      { ...input, maximumInputBytes: 4097 },
      { ...input, retentionSeconds: 1 },
      { ...input, artifactSha256: "wrong" },
      { ...input, expiresAt: new Date(Date.now() - 1000).toISOString() },
      { ...input, expiresAt: new Date(Date.now() + 600000).toISOString() },
      { ...input, sourceUrl: "PRIVATE" },
    ])
      expect(() => planManagedPrototype(invalid, input.tenant)).toThrow(
        /Synthetic managed request/,
      );
  });

  it("refuses malformed/oversized/symlink requests without exposing source bytes", async () => {
    const root = await makeRoot(),
      path = join(root, "request.json");
    await writeFile(path, JSON.stringify(managedPrototypeExample()));
    expect((await readManagedPrototypeRequest(path)).syntheticFixture).toBe(
      "counter-v1",
    );
    await symlink(path, join(root, "linked.json"));
    await expect(
      readManagedPrototypeRequest(join(root, "linked.json")),
    ).rejects.toThrow(/Synthetic managed request/);
    await writeFile(path, "PRIVATE".repeat(1024));
    await expect(readManagedPrototypeRequest(path)).rejects.toThrow(
      /Synthetic managed request/,
    );
    await writeFile(path, "PRIVATE malformed JSON");
    await expect(readManagedPrototypeRequest(path)).rejects.toThrow(
      "Synthetic managed request is invalid, expired, unconsented or outside the authorized quota.",
    );
  });

  it("runs only its fixed proof, strips ambient process hooks and removes owned work", async () => {
    const root = await makeRoot(),
      input = managedPrototypeExample();
    const old = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--require=/PRIVATE/must-not-execute.cjs";
    try {
      const value = await run(input, root);
      expect(value.status).toBe("completed");
      expect(value.cleanup).toBe("removed");
      expect(value.ownedWorkerStopped).toBe(true);
      expect(value.events).toEqual([
        "queued",
        "leased",
        "running",
        "verifying",
        "cleaning",
        "completed",
      ]);
      expect(value.hardProcessMemoryLimit).toBe(false);
      expect(JSON.stringify(value)).not.toContain("PRIVATE");
      expect(await readdir(root)).toEqual([]);
    } finally {
      if (old === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = old;
    }
  });

  it("refuses changed consent and cancellation before allocating a workspace", async () => {
    const root = await makeRoot(),
      input = managedPrototypeExample(),
      controller = new AbortController();
    await expect(run(input, root, { consentSha256: "wrong" })).rejects.toThrow(
      /Synthetic managed request/,
    );
    controller.abort();
    await expect(
      run(input, root, { signal: controller.signal }),
    ).rejects.toThrow(/Synthetic managed request/);
    expect(await readdir(root)).toEqual([]);
  });

  it("returns failed worker-loss and deadline outcomes only after the worker stops", async () => {
    for (const scenario of ["worker-loss", "timeout"]) {
      const root = await makeRoot(),
        input = {
          ...managedPrototypeExample(),
          scenario,
          maximumRuntimeMs: scenario === "timeout" ? 150 : 1000,
        };
      const value = await run(input, root);
      expect(value.status).toBe("failed");
      expect(value.reason).toBe(
        scenario === "timeout" ? "deadline" : "worker-failed",
      );
      expect(value.ownedWorkerStopped).toBe(true);
      expect(value.cleanup).toBe("removed");
      expect(await readdir(root)).toEqual([]);
    }
  });

  it("cancels an active owned worker and honors request expiry during execution", async () => {
    const root = await makeRoot(),
      controller = new AbortController();
    const input = {
      ...managedPrototypeExample(),
      scenario: "timeout",
      maximumRuntimeMs: 3000,
    };
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const value = await run(input, root, { signal: controller.signal });
      expect(value.status).toBe("cancelled");
      expect(value.cleanup).toBe("removed");
      expect(value.ownedWorkerStopped).toBe(true);
    } finally {
      clearTimeout(timer);
    }
    const expiry = {
      ...input,
      expiresAt: new Date(Date.now() + 100).toISOString(),
    };
    const expired = await run(expiry, root);
    expect(expired.status).toBe("failed");
    expect(expired.reason).toBe("request-expired");
    expect(expired.cleanup).toBe("removed");
    expect(await readdir(root)).toEqual([]);
  });

  it("never reports completed work as successful when injected or actual removal fails", async () => {
    for (const actualFailure of [false, true]) {
      const root = await makeRoot();
      removal.fail = actualFailure;
      try {
        const input = {
          ...managedPrototypeExample(),
          scenario: actualFailure ? "success" : "cleanup-failure",
        };
        const value = await run(input, root);
        expect(value.status).toBe("quarantined");
        expect(value.reason).toBe("cleanup-unconfirmed");
        expect(value.cleanup).toBe("retained");
        expect(value.ownedWorkerStopped).toBe(true);
        expect(
          value.retainedDirectory.startsWith(
            join(root, "rehearsal-managed-prototype-"),
          ),
        ).toBe(true);
        expect(value.events.at(-1)).toBe("quarantined");
        expect(JSON.stringify(value)).not.toContain("PRIVATE");
      } finally {
        removal.fail = false;
      }
    }
  });

  it("records a finite explicit recovery deadline and recovers only its exact owned synthetic directory", async () => {
    const root = await makeRoot(),
      foreign = join(root, "foreign-sentinel");
    await writeFile(foreign, "preserve unrelated data");
    removal.fail = true;
    let value;
    try {
      value = await run(managedPrototypeExample(), root);
    } finally {
      removal.fail = false;
    }
    expect(value.status).toBe("quarantined");
    expect(value.recovery.receiptState).toBe("persisted");
    expect(value.automaticDeletion).toBe(false);
    const input = await readManagedPrototypeRequest(value.recovery.receiptPath);
    expect(
      Date.parse(input.recoveryDueAt) - Date.parse(input.createdAt),
    ).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(Date.parse(input.recoveryDueAt)).toBeGreaterThan(
      Date.parse(input.createdAt),
    );
    const overdue = planManagedPrototypeRecovery(
      input,
      new Date(Date.parse(input.recoveryDueAt) + 1),
    );
    expect(overdue.overdue).toBe(true);
    expect(overdue.automaticDeletion).toBe(false);
    expect((await readdir(value.retainedDirectory)).sort()).toEqual([
      ".prototype-owner.json",
      ".prototype-recovery.json",
    ]);
    const recovered = await recoverManagedPrototype({
      input,
      consentSha256: value.recovery.consentSha256,
      root,
    });
    expect(recovered.status).toBe("recovered");
    expect(recovered.cleanup).toBe("removed");
    expect(recovered.processesStopped).toBe(false);
    expect(await readFile(foreign, "utf8")).toBe("preserve unrelated data");
    expect(await readdir(root)).toEqual(["foreign-sentinel"]);
  });

  it("refuses wrong consent, unexpected canaries, path escapes and stale on-disk recovery", async () => {
    const root = await makeRoot();
    const value = await run(
      { ...managedPrototypeExample(), scenario: "cleanup-failure" },
      root,
    );
    const input = value.recovery.request,
      consentSha256 = value.recovery.consentSha256;
    await expect(
      recoverManagedPrototype({ input, consentSha256: "wrong", root }),
    ).rejects.toThrow(/recovery refused/);
    const canary = join(value.retainedDirectory, "unexpected-canary");
    await writeFile(canary, "preserved");
    await expect(
      recoverManagedPrototype({ input, consentSha256, root }),
    ).rejects.toThrow(/recovery refused/);
    expect(await readFile(canary, "utf8")).toBe("preserved");
    expect(await readdir(value.retainedDirectory)).toHaveLength(3);
    await rm(canary);
    expect(() =>
      planManagedPrototypeRecovery({ ...input, directoryName: "../foreign" }),
    ).toThrow(/recovery refused/);
    const changed = { ...input, workerPid: process.pid };
    await writeFile(value.recovery.receiptPath, JSON.stringify(changed), {
      mode: 0o600,
    });
    await expect(
      recoverManagedPrototype({ input, consentSha256, root }),
    ).rejects.toThrow(/recovery refused/);
    expect(await readdir(value.retainedDirectory)).toHaveLength(2);
  });

  it("refuses replacement directory inodes and never follows a recovery symlink", async () => {
    const root = await makeRoot();
    const value = await run(
      { ...managedPrototypeExample(), scenario: "cleanup-failure" },
      root,
    );
    const moved = value.retainedDirectory + "-original";
    await rename(value.retainedDirectory, moved);
    await mkdir(value.retainedDirectory, { mode: 0o700 });
    await expect(
      recoverManagedPrototype({
        input: value.recovery.request,
        consentSha256: value.recovery.consentSha256,
        root,
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await readdir(moved)).toHaveLength(2);
    await rm(value.retainedDirectory, { recursive: true });
    await symlink(moved, value.retainedDirectory);
    await expect(
      recoverManagedPrototype({
        input: value.recovery.request,
        consentSha256: value.recovery.consentSha256,
        root,
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(await readdir(moved)).toHaveLength(2);
  });

  it("refuses a still-live worker even with an authentic exact receipt and never kills it", async () => {
    const root = await makeRoot();
    const value = await run(
      { ...managedPrototypeExample(), scenario: "cleanup-failure" },
      root,
    );
    const marker = JSON.parse(
      await readFile(
        join(value.retainedDirectory, ".prototype-owner.json"),
        "utf8",
      ),
    );
    const { authenticationSha256: unused, ...base } = {
      ...value.recovery.request,
      workerPid: process.pid,
    };
    void unused;
    const input = {
      ...base,
      authenticationSha256: createHmac(
        "sha256",
        Buffer.from(marker.authenticationKey, "hex"),
      )
        .update(JSON.stringify(base))
        .digest("hex"),
    };
    await writeFile(value.recovery.receiptPath, JSON.stringify(input), {
      mode: 0o600,
    });
    await expect(
      recoverManagedPrototype({
        input,
        consentSha256: planManagedPrototypeRecovery(input).consentSha256,
        root,
      }),
    ).rejects.toThrow(/recovery refused/);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(await readdir(value.retainedDirectory)).toHaveLength(2);
  });
});

it("consumes its own public managed-example JSON envelope as a proposal", async () => {
  const root = await makeRoot();
  const path = join(root, "proposal.json");
  const request = managedPrototypeExample();
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      rehearsalVersion: "test",
      command: "managed example",
      status: "success",
      data: request,
    }),
    { mode: 0o600 },
  );
  expect(await readManagedPrototypeRequest(path)).toEqual(request);
  expect(
    planManagedPrototype(
      await readManagedPrototypeRequest(path),
      "synthetic-tenant",
    ).request,
  ).toEqual(request);
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      command: "managed prototype",
      status: "success",
      data: request,
    }),
  );
  const wrongEnvelope = await readManagedPrototypeRequest(path);
  expect(() => planManagedPrototype(wrongEnvelope, "synthetic-tenant")).toThrow(
    /invalid/,
  );
});
