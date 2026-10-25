import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  lstat,
  chmod,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreCopyChunks } from "../../../dist/src/runtime/restore_cache.mjs";
import { encodeBaselineRecordForCopy } from "../../../dist/src/runtime/restore.mjs";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "restore-copy-"));
  roots.push(root);
  const rows = [
    JSON.stringify({ table: "items", row: { id: 1, value: "quoted\trow\n€" } }),
    JSON.stringify({
      schema: "private",
      table: "items",
      row: { id: 2, related_id: 1, value: null },
    }),
  ];
  const text = rows.join("\n") + "\n";
  const dataPath = join(root, "source.ndjson");
  await writeFile(dataPath, text, { mode: 0o600 });
  return {
    root,
    rows,
    text,
    input: {
      artifactRoot: root,
      dataPath,
      generationId: "fixture-v1",
      sourceSha256: sha(text),
      sanitizationPolicySha256: "a".repeat(64),
      target: "postgresql",
      policy: { enabled: true, maximumBytes: 100000, minimumFreeBytes: 1 },
    },
  };
};
const collect = async (result) => {
  let text = "";
  for await (const chunk of result.chunks) text += chunk;
  return text;
};
describe("verified immutable COPY encoding reuse", () => {
  it("reuses exact rows/foreign keys without re-sanitizing or reordering", async () => {
    const { input, rows } = await fixture();
    const first = await restoreCopyChunks(input);
    expect(first.state).toBe("created");
    const expected = rows
      .map((row) => encodeBaselineRecordForCopy(row) + "\n")
      .join("");
    expect(await collect(first)).toBe(expected);
    const second = await restoreCopyChunks(input);
    expect(second.state).toBe("verified-hit");
    expect(await collect(second)).toBe(expected);
  });
  it("does not trust corrupt payload or receipt and fully regenerates", async () => {
    const { input, root } = await fixture();
    const original = await collect(await restoreCopyChunks(input));
    const cache = join(root, "restore-cache"),
      names = await readdir(cache);
    const payload = join(
      cache,
      names.find((name) => name.endsWith(".copy")),
    );
    await writeFile(payload, "corrupt", { mode: 0o600 });
    const repaired = await restoreCopyChunks(input);
    expect(repaired.state).toBe("created");
    expect(await collect(repaired)).toBe(original);
    const receipt = join(
      cache,
      names.find((name) => name.endsWith(".json")),
    );
    await writeFile(receipt, "{}", { mode: 0o600 });
    expect((await restoreCopyChunks(input)).state).toBe("created");
  });
  it("refuses changed source instead of serving previously valid cached rows", async () => {
    const { input } = await fixture();
    await restoreCopyChunks(input);
    await writeFile(input.dataPath, '{"table":"items","row":{"id":9}}\n');
    await expect(restoreCopyChunks(input)).rejects.toThrow(
      /Baseline input changed/,
    );
  });
  it("binds core encoder, target, policy, source and immutable generation", async () => {
    const { input } = await fixture();
    await restoreCopyChunks(input);
    expect(
      (await restoreCopyChunks({ ...input, target: "supabase" })).state,
    ).toBe("created");
    expect(
      (await restoreCopyChunks({ ...input, generationId: "fixture-v2" })).state,
    ).toBe("created");
    expect(
      (
        await restoreCopyChunks({
          ...input,
          sanitizationPolicySha256: "b".repeat(64),
        })
      ).state,
    ).toBe("created");
  });
  it("falls back on insufficient disk/budget while retaining all source rows", async () => {
    const { input, rows } = await fixture();
    const expected = rows
      .map((x) => encodeBaselineRecordForCopy(x) + "\n")
      .join("");
    const lowDisk = await restoreCopyChunks({
      ...input,
      policy: { ...input.policy, minimumFreeBytes: Number.MAX_SAFE_INTEGER },
    });
    expect(lowDisk.state).toBe("safe-fallback");
    expect(await collect(lowDisk)).toBe(expected);
    const small = await restoreCopyChunks({
      ...input,
      policy: { ...input.policy, maximumBytes: 1 },
    });
    expect(small.state).toBe("safe-fallback");
    expect(await collect(small)).toBe(expected);
  });
  it("never follows an unsafe cache symlink or overwrites foreign material", async () => {
    const { input, root } = await fixture();
    const other = await mkdtemp(join(tmpdir(), "cache-sentinel-"));
    roots.push(other);
    const sentinel = join(other, "sentinel");
    await writeFile(sentinel, "preserved");
    await symlink(other, join(root, "restore-cache"));
    const value = await restoreCopyChunks(input);
    expect(value.state).toBe("safe-fallback");
    expect(await collect(value)).not.toContain("preserved");
    expect(await readFile(sentinel, "utf8")).toBe("preserved");
  });
  it("supports concurrent identical builders and cancellation without partial published bytes", async () => {
    const { input, root } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => restoreCopyChunks(input)),
    );
    const rows = await Promise.all(results.map(collect));
    expect(new Set(rows).size).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      restoreCopyChunks({ ...input, signal: controller.signal }),
    ).rejects.toThrow();
    expect(
      (await readdir(join(root, "restore-cache"))).some((name) =>
        name.endsWith(".tmp"),
      ),
    ).toBe(false);
  });
  it("keeps existing streaming behavior and avoids allocation when disabled", async () => {
    const { input, root } = await fixture();
    const result = await restoreCopyChunks({
      ...input,
      policy: { enabled: false },
    });
    expect(result.state).toBe("disabled");
    expect(await readdir(root)).toEqual(["source.ndjson"]);
    expect(await collect(result)).not.toBe("");
  });

  it("checks cancellation when prepared created/hit/fallback iterators are consumed", async () => {
    for (const kind of ["created", "verified-hit", "safe-fallback"]) {
      const { input } = await fixture();
      if (kind === "verified-hit")
        await collect(await restoreCopyChunks(input));
      const controller = new AbortController();
      const prepared = await restoreCopyChunks({
        ...input,
        signal: controller.signal,
        ...(kind === "safe-fallback"
          ? { policy: { ...input.policy, maximumBytes: 1 } }
          : {}),
      });
      expect(prepared.state).toBe(kind);
      controller.abort();
      await expect(collect(prepared)).rejects.toThrow();
    }
  });

  it("yields bounded COPY chunks and checks abort between chunks", async () => {
    const { input } = await fixture();
    const source =
      JSON.stringify({
        table: "items",
        row: { id: 1, value: "€".repeat(70000) },
      }) + "\n";
    await writeFile(input.dataPath, source, { mode: 0o600 });
    const controller = new AbortController();
    const prepared = await restoreCopyChunks({
      ...input,
      sourceSha256: sha(source),
      policy: { enabled: true, maximumBytes: 1000000, minimumFreeBytes: 1 },
      signal: controller.signal,
    });
    const iterator = prepared.chunks[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(Buffer.byteLength(first.value)).toBeLessThanOrEqual(65536);
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
    await iterator.return?.();
  });

  it("refuses source growth or symlink replacement after preparation without following it", async () => {
    const { input, root } = await fixture();
    const prepared = await restoreCopyChunks(input);
    await writeFile(input.dataPath, "x".repeat(100001));
    await expect(collect(prepared)).rejects.toThrow(
      /COPY file|Baseline input changed/,
    );
    const outside = join(root, "outside-source");
    await writeFile(outside, "outside preserved");
    await rm(input.dataPath);
    await symlink(outside, input.dataPath);
    await expect(restoreCopyChunks(input)).rejects.toThrow(
      /regular immutable baseline/,
    );
    expect(await readFile(outside, "utf8")).toBe("outside preserved");
  });

  it("oversized fallback verifies and streams the same descriptor and catches later drift", async () => {
    const { input, rows } = await fixture();
    const small = {
      ...input,
      policy: { enabled: true, maximumBytes: 1, minimumFreeBytes: 1 },
    };
    const prepared = await restoreCopyChunks(small);
    expect(prepared.state).toBe("safe-fallback");
    expect(await collect(prepared)).toBe(
      rows.map((row) => encodeBaselineRecordForCopy(row) + "\n").join(""),
    );
    const changed = await restoreCopyChunks(small);
    await writeFile(input.dataPath, '{"table":"items","row":{"id":999}}\n');
    await expect(collect(changed)).rejects.toThrow(
      /COPY file|Baseline input changed/,
    );
  });

  it("bounds TOTAL retained bytes across generations and never evicts unrelated entries", async () => {
    const { input, root } = await fixture();
    const maximumBytes = 2500;
    let created = 0,
      refused = 0;
    for (let generation = 0; generation < 20; generation++) {
      const value = await restoreCopyChunks({
        ...input,
        generationId: `generation-${generation}`,
        policy: { enabled: true, maximumBytes, minimumFreeBytes: 1 },
      });
      if (value.state === "created") created++;
      else refused++;
      await collect(value);
      const entries = await readdir(join(root, "restore-cache"));
      const sizes = await Promise.all(
        entries.map((name) =>
          lstat(join(root, "restore-cache", name)).then((info) => info.size),
        ),
      );
      expect(
        sizes.reduce((total, size) => total + size, 0),
      ).toBeLessThanOrEqual(maximumBytes);
    }
    expect(created).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(
      (await readdir(join(root, "restore-cache"))).some((name) =>
        name.endsWith(".tmp"),
      ),
    ).toBe(false);
  });

  it("authenticates input/output bindings and rejects a self-consistent forged receipt", async () => {
    const { input, root } = await fixture();
    const expected = await collect(await restoreCopyChunks(input));
    const cache = join(root, "restore-cache"),
      entries = await readdir(cache);
    const authentication = join(cache, ".authentication-key");
    expect((await readFile(authentication)).length).toBe(32);
    expect((await lstat(authentication)).mode & 0o777).toBe(0o600);
    const dataPath = join(
      cache,
      entries.find((name) => name.endsWith(".copy")),
    );
    const receiptPath = join(
      cache,
      entries.find((name) => name.endsWith(".json")),
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const wrong = "public\titems\te30=\n";
    receipt.bytes = Buffer.byteLength(wrong);
    receipt.sha256 = sha(wrong);
    await writeFile(dataPath, wrong, { mode: 0o600 });
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const repaired = await restoreCopyChunks(input);
    expect(repaired.state).toBe("created");
    expect(await collect(repaired)).toBe(expected);
    await chmod(authentication, 0o644);
    const refused = await restoreCopyChunks(input);
    expect(refused.state).toBe("safe-fallback");
    expect(await collect(refused)).toBe(expected);
    expect((await lstat(authentication)).mode & 0o777).toBe(0o644);
  });

  it("never steals foreign writer locks and falls back without deleting their bytes", async () => {
    const { input, root } = await fixture();
    const expected = await collect(await restoreCopyChunks(input));
    const lock = join(root, "restore-cache", ".writer-lock");
    await writeFile(lock, "retained foreign writer", { mode: 0o600 });
    const value = await restoreCopyChunks({
      ...input,
      generationId: "new-generation",
    });
    expect(value.state).toBe("safe-fallback");
    expect(await collect(value)).toBe(expected);
    expect(await readFile(lock, "utf8")).toBe("retained foreign writer");
  });
});
