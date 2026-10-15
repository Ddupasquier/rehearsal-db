/** Repository-local unsigned settings witness; publication additionally authenticates owner approval. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { controlsWitnessDigest } from "./controls_witness.mjs";

export const controlsWitnessUrl = new URL(
  "../../.github/release-controls.json",
  import.meta.url,
);

export async function readControlsWitness() {
  const file = await open(
    controlsWitnessUrl,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 16384)
      throw new Error("Release witness refused: invalid_file.");
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16384)
      throw new Error("Release witness refused: file_bound.");
    const witness = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    controlsWitnessDigest(witness);
    return witness;
  } finally {
    await file.close();
  }
}
