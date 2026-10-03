import { describe, expect, it } from "vitest";
import { createSupabaseStorageTransfer } from "../../../src/identity/storage.mjs";

const response = (body, options = {}) =>
  new Response(body, { status: 200, ...options });

describe("identity Storage transfer", () => {
  it("copies through the local Storage API and verifies exact bytes", async () => {
    const requests = [];
    const transfer = createSupabaseStorageTransfer({
      url: "http://127.0.0.1:54321",
      serviceRoleKey: "local-service-key",
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith("/storage/v1/object/copy")) {
          return response(JSON.stringify({ Key: "new/avatar.webp" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "http://127.0.0.1:54321/storage/v1/object/avatars") {
          return response("[]", {
            headers: { "content-type": "application/json" },
          });
        }
        return response(Buffer.from("exact-image-bytes"));
      },
    });
    await expect(
      transfer.copyAndVerify({
        bucket: "avatars",
        source: "old/avatar.webp",
        destination: "new/avatar.webp",
      }),
    ).resolves.toMatchObject({ bytes: 17 });
    await transfer.remove({ bucket: "avatars", paths: ["old/avatar.webp"] });
    expect(requests[1].options).toMatchObject({ method: "POST" });
    expect(JSON.parse(requests[1].options.body)).toEqual({
      bucketId: "avatars",
      sourceKey: "old/avatar.webp",
      destinationKey: "new/avatar.webp",
    });
    expect(requests.at(-1).options).toMatchObject({ method: "DELETE" });
  });

  it("refuses hosted targets and mismatched copied bytes", async () => {
    expect(() =>
      createSupabaseStorageTransfer({
        url: "https://project.supabase.co",
        serviceRoleKey: "secret",
      }),
    ).toThrow("loopback");
    let reads = 0;
    const requests = [];
    const transfer = createSupabaseStorageTransfer({
      url: "http://localhost:54321",
      serviceRoleKey: "local-service-key",
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith("/storage/v1/object/copy")) return response("{}");
        if (options.method === "DELETE") return response("[]");
        reads += 1;
        return response(reads === 1 ? "source" : "different");
      },
    });
    await expect(
      transfer.copyAndVerify({
        bucket: "avatars",
        source: "old/a.webp",
        destination: "new/a.webp",
      }),
    ).rejects.toThrow("different byte digest");
    expect(requests.at(-1).options.method).toBe("DELETE");
  });
});
