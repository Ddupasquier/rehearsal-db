import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  symlink,
  link,
  chmod,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCommandCapabilities } from "../../../dist/src/project/command_capabilities.mjs";
import {
  inspectReceiptProvenance,
  parseRecordedRuntimeReceipt,
  RECEIPT_OBSERVATION_MAXIMUM_BYTES,
} from "../../../dist/src/project/receipt_provenance.mjs";
const recorded = () => ({
  formatVersion: 1,
  target: "postgresql",
  baselineGenerationId: "baseline-1",
  candidateSha256: "a".repeat(64),
  candidates: [
    { filename: "20260101000000_change.sql", sha256: "b".repeat(64) },
  ],
});
let root;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rehearsal-capabilities-"));
  await mkdir(join(root, "data"));
  await writeFile(
    join(root, "data", "receipt.json"),
    JSON.stringify(recorded()),
    { mode: 0o600 },
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("operation requirements are distinct from observations", () => {
  it("reports offline requirements without loading executable config or inferring a running service", async () => {
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      'throw Error("PRIVATE_CONFIG_EXECUTED");',
    );
    const report = await inspectCommandCapabilities({
      projectRoot: root,
      hostOptions: { platform: "darwin" },
      nodeVersion: "24.0.0",
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      assurance: "inspection",
      node: { major: 24, supported: true },
      receipt: {
        state: "not-requested",
        currentInputsMatch: "unknown",
        timestamp: null,
        liveState: "unknown",
      },
      safety: {
        projectConfigurationEvaluated: false,
        childProcessesStarted: false,
        enginesProbed: false,
        databaseObserved: false,
        filesWritten: false,
      },
    });
    expect(
      report.operations.find((r) => r.commands.includes("init")),
    ).toMatchObject({
      backend: "offline",
      supportState: "supported",
      availability: "unknown",
    });
    expect(
      report.operations.find((r) => r.commands.includes("run")),
    ).toMatchObject({
      backend: "container",
      availability: "unknown",
      assuranceWhenCompleted: "full",
    });
    expect(report.operations.find((r) => r.backend === "native")).toMatchObject(
      { supportState: "unsupported", availability: "unknown" },
    );
    expect(JSON.stringify(report)).not.toContain(root);
  });
  it("distinguishes actual impact measurement and mixed setup variants from offline inspection", async () => {
    const report = await inspectCommandCapabilities({
      projectRoot: root,
      hostOptions: { platform: "darwin" },
      nodeVersion: "24.0.0",
    });
    expect(
      report.operations.find((row) => row.commands.includes("inspect impact")),
    ).toMatchObject({
      backend: "offline",
      assuranceWhenCompleted: "inspection",
    });
    expect(
      report.operations.find((row) => row.commands.includes("measure impact")),
    ).toMatchObject({
      backend: "container",
      availability: "unknown",
      assuranceWhenCompleted: "partial",
    });
    expect(
      report.operations.find((row) => row.commands.includes("setup"))
        ?.requirements,
    ).toContain("optional-container-engine-observations");
    expect(
      report.operations.find((row) => row.commands.includes("setup --write")),
    ).toMatchObject({
      backend: "container",
      availability: "unknown",
      assuranceWhenCompleted: "inspection",
    });
    expect(
      report.operations.find((row) => row.commands.includes("setup --write"))
        ?.requirements,
    ).toContain("scaffolding-write-before-full-doctor");
  });
  it("keeps native Windows metadata available while runtime and receipt proof stay unqualified", async () => {
    const report = await inspectCommandCapabilities({
      projectRoot: root,
      receiptPath: "data/receipt.json",
      hostOptions: { platform: "win32" },
      nodeVersion: "24.0.0",
    });
    expect(report.operations[0]).toMatchObject({
      backend: "offline",
      supportState: "supported",
      availability: "available",
    });
    expect(
      report.operations.find((r) => r.commands.includes("run")),
    ).toMatchObject({
      supportState: "unsupported",
      availability: "unavailable",
    });
    expect(report.receipt).toMatchObject({
      state: "refused",
      reason: "host_filesystem_unqualified",
      target: null,
    });
  });
  it.each(["18.0.0", "bad"])(
    "does not qualify unsupported or unknown Node %s",
    async (nodeVersion) => {
      const report = await inspectCommandCapabilities({
        projectRoot: root,
        nodeVersion,
        hostOptions: { platform: "darwin" },
      });
      expect(report.node.supported).toBe(false);
      expect(report.operations[0]).toMatchObject({
        supportState: "unsupported",
        availability: "unknown",
        reason: "version_unqualified",
      });
    },
  );
});
describe("recorded receipt provenance never establishes freshness or current inputs", () => {
  it("returns only validated recorded fields, even for a self-claimed matching receipt", async () => {
    const report = await inspectReceiptProvenance({
      projectRoot: root,
      receiptPath: "data/receipt.json",
      filesystemQualified: true,
    });
    expect(report).toEqual({
      state: "observed",
      reason: "recorded_receipt_only",
      target: "postgresql",
      baselineGenerationId: "baseline-1",
      candidateSha256: "a".repeat(64),
      candidateCount: 1,
      timestamp: null,
      freshness: "unknown",
      currentInputsMatch: "unknown",
      liveState: "unknown",
    });
  });
  it.each([
    { formatVersion: 2 },
    { target: "hosted" },
    { baselineGenerationId: "../PRIVATE" },
    { candidateSha256: "PRIVATE" },
    { timestamp: "2026-01-01" },
    { extra: "PRIVATE" },
    { candidates: [{ filename: "../PRIVATE.sql", sha256: "b".repeat(64) }] },
    { candidates: [{ filename: "20260101000000_change.sql", sha256: "bad" }] },
    { candidates: [{ ...recorded().candidates[0], extra: true }] },
    { candidates: [recorded().candidates[0], recorded().candidates[0]] },
  ])("refuses malformed or future receipt %#", (patch) => {
    expect(() =>
      parseRecordedRuntimeReceipt({ ...recorded(), ...patch }),
    ).toThrow("Local receipt provenance could not be established.");
  });
  it.each([
    "../receipt.json",
    "/outside.json",
    "data/../receipt.json",
    "data\\receipt.json",
    "file:///PRIVATE",
    "data//receipt.json",
    "",
  ])("refuses unsafe selection %# without echoing it", async (receiptPath) => {
    const result = await inspectReceiptProvenance({
      projectRoot: root,
      receiptPath,
      filesystemQualified: true,
    });
    expect(result).toMatchObject({
      state: "refused",
      reason: "receipt_unverified",
      target: null,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("distinguishes absent receipt from malformed, linked, public-readable and oversized files", async () => {
    expect(
      await inspectReceiptProvenance({
        projectRoot: root,
        receiptPath: "data/absent.json",
        filesystemQualified: true,
      }),
    ).toMatchObject({ state: "missing", reason: "receipt_missing" });
    const path = join(root, "data", "bad.json");
    await writeFile(path, '{"PRIVATE":true}', { mode: 0o600 });
    expect(
      await inspectReceiptProvenance({
        projectRoot: root,
        receiptPath: "data/bad.json",
        filesystemQualified: true,
      }),
    ).toMatchObject({ state: "refused" });
    await symlink(
      join(root, "data", "receipt.json"),
      join(root, "data", "alias.json"),
    );
    expect(
      await inspectReceiptProvenance({
        projectRoot: root,
        receiptPath: "data/alias.json",
        filesystemQualified: true,
      }),
    ).toMatchObject({ state: "refused" });
    await link(
      join(root, "data", "receipt.json"),
      join(root, "data", "hard.json"),
    );
    expect(
      await inspectReceiptProvenance({
        projectRoot: root,
        receiptPath: "data/hard.json",
        filesystemQualified: true,
      }),
    ).toMatchObject({ state: "refused" });
    await rm(join(root, "data", "hard.json"));
    await chmod(path, 0o644);
    expect(
      await inspectReceiptProvenance({
        projectRoot: root,
        receiptPath: "data/bad.json",
        filesystemQualified: true,
      }),
    ).toMatchObject({ state: "refused" });
    await chmod(path, 0o600);
    await truncate(path, RECEIPT_OBSERVATION_MAXIMUM_BYTES + 1);
    expect(
      await inspectReceiptProvenance({
        projectRoot: root,
        receiptPath: "data/bad.json",
        filesystemQualified: true,
      }),
    ).toMatchObject({ state: "refused" });
  });
  it("refuses a symlinked receipt ancestry", async () => {
    await symlink(join(root, "data"), join(root, "alias"));
    expect(
      await inspectReceiptProvenance({
        projectRoot: root,
        receiptPath: "alias/receipt.json",
        filesystemQualified: true,
      }),
    ).toMatchObject({ state: "refused" });
  });
});
