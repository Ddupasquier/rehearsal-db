/** Fixed worker policy. Image metadata was reviewed; runtime qualification is independent. */
import { createHash } from "node:crypto";
export const KNEX_WORKER_POLICY = Object.freeze({
  schemaVersion: 1,
  kind: "knex-isolated-worker",
  nodeVersion: "24.21.0",
  image:
    "node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20",
  memoryBytes: 268435456,
  tmpfsBytes: 67108864,
  pids: 32,
  cpus: 1,
  network: "none",
  readOnlyRoot: true,
  uid: 65532,
  logDriver: "none",
  deadlineMs: 120000,
  historicalFileChecksums: "unavailable",
} as const);
export const KNEX_WORKER_POLICY_SHA256 = createHash("sha256")
  .update(JSON.stringify(KNEX_WORKER_POLICY))
  .digest("hex");
export const KNEX_WORKER_PLATFORM_IMAGES = Object.freeze({
  amd64: {
    manifest:
      "sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd",
    config:
      "sha256:470015c1ab1577c19efce2e80cdad4afd9c682cf8f4dcf3dccae5abfd9113397",
  },
  arm64: {
    manifest:
      "sha256:ba6b7d0ee561d9d49deb99e2b93c98632cc287b6cca1a6b18d66127054efa4dc",
    config:
      "sha256:683727a317323c89635f1c9584c722c91dbfa0741cbfb9e2468162867aaf31f7",
  },
});
