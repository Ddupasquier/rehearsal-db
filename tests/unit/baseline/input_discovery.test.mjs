import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverBaselineInputFiles } from "../../../dist/src/baseline/input_discovery.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("baseline input discovery", () => {
  it("finds and prioritizes structurally valid project-local inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-discovery-test-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, "rehearsal"), { recursive: true }),
      mkdir(join(root, "examples"), { recursive: true }),
      mkdir(join(root, "node_modules/hidden"), { recursive: true }),
      mkdir(join(root, ".rehearsal/private"), { recursive: true }),
    ]);
    const privateValue = "private-value-that-must-never-be-returned";
    const record = JSON.stringify({
      table: "widgets",
      row: { id: 1, secret: privateValue },
    });
    const ledger = JSON.stringify([
      {
        version: "20261001000000",
        name: "create_widgets",
        statements: ["create table widgets(id bigint)"],
      },
    ]);
    const assets = JSON.stringify([
      { bucket: "files", objectPath: "proof.txt", file: "proof.txt" },
    ]);
    await Promise.all([
      writeFile(join(root, "rehearsal/synthetic-data.ndjson"), `${record}\n`),
      writeFile(join(root, "examples/alternate.ndjson"), `${record}\n`),
      writeFile(join(root, "rehearsal/migration-ledger.json"), ledger),
      writeFile(join(root, "examples/ledger.json"), ledger),
      writeFile(join(root, "rehearsal/assets.json"), assets),
      writeFile(join(root, "package.json"), JSON.stringify({ name: "ignore" })),
      writeFile(
        join(root, "node_modules/hidden/private.ndjson"),
        `${record}\n`,
      ),
      writeFile(join(root, ".rehearsal/private/secret.json"), ledger),
    ]);

    const result = await discoverBaselineInputFiles({ projectRoot: root });

    expect(result).toEqual({
      records: ["rehearsal/synthetic-data.ndjson", "examples/alternate.ndjson"],
      ledgers: ["rehearsal/migration-ledger.json", "examples/ledger.json"],
      assetManifests: ["rehearsal/assets.json"],
    });
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(JSON.stringify(result)).not.toContain("node_modules");
    expect(JSON.stringify(result)).not.toContain(".rehearsal");
  });

  it("skips malformed and unrelated JSON files", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-discovery-test-"));
    roots.push(root);
    await Promise.all([
      writeFile(join(root, "bad.json"), "{"),
      writeFile(join(root, "empty.json"), "[]"),
      writeFile(
        join(root, "unrelated.json"),
        JSON.stringify({ hello: "world" }),
      ),
      writeFile(join(root, "bad.ndjson"), "not json\n"),
    ]);

    await expect(
      discoverBaselineInputFiles({ projectRoot: root }),
    ).resolves.toEqual({ records: [], ledgers: [], assetManifests: [] });
  });
});

it("identifies bounded native ledger metadata without loading configuration or SQL", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-ledger-discovery-"));
  roots.push(root);
  await mkdir(join(root, "rehearsal"));
  await writeFile(
    join(root, "rehearsal/drizzle-ledger.json"),
    JSON.stringify([
      { id: 1, hash: "a".repeat(64), created_at: "1720000000000" },
      { id: 3, hash: "b".repeat(64), created_at: "1720000001000" },
    ]),
  );
  await writeFile(
    join(root, "rehearsal/prisma-ledger.json"),
    JSON.stringify([
      {
        migration_name: "20261026000000_init",
        checksum: "c".repeat(64),
        finished_at: "2026-10-26T00:00:00Z",
        rolled_back_at: null,
      },
    ]),
  );
  await writeFile(
    join(root, "drizzle.config.cjs"),
    'throw new Error("must never execute discovery config");',
  );
  const result = await discoverBaselineInputFiles({ projectRoot: root });
  expect(result.ledgers).toEqual([
    "rehearsal/drizzle-ledger.json",
    "rehearsal/prisma-ledger.json",
  ]);
});
