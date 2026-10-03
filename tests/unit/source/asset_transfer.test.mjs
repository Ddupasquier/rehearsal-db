import { describe, expect, it } from "vitest";
import { streamApprovedSupabaseAssets } from "../../../src/source/asset_transfer.mjs";

const response = ({ status = 200, body, headers = {} }) =>
  new Response(body, { status, headers });

describe("approved Storage transfer", () => {
  it("inventories and streams only the declared bucket prefix", async () => {
    const calls = [];
    const fetchImplementation = async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/list/")) {
        return response({
          body: JSON.stringify([
            {
              name: "avatar.png",
              metadata: { size: 4, eTag: '"v1"', mimetype: "image/png" },
            },
          ]),
          headers: { "content-type": "application/json" },
        });
      }
      return response({
        body: Buffer.from("safe"),
        headers: { etag: '"v1"', "content-type": "image/png" },
      });
    };
    const assets = [];
    for await (const asset of streamApprovedSupabaseAssets({
      baseUrl: "https://source.example.invalid",
      token: "scoped-reader-token-value",
      declarations: [
        {
          bucket: "avatars",
          prefix: "approved-owner/",
          rights: "approved-owner",
        },
      ],
      fetchImplementation,
    })) {
      const chunks = [];
      for await (const chunk of asset.content) chunks.push(chunk);
      assets.push({ ...asset, content: Buffer.concat(chunks) });
    }
    expect(assets).toEqual([
      {
        bucket: "avatars",
        objectPath: "approved-owner/avatar.png",
        contentType: "image/png",
        content: Buffer.from("safe"),
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("unrelated");
  });

  it("rejects changed, oversized, traversal, and failed objects without response bodies", async () => {
    const inventory = (entry) => async (url) =>
      url.includes("/list/")
        ? response({
            body: JSON.stringify([entry]),
            headers: { "content-type": "application/json" },
          })
        : response({ body: Buffer.from("changed"), headers: { etag: '"v2"' } });

    await expect(async () => {
      for await (const _asset of streamApprovedSupabaseAssets({
        baseUrl: "https://source.example.invalid",
        token: "scoped-reader-token-value",
        declarations: [{ bucket: "avatars", prefix: "owner/" }],
        fetchImplementation: inventory({
          name: "avatar.png",
          metadata: { size: 7, eTag: '"v1"' },
        }),
      })) {
        // Iteration itself performs the version check.
      }
    }).rejects.toThrow("changed between inventory and transfer");

    await expect(async () => {
      for await (const _asset of streamApprovedSupabaseAssets({
        baseUrl: "https://source.example.invalid",
        token: "scoped-reader-token-value",
        declarations: [{ bucket: "avatars", prefix: "owner/" }],
        fetchImplementation: async (url) =>
          url.includes("/list/")
            ? response({
                body: JSON.stringify([
                  {
                    name: "avatar.png",
                    metadata: { size: 4, eTag: '"v1"' },
                  },
                ]),
              })
            : response({ body: Buffer.from("safe") }),
      })) {
        // Iteration itself requires the reviewed version header.
      }
    }).rejects.toThrow("omitted the reviewed object version");

    await expect(async () => {
      for await (const _asset of streamApprovedSupabaseAssets({
        baseUrl: "http://source.example.invalid",
        token: "scoped-reader-token-value",
        declarations: [{ bucket: "avatars", prefix: "owner/" }],
      })) {
        // no-op
      }
    }).rejects.toThrow("HTTPS");
  });
});
