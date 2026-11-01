/** Assertions against an already verified baseline; never a replacement for payload verification. */
import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { basename } from "node:path";
import { holdPathAncestry } from "../../shared/held_path_ancestry.mjs";
import { resolveActiveBaselinePaths } from "../../baseline/artifact.mjs";
import type { BaselineManifest } from "../../baseline/artifact.mjs";

/** Compare freshly verified manifests; this does not replace artifact verification. */
export const assertActiveBaselineUnchanged = (
  expected: BaselineManifest,
  current: BaselineManifest,
): void => {
  if (!isDeepStrictEqual(expected, current))
    throw new Error(
      "The active baseline changed after review; refresh before continuing.",
    );
};

/** Native-only late identity assertion, not fresh payload verification or a filesystem sandbox. */
export const assertNativeBaselineManifestUnchanged = async ({
  artifactRoot,
  expected,
}: {
  artifactRoot: string;
  expected: BaselineManifest;
}): Promise<void> => {
  if (![3, 4, 5].includes(expected.formatVersion))
    throw new Error("Late native baseline identity requires format 3, 4 or 5.");
  const paths = await resolveActiveBaselinePaths({ artifactRoot });
  if (basename(paths.generationDirectory) !== expected.generationId)
    throw new Error(
      "The active baseline changed after review; refresh before continuing.",
    );
  const held = await holdPathAncestry(paths.generationDirectory);
  try {
    const handle = await open(
      paths.manifestPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 8 * 1024 * 1024)
        throw new Error(
          "Native baseline manifest identity is unavailable or exceeds 8 MiB.",
        );
      const bytes = Buffer.alloc(before.size + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const part = await handle.read(
          bytes,
          bytesRead,
          bytes.length - bytesRead,
          bytesRead,
        );
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      const after = await handle.stat(),
        leaf = await lstat(paths.manifestPath);
      if (
        bytesRead !== before.size ||
        !leaf.isFile() ||
        leaf.isSymbolicLink() ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.ino !== leaf.ino ||
        after.dev !== leaf.dev ||
        after.size !== leaf.size ||
        after.mtimeMs !== leaf.mtimeMs ||
        after.ctimeMs !== leaf.ctimeMs
      )
        throw new Error(
          "Native baseline manifest changed during its identity read.",
        );
      let current: BaselineManifest;
      try {
        current = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, bytesRead),
          ),
        ) as BaselineManifest;
      } catch {
        throw new Error(
          "Native baseline manifest identity is unavailable or invalid.",
        );
      }
      assertActiveBaselineUnchanged(expected, current);
    } finally {
      await handle.close();
    }
    await held.assertUnchanged();
    const final = await resolveActiveBaselinePaths({ artifactRoot });
    if (
      final.generationDirectory !== paths.generationDirectory ||
      final.manifestPath !== paths.manifestPath
    )
      throw new Error(
        "The active baseline changed after review; refresh before continuing.",
      );
    await held.assertUnchanged();
  } finally {
    await held.close();
  }
};
