/** Copy and verify local Supabase Storage objects during an identity claim. */

import { createHash } from "node:crypto";
import { assertLoopbackUrl } from "../shared/process_environment.mjs";

const BUCKET = /^[a-z0-9][a-z0-9.-]{0,99}$/u;
const MAXIMUM_VERIFICATION_BYTES = 100 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface StorageObjectReceipt {
  readonly bytes: number;
  readonly sha256: string;
}

export interface SupabaseStorageTransfer {
  copyAndVerify(input: {
    bucket: string;
    source: string;
    destination: string;
  }): Promise<StorageObjectReceipt>;
  remove(input: { bucket: string; paths: readonly string[] }): Promise<void>;
}

const objectPath = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("A Storage identity-claim path is unsafe.");
  }
  return value.split("/").map(encodeURIComponent).join("/");
};

const readVerifiedObject = async ({
  fetchImpl,
  baseUrl,
  headers,
  bucket,
  path,
}: {
  fetchImpl: typeof fetch;
  baseUrl: string;
  headers: Readonly<Record<string, string>>;
  bucket: string;
  path: string;
}): Promise<StorageObjectReceipt> => {
  const response = await fetchImpl(
    `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath(path)}?rehearsal=${Date.now()}`,
    {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Supabase Storage could not read an identity-claim object (HTTP ${response.status}).`,
    );
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > MAXIMUM_VERIFICATION_BYTES
  ) {
    throw new Error(
      "A Storage identity-claim object exceeds the 100 MiB verification limit.",
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAXIMUM_VERIFICATION_BYTES) {
    throw new Error(
      "A Storage identity-claim object exceeds the 100 MiB verification limit.",
    );
  }
  return Object.freeze({
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
};

export const createSupabaseStorageTransfer = ({
  url,
  serviceRoleKey,
  fetchImpl = globalThis.fetch,
}: {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): SupabaseStorageTransfer => {
  assertLoopbackUrl("Rehearsal Supabase Storage", url);
  if (typeof serviceRoleKey !== "string" || !serviceRoleKey) {
    throw new Error(
      "The local runtime environment has no Storage service key.",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch implementation is required for Storage transfer.");
  }
  const baseUrl = url.replace(/\/$/u, "");
  const headers = Object.freeze({
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
  });
  const removePaths = async ({
    bucket,
    paths,
  }: {
    bucket: string;
    paths: readonly string[];
  }): Promise<void> => {
    if (!BUCKET.test(bucket ?? "") || !Array.isArray(paths) || !paths.length) {
      throw new Error("A Storage identity-claim removal is invalid.");
    }
    paths.forEach(objectPath);
    const response = await fetchImpl(
      `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`,
      {
        method: "DELETE",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: paths }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Supabase Storage could not remove identity-claim objects (HTTP ${response.status}).`,
      );
    }
  };
  return Object.freeze({
    async copyAndVerify({
      bucket,
      source,
      destination,
    }: {
      bucket: string;
      source: string;
      destination: string;
    }): Promise<StorageObjectReceipt> {
      if (!BUCKET.test(bucket ?? "")) {
        throw new Error("A Storage identity-claim bucket is invalid.");
      }
      objectPath(source);
      objectPath(destination);
      if (source === destination) {
        throw new Error("A Storage identity-claim copy must change the path.");
      }
      const sourceReceipt = await readVerifiedObject({
        fetchImpl,
        baseUrl,
        headers,
        bucket,
        path: source,
      });
      try {
        const response = await fetchImpl(`${baseUrl}/storage/v1/object/copy`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            bucketId: bucket,
            sourceKey: source,
            destinationKey: destination,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(
            `Supabase Storage could not copy an identity-claim object (HTTP ${response.status}).`,
          );
        }
        const destinationReceipt = await readVerifiedObject({
          fetchImpl,
          baseUrl,
          headers,
          bucket,
          path: destination,
        });
        if (
          sourceReceipt.bytes !== destinationReceipt.bytes ||
          sourceReceipt.sha256 !== destinationReceipt.sha256
        ) {
          throw new Error(
            "Supabase Storage copied an identity object with a different byte digest.",
          );
        }
        return destinationReceipt;
      } catch (error) {
        try {
          await removePaths({ bucket, paths: [destination] });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Storage identity-copy verification failed and destination cleanup needs attention.",
          );
        }
        throw error;
      }
    },
    remove: removePaths,
  });
};
