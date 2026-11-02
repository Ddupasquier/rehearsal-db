/** Create and verify the owner-only secret used by deterministic privacy rules. */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const PRIVACY_KEY_BYTES = 32;
const HEX_64 = /^[a-f0-9]{64}$/u;

export const createPrivacyKey = async (
  path: string,
): Promise<{ fingerprint: string }> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(PRIVACY_KEY_BYTES);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${key.toString("base64")}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  return { fingerprint: createHash("sha256").update(key).digest("hex") };
};

export const readPrivacyKey = async (path: string): Promise<Buffer> => {
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new Error("Privacy key must be an owner-only regular file.");
  }
  const encoded = (await readFile(path, "utf8")).trim();
  const key = Buffer.from(encoded, "base64");
  if (
    key.length !== PRIVACY_KEY_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new Error("Privacy key file is invalid.");
  }
  return key;
};

export const assertPrivacyKeyFingerprint = (
  key: Uint8Array,
  expected: unknown,
): void => {
  if (typeof expected !== "string" || !HEX_64.test(expected)) {
    throw new Error("Privacy key fingerprint is invalid.");
  }
  const actual = createHash("sha256").update(key).digest("hex");
  if (actual !== expected) {
    throw new Error(
      "Privacy key does not match the reviewed baseline receipt.",
    );
  }
};
