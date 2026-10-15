import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertResourcePolicyAllowsStartup,
  evaluateResourcePolicy,
  readResourceReviewReceipt,
  writeResourceReviewReceipt,
} from "../../../dist/src/runtime/resource_policy.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const policy = {
  staleAfterSeconds: null,
  retainedEnvironmentCount: 2,
  maximumBytes: null,
  cleanupSchedule: "manual",
};
const inventory = (environments = [], state = "running") => ({
  engine: { state },
  environments,
});
const environment = (bytes, volumeCount = 1) => ({
  state: "stopped",
  containerCount: 1,
  volumeCount,
  diskUsageBytes: bytes,
});
const now = new Date("2026-10-13T12:00:00Z");

describe("resource policy", () => {
  it("keeps all resource operations disabled by default and limits advisory", () => {
    const status = evaluateResourcePolicy({
      inventory: inventory([environment(10), environment(20), environment(30)]),
      policy,
      now,
    });
    expect(status).toMatchObject({
      ownedVolumeBytes: 60,
      retainedEnvironmentCount: 3,
      quota: "disabled",
      cleanupReview: "manual",
    });
    expect(status.warnings[0]).toContain("no retained data was removed");
    expect(() => assertResourcePolicyAllowsStartup(status)).not.toThrow();
  });
  it("enforces exact quota boundary, and refuses unknown or incomplete measurements", () => {
    const limited = { ...policy, maximumBytes: 30 };
    const status = (entries, state) =>
      evaluateResourcePolicy({
        inventory: inventory(entries, state),
        policy: limited,
        now,
      });
    expect(() =>
      assertResourcePolicyAllowsStartup(
        status([environment(10), environment(20)]),
      ),
    ).not.toThrow();
    expect(() =>
      assertResourcePolicyAllowsStartup(status([environment(31)])),
    ).toThrow("exceed resources.maximumBytes");
    expect(() =>
      assertResourcePolicyAllowsStartup(status([environment(null)])),
    ).toThrow("cannot be verified");
    expect(() =>
      assertResourcePolicyAllowsStartup(status([], "stopped")),
    ).toThrow("cannot be verified");
    expect(status([environment(null, 0)])).toMatchObject({
      ownedVolumeBytes: 0,
      quota: "within-limit",
    });
    expect(
      status([{ ...environment(10), state: "unavailable" }]),
    ).toMatchObject({ ownedVolumeBytes: null, retainedEnvironmentCount: null });
  });
  it("uses bounded calendar review intervals without running a timer or cleanup", () => {
    const review = (schedule, previous) =>
      evaluateResourcePolicy({
        inventory: inventory(),
        policy: { ...policy, cleanupSchedule: schedule },
        lastReviewedAt: previous,
        now,
      });
    expect(review("daily-preview", null).cleanupReview).toBe("due");
    expect(review("daily-preview", "2026-10-12T12:00:00Z").cleanupReview).toBe(
      "due",
    );
    expect(review("daily-preview", "2026-10-13T11:00:00Z")).toMatchObject({
      cleanupReview: "scheduled",
      nextReviewAt: "2026-10-14T11:00:00.000Z",
    });
    expect(review("weekly-preview", "2026-10-12T12:00:00Z").cleanupReview).toBe(
      "scheduled",
    );
    expect(review("daily-preview", "2099-01-01T00:00:00Z").cleanupReview).toBe(
      "due",
    );
  });
  it("keeps owner-only review receipts project/policy-bound and repeatable", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-resource-policy-"));
    roots.push(root);
    const input = {
      path: join(root, "review.json"),
      projectRoot: root,
      policy,
      now,
    };
    await writeResourceReviewReceipt(input);
    expect(await readResourceReviewReceipt(input)).toBe(now.toISOString());
    await writeResourceReviewReceipt({
      ...input,
      now: new Date(now.getTime() - 1000),
    });
    expect(await readResourceReviewReceipt(input)).toBe(
      "2026-10-13T11:59:59.000Z",
    );
    expect(
      await readResourceReviewReceipt({
        ...input,
        projectRoot: `${root}-different`,
      }),
    ).toBeNull();
    expect(
      await readResourceReviewReceipt({
        ...input,
        policy: { ...policy, maximumBytes: 200 },
      }),
    ).toBeNull();
    await chmod(input.path, 0o644);
    expect(await readResourceReviewReceipt(input)).toBeNull();
    await expect(writeResourceReviewReceipt(input)).rejects.toThrow(
      "owner-only regular",
    );
    expect(JSON.parse(await readFile(input.path, "utf8")).schemaVersion).toBe(
      1,
    );
  });
  it("does not follow symlinks or trust malformed/future review receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-resource-receipt-"));
    roots.push(root);
    const original = join(root, "original.json");
    const input = { path: original, projectRoot: root, policy, now };
    await writeResourceReviewReceipt({ ...input, now: new Date("2099-01-01") });
    expect(await readResourceReviewReceipt(input)).toBeNull();
    const linked = join(root, "linked.json");
    await symlink(original, linked);
    expect(
      await readResourceReviewReceipt({ ...input, path: linked }),
    ).toBeNull();
    await expect(
      writeResourceReviewReceipt({ ...input, path: linked }),
    ).rejects.toThrow("owner-only regular");
    await writeFile(original, "not-json", { mode: 0o600 });
    expect(await readResourceReviewReceipt(input)).toBeNull();
  });
});
