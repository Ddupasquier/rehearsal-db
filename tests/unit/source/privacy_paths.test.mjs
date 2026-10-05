import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolvePrivacyMappedAssets } from "../../../src/source/privacy_paths.mjs";
import {
  assetEndpointFingerprint,
  sourceTargetFingerprint,
} from "../../../src/source/access.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const environmentVariable = "REHEARSAL_APPROVED_OWNER_ID";
const sourcePolicy = {
  accessVersion: 1,
  targetFingerprint: sourceTargetFingerprint(
    "postgresql://owner:secret@localhost:5432/source",
  ),
  administratorEnvironmentVariable: "REHEARSAL_SOURCE_ADMIN_URL",
  reader: {
    role: "rehearsal_reader",
    ownerRole: "rehearsal_owner",
    credentialFile: ".rehearsal/secrets/source-reader.env",
    validForMinutes: 30,
  },
  exportSchema: "rehearsal_export",
  migrationLedger: {
    schema: "supabase_migrations",
    table: "schema_migrations",
    versionColumn: "version",
    nameColumn: "name",
    statementsColumn: "statements",
  },
  relations: [
    {
      source: { schema: "public", table: "profiles" },
      view: "owner_profile",
      targetTable: "profiles",
      columns: ["id"],
      orderBy: ["id"],
      rowScope: { kind: "approved-public" },
    },
  ],
  assetReader: {
    endpointFingerprint: assetEndpointFingerprint(
      "https://storage.example.invalid",
    ),
    baseUrlEnvironmentVariable: "REHEARSAL_SOURCE_STORAGE_URL",
    tokenEnvironmentVariable: "REHEARSAL_SOURCE_STORAGE_TOKEN",
    maximumObjects: 10,
    maximumObjectBytes: 1024,
    maximumTotalBytes: 4096,
  },
  assets: [
    {
      bucket: "avatars",
      prefixEnvironmentVariable: environmentVariable,
      rights: "approved-owner",
      pathMapping: "owner-storage",
    },
  ],
};
const privacyPolicy = {
  policyVersion: 2,
  migrationCutoff: "20260101000000",
  bindings: {
    "approved-owner": {
      environmentVariable,
      approvedValueSha256: createHash("sha256").update(owner).digest("hex"),
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
          name: "id",
          action: "KEEP",
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
      ],
    },
  ],
};

describe("source privacy path coordination", () => {
  it("resolves the private prefix only in memory", () => {
    const assets = resolvePrivacyMappedAssets({
      sourcePolicy,
      privacyPolicy,
      environment: { [environmentVariable]: owner },
    });
    expect(assets[0].prefix).toBe(owner);
    expect(JSON.stringify(sourcePolicy)).not.toContain(owner);
  });

  it("refuses mismatched or missing private prefix bindings", () => {
    expect(() =>
      resolvePrivacyMappedAssets({
        sourcePolicy,
        privacyPolicy: {
          ...privacyPolicy,
          bindings: {
            "approved-owner": {
              ...privacyPolicy.bindings["approved-owner"],
              environmentVariable: "REHEARSAL_OTHER_OWNER_ID",
            },
          },
        },
        environment: { [environmentVariable]: owner },
      }),
    ).toThrow("environment variable reviewed");
    expect(() =>
      resolvePrivacyMappedAssets({
        sourcePolicy,
        privacyPolicy,
        environment: {},
      }),
    ).toThrow(environmentVariable);
  });
});
