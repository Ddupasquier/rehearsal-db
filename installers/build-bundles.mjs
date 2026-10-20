#!/usr/bin/env node
/** Deterministic source-only OS bundles. Does not build or install the product. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { CORE_VERSION } from "./shared/setup.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platforms = {
  windows: "setup.ps1",
  macos: "setup.command",
  linux: "setup.sh",
};

export const deterministicZip = (entries) => {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const entry of [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (
      !/^[a-zA-Z0-9_./-]+$/u.test(entry.name) ||
      entry.name
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsafe bundle entry.");
    const name = Buffer.from(entry.name),
      bytes = Buffer.from(entry.bytes),
      checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x2821, 12); // Fixed 2000-01-01 DOS date.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0x2821, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(
      ((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0,
      38,
    );
    directory.writeUInt32LE(offset, 42);
    chunks.push(local, name, bytes);
    central.push(directory, name);
    offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
};

export const buildSetupBundles = async (destination, root = repository) => {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (manifest.version !== CORE_VERSION)
    throw new Error(
      "Setup target and package version differ; update the maintained setup owner first.",
    );
  await mkdir(destination); // Existing output is never overwritten or removed.
  const results = [];
  for (const [platform, script] of Object.entries(platforms)) {
    const prefix = `rehearsal-setup-${platform}-${CORE_VERSION}`;
    const sources = [
      ["installers/README.md", "README.md"],
      ["LICENSE", "LICENSE"],
      ["installers/shared/setup.mjs", "shared/setup.mjs"],
      [`installers/${platform}/README.md`, `${platform}/README.md`],
      [`installers/${platform}/${script}`, `${platform}/${script}`],
    ];
    const entries = await Promise.all(
      sources.map(async ([source, path]) => ({
        name: `${prefix}/${path}`,
        bytes: await readFile(join(root, source)),
        executable: path.endsWith(".sh") || path.endsWith(".command"),
      })),
    );
    const bytes = deterministicZip(entries),
      filename = `${prefix}.zip`;
    await writeFile(join(destination, filename), bytes, { flag: "wx" });
    results.push({
      platform,
      filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  await writeFile(
    join(destination, "SHA256SUMS"),
    results.map((result) => `${result.sha256}  ${result.filename}\n`).join(""),
    { flag: "wx" },
  );
  return results;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = resolve(
    process.argv[2] ??
      join(repository, `test-results/setup-bundles-${CORE_VERSION}`),
  );
  await mkdir(dirname(output), { recursive: true });
  console.log(
    JSON.stringify(
      { output, bundles: await buildSetupBundles(output) },
      null,
      2,
    ),
  );
}
