import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RehearsalError,
  normalizeRehearsalError,
  serializeRehearsalError,
} from "../../../dist/src/shared/diagnostics.mjs";
import {
  assertSourceAccessConfirmation,
  assetEndpointFingerprint,
  createSourceAccessPlan,
  createSourceRetirementPlan,
  externalViewDefinitionFingerprint,
  sourceTargetFingerprint,
  validateSourceAccessPolicy,
} from "../../../dist/src/source/access.mjs";

const connection =
  "postgresql://administrator:secret@127.0.0.1:55432/source_fixture";
const policy = {
  accessVersion: 1,
  targetFingerprint: sourceTargetFingerprint(connection),
  administratorEnvironmentVariable: "REHEARSAL_SOURCE_ADMIN_URL",
  reader: {
    role: "rehearsal_fixture_reader",
    ownerRole: "rehearsal_fixture_owner",
    credentialFile: ".rehearsal/secrets/source-reader.env",
    validForMinutes: 30,
  },
  exportSchema: "rehearsal_export_fixture",
  migrationLedger: {
    schema: "supabase_migrations",
    table: "schema_migrations",
    versionColumn: "version",
    nameColumn: "name",
    statementsColumn: "statements",
  },
  relations: [
    {
      source: { schema: "public", table: "catalog" },
      view: "catalog_public",
      targetTable: "catalog",
      columns: ["id", "owner_id", "name"],
      orderBy: ["id"],
      rowScope: { kind: "approved-public" },
    },
    {
      source: { schema: "private", table: "profiles" },
      view: "approved_owner_profile",
      targetSchema: "blendcalc_api",
      targetTable: "profiles",
      columns: ["id", "email"],
      orderBy: ["id"],
      rowScope: {
        kind: "approved-owner",
        column: "id",
        valueEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
      },
    },
  ],
  assetReader: {
    endpointFingerprint: assetEndpointFingerprint(
      "https://storage.example.invalid",
    ),
    baseUrlEnvironmentVariable: "REHEARSAL_SOURCE_STORAGE_URL",
    tokenEnvironmentVariable: "REHEARSAL_SOURCE_STORAGE_TOKEN",
    maximumObjects: 100,
    maximumObjectBytes: 1048576,
    maximumTotalBytes: 10485760,
  },
  assets: [
    {
      bucket: "public-images",
      prefixEnvironmentVariable: "REHEARSAL_APPROVED_OWNER_ID",
      rights: "approved-owner",
      pathMapping: "owner-storage",
    },
  ],
};

describe("source access boundary", () => {
  it("creates a redacted exact plan and requires its digest", () => {
    const normalized = validateSourceAccessPolicy(policy);
    expect(normalized.relations[0].targetSchema).toBe("public");
    expect(normalized.relations[1].targetSchema).toBe("blendcalc_api");
    expect(normalized.assets[0].pathMapping).toBe("owner-storage");
    expect(normalized.assets[0].prefixEnvironmentVariable).toBe(
      "REHEARSAL_APPROVED_OWNER_ID",
    );
    const plan = createSourceAccessPlan({
      policy,
      environment: {
        REHEARSAL_SOURCE_ADMIN_URL: connection,
        REHEARSAL_APPROVED_OWNER_ID: "private-owner-123",
        REHEARSAL_SOURCE_STORAGE_URL: "https://storage.example.invalid",
        REHEARSAL_SOURCE_STORAGE_TOKEN: "scoped-token",
      },
    });

    expect(plan.review.reader.validForMinutes).toBe(30);
    expect(plan.review.relations[1].rowScope.valueSha256).toBe(
      createHash("sha256").update("private-owner-123").digest("hex"),
    );
    expect(JSON.stringify(plan.review)).not.toContain("administrator:secret");
    expect(JSON.stringify(plan.review)).not.toContain("private-owner-123");
    expect(plan.review.assets[0].prefixValueSha256).toBe(
      createHash("sha256").update("private-owner-123").digest("hex"),
    );
    expect(() => assertSourceAccessConfirmation(plan, "wrong")).toThrow(
      "does not match this exact plan",
    );
    expect(assertSourceAccessConfirmation(plan, plan.digest)).toBe(plan);
  });

  it.each(["incorrect", "stale"])(
    "classifies %s confirmation with explicit source-plan review guidance",
    (kind) => {
      const environment = {
        REHEARSAL_SOURCE_ADMIN_URL: connection,
        REHEARSAL_APPROVED_OWNER_ID: "private-owner-123",
        REHEARSAL_SOURCE_STORAGE_URL: "https://storage.example.invalid",
        REHEARSAL_SOURCE_STORAGE_TOKEN: "scoped-token",
      };
      const original = createSourceAccessPlan({ policy, environment });
      const current =
        kind === "stale"
          ? createSourceAccessPlan({
              policy: {
                ...policy,
                reader: { ...policy.reader, validForMinutes: 31 },
              },
              environment,
            })
          : original;
      const confirmation = kind === "stale" ? original.digest : "0".repeat(64);
      expect(confirmation).not.toBe(current.digest);
      let failure;
      try {
        assertSourceAccessConfirmation(current, confirmation);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(RehearsalError);
      expect(failure).toMatchObject({
        category: "configuration_invalid",
        code: "CONFIGURATION_INVALID",
        exitCode: 2,
        message: `Source access confirmation does not match this exact plan. Expected ${current.digest}.`,
        refused: expect.stringMatching(
          /did not open.*or change source access/u,
        ),
      });
      expect(
        normalizeRehearsalError(failure, {
          category: "internal_failure",
          suggestions: [
            "Run rehearsal doctor for actionable readiness checks.",
          ],
        }),
      ).toBe(failure);
      const serialized = serializeRehearsalError(failure);
      expect(serialized).toMatchObject({
        schemaVersion: 1,
        status: "error",
        error: {
          category: "configuration_invalid",
          code: "CONFIGURATION_INVALID",
          message: failure.message,
          refused: failure.refused,
          suggestions: [
            expect.stringMatching(/rehearsal source plan.*review/u),
            expect.stringMatching(
              /explicit approval.*--confirm-source-access=/u,
            ),
          ],
          diagnosticId: expect.stringMatching(/^[a-f0-9]{12}$/u),
        },
      });
      const json = JSON.stringify(serialized);
      expect(json).not.toContain("administrator:secret");
      expect(json).not.toContain("private-owner-123");
      expect(json).not.toContain("scoped-token");
      expect(assertSourceAccessConfirmation(current, current.digest)).toBe(
        current,
      );
    },
  );

  it("rejects wrong targets, broad lifetime, unsafe scope, and unknown fields", () => {
    expect(() =>
      createSourceAccessPlan({
        policy,
        environment: {
          REHEARSAL_SOURCE_ADMIN_URL:
            "postgresql://administrator:secret@127.0.0.1:55432/wrong",
          REHEARSAL_APPROVED_OWNER_ID: "private-owner-123",
          REHEARSAL_SOURCE_STORAGE_URL: "https://storage.example.invalid",
          REHEARSAL_SOURCE_STORAGE_TOKEN: "scoped-token",
        },
      }),
    ).toThrow("reviewed target fingerprint");
    expect(() =>
      validateSourceAccessPolicy({
        ...policy,
        reader: { ...policy.reader, validForMinutes: 1_440 },
      }),
    ).toThrow("5 through 240");
    expect(() =>
      validateSourceAccessPolicy({
        ...policy,
        relations: [
          {
            ...policy.relations[0],
            rowScope: { kind: "all" },
          },
        ],
      }),
    ).toThrow("unsupported");
    expect(() =>
      validateSourceAccessPolicy({ ...policy, sql: "select *" }),
    ).toThrow("unknown");
    expect(() =>
      validateSourceAccessPolicy({
        ...policy,
        assets: [{ ...policy.assets[0], pathMapping: "Not Valid" }],
      }),
    ).toThrow("pathMapping");
    expect(() =>
      validateSourceAccessPolicy({
        ...policy,
        assets: [
          {
            ...policy.assets[0],
            prefix: "private-owner-123/",
            prefixEnvironmentVariable: undefined,
          },
        ],
      }),
    ).toThrow("requires prefixEnvironmentVariable");
    expect(
      validateSourceAccessPolicy({
        ...policy,
        reader: {
          ...policy.reader,
          credentialFile:
            "targets/primary/.rehearsal/secrets/source-reader.env",
        },
      }).reader.credentialFile,
    ).toBe("targets/primary/.rehearsal/secrets/source-reader.env");
    for (const credentialFile of [
      "/tmp/source-reader.env",
      "../.rehearsal/secrets/source-reader.env",
      ".rehearsal/source-reader.env",
      ".rehearsal/secrets/../source-reader.env",
    ]) {
      expect(() =>
        validateSourceAccessPolicy({
          ...policy,
          reader: { ...policy.reader, credentialFile },
        }),
      ).toThrow("configured .rehearsal/secrets directory");
    }
  });

  it("plans an externally provisioned reader without administrator access", () => {
    const externalUrl =
      "postgresql://provided_reader:private-password@127.0.0.1:55432/source_fixture";
    const externalPolicy = {
      ...policy,
      targetFingerprint: sourceTargetFingerprint(externalUrl),
      administratorEnvironmentVariable: undefined,
      reader: {
        mode: "external",
        role: "provided_reader",
        allowedMemberships: ["provided_reader_group"],
        connectionEnvironmentVariable: "REHEARSAL_SOURCE_READER_URL",
        credentialFile: ".rehearsal/secrets/source-reader.env",
        maximumValidForMinutes: 30,
      },
      relations: policy.relations.map((relation) => ({
        ...relation,
        viewDefinitionSha256: externalViewDefinitionFingerprint(
          `select ${relation.columns.join(", ")} from ${relation.source.schema}.${relation.source.table}`,
        ),
      })),
    };
    const plan = createSourceAccessPlan({
      policy: externalPolicy,
      environment: {
        REHEARSAL_SOURCE_READER_URL: externalUrl,
        REHEARSAL_APPROVED_OWNER_ID: "private-owner-123",
        REHEARSAL_SOURCE_STORAGE_URL: "https://storage.example.invalid",
        REHEARSAL_SOURCE_STORAGE_TOKEN: "scoped-token",
      },
    });

    expect(plan.review.reader).toMatchObject({
      mode: "external",
      role: "provided_reader",
      allowedMemberships: ["provided_reader_group"],
      maximumValidForMinutes: 30,
      sourceChanges: false,
    });
    expect(JSON.stringify(plan.review)).not.toContain("private-password");
    expect(() =>
      validateSourceAccessPolicy({
        ...externalPolicy,
        administratorEnvironmentVariable: "REHEARSAL_SOURCE_ADMIN_URL",
      }),
    ).toThrow("not allowed for an external reader");
    expect(() =>
      validateSourceAccessPolicy({
        ...externalPolicy,
        reader: { ...externalPolicy.reader, maximumValidForMinutes: 241 },
      }),
    ).toThrow("5 through 240");
    expect(() =>
      validateSourceAccessPolicy({
        ...externalPolicy,
        reader: {
          ...externalPolicy.reader,
          allowedMemberships: [
            "provided_reader_group",
            "provided_reader_group",
          ],
        },
      }),
    ).toThrow("must not contain duplicates");
    expect(() =>
      validateSourceAccessPolicy({
        ...externalPolicy,
        reader: {
          ...externalPolicy.reader,
          allowedMemberships: ["provided_reader"],
        },
      }),
    ).toThrow("must not include the login role");
  });

  it("builds retirement from the exact recorded objects only", () => {
    const plan = createSourceRetirementPlan({
      targetFingerprint: policy.targetFingerprint,
      receipt: {
        receiptVersion: 1,
        targetFingerprint: policy.targetFingerprint,
        planDigest: "b".repeat(64),
        exportSchema: policy.exportSchema,
        views: ["catalog_public", "approved_owner_profile"],
        relations: policy.relations.map((relation) => ({
          ...relation.source,
          columns: relation.columns,
        })),
        migrationLedger: policy.migrationLedger,
        readerRole: policy.reader.role,
        ownerRole: policy.reader.ownerRole,
      },
    });
    expect(plan.review.views).toEqual([
      "approved_owner_profile",
      "catalog_public",
    ]);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/u);
  });
});
