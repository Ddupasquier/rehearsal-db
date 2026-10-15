import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectEnvironmentProvenance } from "../../../dist/src/runtime/resource_provenance.mjs";
import { REHEARSAL_VERSION } from "../../../dist/src/shared/diagnostics.mjs";

const roots = [];
const generation = "20261015T120000Z-abcdef123456";
const secret = "SECRET-MUST-NOT-LEAVE-RUNTIME-RECEIPT";
const marker = {
  formatVersion: 1,
  target: "postgresql",
  generationId: generation,
  dataSha256: "a".repeat(64),
  rehearsalVersion: "0.1.0-rc.4",
  databasePassword: secret,
  unexpected: { privateData: secret },
};
const candidate = {
  formatVersion: 1,
  target: "postgresql",
  baselineGenerationId: generation,
  candidateSha256: "b".repeat(64),
  candidates: [],
  unsafe: secret,
};
const setup = async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rehearsal-provenance-"));
  roots.push(projectRoot);
  const runtimeWorkdir = join(projectRoot, ".rehearsal/runtime");
  await mkdir(runtimeWorkdir, { recursive: true });
  return {
    projectRoot,
    runtimeWorkdir,
    provider: "postgresql",
    ports: { database: 58322 },
    applicationUrl: "http://[::1]:5175/app",
  };
};
const receipts = async (fixture, baseline = marker, migration = candidate) => {
  await writeFile(
    join(fixture.runtimeWorkdir, "baseline.json"),
    JSON.stringify(baseline),
  );
  await writeFile(
    join(fixture.runtimeWorkdir, "candidate-receipt.json"),
    JSON.stringify(migration),
  );
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("recorded environment provenance", () => {
  it("projects exact target-local receipts without secrets or a fresh verification claim", async () => {
    const fixture = await setup();
    await receipts(fixture);
    const result = await inspectEnvironmentProvenance(fixture);
    expect(result).toEqual({
      schemaVersion: 1,
      inspectorVersion: REHEARSAL_VERSION,
      verification: "recorded-not-reverified",
      configuredPorts: [
        { service: "database", host: "127.0.0.1", port: 58322 },
        { service: "application", host: "[::1]", port: 5175 },
      ],
      runtime: {
        rehearsalVersion: "0.1.0-rc.4",
        versionReason: null,
        baselineGenerationId: generation,
        baselineDataSha256: "a".repeat(64),
        candidateSha256: "b".repeat(64),
        migrationReason: null,
      },
      runtimeReason: null,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(fixture.projectRoot);
    expect(
      JSON.parse(
        await readFile(join(fixture.runtimeWorkdir, "baseline.json"), "utf8"),
      ),
    ).toEqual(marker);
  });
  it("does not substitute inspector version for legacy creator version", async () => {
    const fixture = await setup();
    const { rehearsalVersion: _version, ...legacy } = marker;
    await receipts(fixture, legacy);
    expect((await inspectEnvironmentProvenance(fixture)).runtime).toMatchObject(
      { rehearsalVersion: null, versionReason: "not-recorded" },
    );
  });
  it("handles missing engine-independent receipts and refuses malformed or wrong-provider facts", async () => {
    const fixture = await setup();
    expect(await inspectEnvironmentProvenance(fixture)).toMatchObject({
      runtime: null,
      runtimeReason: "receipt-unavailable",
    });
    for (const invalid of [
      { ...marker, target: "supabase" },
      { ...marker, dataSha256: secret },
      { ...marker, formatVersion: "1" },
      { ...marker, rehearsalVersion: secret },
    ]) {
      await receipts(fixture, invalid);
      expect(await inspectEnvironmentProvenance(fixture)).toMatchObject({
        runtime: null,
        runtimeReason: "receipt-invalid",
      });
    }
  });
  it("keeps different generations and providers from lending a migration digest", async () => {
    const fixture = await setup();
    for (const invalid of [
      { ...candidate, target: "supabase" },
      { ...candidate, baselineGenerationId: "20261014T120000Z-abcdef123456" },
      { ...candidate, candidateSha256: secret },
    ]) {
      await receipts(fixture, marker, invalid);
      expect(
        (await inspectEnvironmentProvenance(fixture)).runtime,
      ).toMatchObject({
        candidateSha256: null,
        migrationReason: "receipt-does-not-match-baseline",
      });
    }
  });
  it("refuses symlink files, escaping directories and oversized receipt input", async () => {
    const fixture = await setup();
    const outside = await setup();
    await receipts(outside);
    await symlink(
      join(outside.runtimeWorkdir, "baseline.json"),
      join(fixture.runtimeWorkdir, "baseline.json"),
    );
    expect((await inspectEnvironmentProvenance(fixture)).runtimeReason).toBe(
      "receipt-unavailable",
    );
    expect(
      (
        await inspectEnvironmentProvenance({
          ...fixture,
          runtimeWorkdir: outside.runtimeWorkdir,
        })
      ).runtimeReason,
    ).toBe("receipt-unavailable");
    await rm(join(fixture.runtimeWorkdir, "baseline.json"));
    await writeFile(
      join(fixture.runtimeWorkdir, "baseline.json"),
      JSON.stringify({ ...marker, extra: secret.repeat(3000) }),
    );
    expect((await inspectEnvironmentProvenance(fixture)).runtimeReason).toBe(
      "receipt-unavailable",
    );
  });
  it("projects all providers' configured loopback service ports but never URLs or unsafe endpoints", async () => {
    const fixture = await setup();
    await receipts(
      fixture,
      { ...marker, target: undefined },
      { ...candidate, target: "supabase" },
    );
    expect(
      (
        await inspectEnvironmentProvenance({
          ...fixture,
          provider: "supabase",
          ports: { api: 58321, database: 58322, studio: 58323 },
          applicationUrl: "http://localhost:5175/",
        })
      ).configuredPorts,
    ).toHaveLength(4);
    for (const applicationUrl of [
      "https://production.example:5175/",
      "http://user:secret@localhost:5175/",
      "http://localhost:5175/?token=secret",
      "file:///private/file",
      "http://localhost:80/",
    ])
      expect(
        (await inspectEnvironmentProvenance({ ...fixture, applicationUrl }))
          .configuredPorts,
      ).toEqual([{ service: "database", host: "127.0.0.1", port: 58322 }]);
  });
});
