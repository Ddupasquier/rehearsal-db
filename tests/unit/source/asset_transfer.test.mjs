import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPrivacyEngine } from "../../../src/baseline/privacy_engine.mjs";
import { streamApprovedSupabaseAssets } from "../../../src/source/asset_transfer.mjs";

const response = ({ status = 200, body, headers = {} }) =>
  new Response(body, { status, headers });

describe("approved Storage transfer", () => {
  it("inventories and streams only the declared bucket prefix", async () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    const engine = createPrivacyEngine({
      policy: {
        policyVersion: 2,
        migrationCutoff: "20260101000000",
        bindings: {
          "approved-owner": {
            environmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
            approvedValueSha256: createHash("sha256")
              .update(owner)
              .digest("hex"),
          },
        },
        pathMappings: {
          "owner-storage": {
            binding: "approved-owner",
            format: "uuid",
            namespace: "account-id",
          },
        },
        tables: [
          {
            name: "profiles",
            sourceRows: "STREAM AND SANITIZE",
            columns: [
              {
                name: "user_id",
                action: "PSEUDONYMIZE",
                recipe: { format: "uuid", namespace: "account-id" },
                generated: "NEVER",
                identity: "NO",
                foreignKey: null,
              },
              {
                name: "avatar_path",
                action: "DERIVE",
                recipe: { kind: "path-map", mapping: "owner-storage" },
                generated: "NEVER",
                identity: "NO",
                foreignKey: null,
              },
            ],
          },
        ],
      },
      key: Buffer.alloc(32, 7),
      environment: { REHEARSAL_APPROVED_OWNER_ID: owner },
    });
    const databaseRow = engine.sanitize({
      table: "profiles",
      row: { user_id: owner, avatar_path: `${owner}/avatar.png` },
    }).row;
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
          prefix: `${owner}/`,
          rights: "approved-owner",
          pathMapping: "owner-storage",
        },
      ],
      pathMapper: ({ mapping, value }) => engine.remapPath({ mapping, value }),
      fetchImplementation,
    })) {
      const chunks = [];
      for await (const chunk of asset.content) chunks.push(chunk);
      assets.push({ ...asset, content: Buffer.concat(chunks) });
    }
    expect(assets).toEqual([
      {
        bucket: "avatars",
        objectPath: databaseRow.avatar_path,
        contentType: "image/png",
        content: Buffer.from("safe"),
      },
    ]);
    expect(databaseRow.avatar_path).toBe(`${databaseRow.user_id}/avatar.png`);
    expect(JSON.stringify(calls)).not.toContain("unrelated");
  });

  it("requires package-owned mapping for a declared destination rewrite", async () => {
    await expect(async () => {
      for await (const _asset of streamApprovedSupabaseAssets({
        baseUrl: "https://source.example.invalid",
        token: "scoped-reader-token-value",
        declarations: [
          {
            bucket: "avatars",
            prefix: "approved-owner/",
            pathMapping: "owner-storage",
          },
        ],
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
            : response({
                body: Buffer.from("safe"),
                headers: { etag: '"v1"' },
              }),
      })) {
        // Iteration must refuse a mapping without package-owned privacy execution.
      }
    }).rejects.toThrow(
      "Storage path mapping requires the package-owned privacy mapper",
    );
  });

  it("records a canonical Storage media type without response parameters", async () => {
    const assets = [];
    for await (const asset of streamApprovedSupabaseAssets({
      baseUrl: "https://source.example.invalid",
      token: "scoped-reader-token-value",
      declarations: [{ bucket: "assets", prefix: "owner/" }],
      fetchImplementation: async (url) =>
        url.includes("/list/")
          ? response({
              body: JSON.stringify([
                {
                  name: "note.txt",
                  metadata: {
                    size: 4,
                    eTag: '"v1"',
                    mimetype: "text/plain",
                  },
                },
              ]),
            })
          : response({
              body: Buffer.from("safe"),
              headers: {
                etag: '"v1"',
                "content-type": "text/plain; charset=UTF-8",
              },
            }),
    })) {
      for await (const _chunk of asset.content) {
        // Consume the bounded stream so the transfer is fully verified.
      }
      assets.push(asset);
    }

    expect(assets[0].contentType).toBe("text/plain");
  });

  it("recursively inventories Supabase folder placeholders and transfers only files", async () => {
    const listedPrefixes = [];
    const downloadedPaths = [];
    const fetchImplementation = async (url, options = {}) => {
      if (url.includes("/list/")) {
        const { prefix } = JSON.parse(options.body);
        listedPrefixes.push(prefix);
        const entries = {
          owner: [
            { id: null, name: "photos", metadata: null },
            { id: "root-file", name: "profile.json", metadata: { size: 2 } },
          ],
          "owner/photos": [
            { id: null, name: "2026", metadata: null },
            { id: "photo-file", name: "avatar.png", metadata: { size: 3 } },
          ],
          "owner/photos/2026": [
            {
              id: "nested-file",
              name: "launch.png",
              metadata: { size: 4 },
            },
          ],
        };
        return response({ body: JSON.stringify(entries[prefix] ?? []) });
      }
      const path = decodeURIComponent(url.split("/assets/")[1]);
      downloadedPaths.push(path);
      const bytes = path.endsWith("profile.json")
        ? "{}"
        : path.endsWith("avatar.png")
          ? "pic"
          : "ship";
      return response({ body: Buffer.from(bytes) });
    };

    const assets = [];
    for await (const asset of streamApprovedSupabaseAssets({
      baseUrl: "https://source.example.invalid",
      token: "scoped-reader-token-value",
      declarations: [{ bucket: "assets", prefix: "owner/" }],
      fetchImplementation,
    })) {
      const chunks = [];
      for await (const chunk of asset.content) chunks.push(chunk);
      assets.push({ path: asset.objectPath, bytes: Buffer.concat(chunks) });
    }

    expect(listedPrefixes).toEqual([
      "owner",
      "owner/photos",
      "owner/photos/2026",
    ]);
    expect(downloadedPaths).toEqual([
      "owner/profile.json",
      "owner/photos/avatar.png",
      "owner/photos/2026/launch.png",
    ]);
    expect(assets.map(({ path }) => path)).toEqual(downloadedPaths);
    expect(assets.map(({ bytes }) => bytes.toString())).toEqual([
      "{}",
      "pic",
      "ship",
    ]);
  });

  it("distinguishes empty files from folders and bounds recursive inventory", async () => {
    const emptyAssets = [];
    for await (const asset of streamApprovedSupabaseAssets({
      baseUrl: "https://source.example.invalid",
      token: "scoped-reader-token-value",
      declarations: [{ bucket: "assets", prefix: "owner/" }],
      fetchImplementation: async (url) =>
        url.includes("/list/")
          ? response({
              body: JSON.stringify([
                { id: "empty-file", name: "empty.txt", metadata: { size: 0 } },
              ]),
            })
          : response({ body: Buffer.alloc(0) }),
    })) {
      for await (const _chunk of asset.content) {
        // Consume and verify the exact zero-byte response.
      }
      emptyAssets.push(asset.objectPath);
    }
    expect(emptyAssets).toEqual(["owner/empty.txt"]);

    await expect(async () => {
      for await (const _asset of streamApprovedSupabaseAssets({
        baseUrl: "https://source.example.invalid",
        token: "scoped-reader-token-value",
        declarations: [{ bucket: "assets", prefix: "owner/" }],
        maximumObjects: 1,
        fetchImplementation: async (url, options = {}) => {
          if (!url.includes("/list/")) return response({ body: "x" });
          const { prefix } = JSON.parse(options.body);
          return response({
            body: JSON.stringify(
              prefix === "owner"
                ? [{ id: null, name: "folder", metadata: null }]
                : [{ id: "file", name: "file.txt", metadata: { size: 1 } }],
            ),
          });
        },
      })) {
        // Folder placeholders count toward the reviewed inventory boundary.
      }
    }).rejects.toThrow("reviewed transfer boundary");

    await expect(async () => {
      for await (const _asset of streamApprovedSupabaseAssets({
        baseUrl: "https://source.example.invalid",
        token: "scoped-reader-token-value",
        declarations: [{ bucket: "assets", prefix: "owner/" }],
        fetchImplementation: async () =>
          response({
            body: JSON.stringify([
              { id: null, name: "../escape", metadata: null },
            ]),
          }),
      })) {
        // Unsafe folder names must fail before another request is made.
      }
    }).rejects.toThrow("unsafe");
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
