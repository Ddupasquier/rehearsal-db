import { describe, expect, it } from "vitest";
import {
  createBaselineShapeEvidence,
  sampleShapeGraph,
  shapeKeySha256,
  validateBaselineShapePolicy,
  verifyBaselineShapeEvidence,
} from "../../../dist/src/source/shape.mjs";
import {
  assertShapePrivacyCoverage,
  prepareShapedBaseline,
} from "../../../dist/src/source/shape_preparation.mjs";
import { createPrivacyEngine } from "../../../dist/src/baseline/privacy_engine.mjs";
import { shapeEvidenceSha256 } from "../../../dist/src/source/shape_evidence.mjs";

import {
  key,
  generationId,
  digest,
  basePolicy,
  evidenceOptions,
} from "./shape_fixtures.mjs";

const corpus = () =>
  Array.from({ length: 8 }, (_, index) => [
    {
      schema: "public",
      table: "authors",
      row: {
        id: `source-owner-${index}`,
        active: index < 4,
        name: `SECRET_CANARY_${index}`,
      },
    },
    {
      schema: "library",
      table: "books",
      row: {
        tenant: "synthetic",
        id: index,
        author_id: `source-owner-${index}`,
        name: `PRIVATE_BOOK_${index}`,
      },
    },
  ]).flat();

describe("reviewed bounded shape declarations", () => {
  it("rejects unknown executable, source-secret, version, duplicate and unbounded fields", () => {
    for (const invalid of [
      { ...basePolicy(), shapeVersion: 2 },
      { ...basePolicy(), sql: "select * from private" },
      { ...basePolicy(), maximumSourceRows: 100001 },
      { ...basePolicy(), maximumSourceBytes: 128 * 1024 * 1024 + 1 },
      { ...basePolicy(), maximumDepth: 33 },
      { ...basePolicy(), minimumCohortSize: 1 },
      { ...basePolicy(), seed: "postgresql://secret@production" },
      {
        ...basePolicy(),
        tables: [basePolicy().tables[0], basePolicy().tables[0]],
      },
      {
        ...basePolicy(),
        tables: [
          { ...basePolicy().tables[0], requiredKeySha256: ["raw-owner-id"] },
        ],
      },
    ])
      expect(() => validateBaselineShapePolicy(invalid)).toThrow();
  });

  it("requires exact reviewed parent keys and matched composite endpoints", () => {
    const input = basePolicy();
    input.relationships[0].parent.columns = ["id", "private_email"];
    expect(() => validateBaselineShapePolicy(input)).toThrow(
      "exact parent key",
    );
  });

  it("refuses malformed bucket declarations and undeclared tables", () => {
    const goal = {
      id: "active",
      table: "authors",
      column: "active",
      kind: "boolean",
      required: true,
      tolerance: 0.1,
    };
    expect(() =>
      validateBaselineShapePolicy(
        basePolicy({ distributions: [{ ...goal, boundaries: [1] }] }),
      ),
    ).toThrow();
    expect(() =>
      validateBaselineShapePolicy(
        basePolicy({
          distributions: [{ ...goal, kind: "number", boundaries: [2, 1] }],
        }),
      ),
    ).toThrow();
    expect(() =>
      validateBaselineShapePolicy(
        basePolicy({ distributions: [{ ...goal, table: "private_accounts" }] }),
      ),
    ).toThrow();
    expect(() =>
      validateBaselineShapePolicy(
        basePolicy({ distributions: [{ ...goal, tolerance: Number.NaN }] }),
      ),
    ).toThrow();
  });
});

describe("deterministic graph sampling", () => {
  it("is stable across row-order changes and changes explicitly with the seed", () => {
    const source = corpus();
    const policy = validateBaselineShapePolicy(basePolicy());
    const first = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    });
    const second = sampleShapeGraph({
      records: [...source].reverse(),
      policy,
      privacyKey: key,
    });
    expect(first.records).toEqual(second.records);
    expect(first.records.filter((row) => row.table === "authors")).toHaveLength(
      4,
    );
    expect(first.records.filter((row) => row.table === "books")).toHaveLength(
      4,
    );
    const changed = sampleShapeGraph({
      records: source,
      policy: validateBaselineShapePolicy(
        basePolicy({ seed: "different-seed" }),
      ),
      privacyKey: key,
    });
    expect(changed.records).not.toEqual(first.records);
  });

  it("handles nullable composite foreign keys without inventing a parent", () => {
    const source = [
      ...corpus(),
      {
        schema: "library",
        table: "books",
        row: { tenant: "synthetic", id: 99, author_id: null, name: "safe" },
      },
    ];
    const input = basePolicy();
    input.tables[1].rootRows = 9;
    const result = sampleShapeGraph({
      records: source,
      policy: validateBaselineShapePolicy(input),
      privacyKey: key,
    });
    expect(
      result.records.filter((record) => record.table === "books"),
    ).toHaveLength(9);
    expect(result.relationshipCounts.get("book_author")).toBe(8);
  });

  it("preserves cycles and self-references within a finite visited graph", () => {
    const input = basePolicy({
      tables: [{ name: "nodes", key: ["id"], maximumRows: 5, rootRows: 1 }],
      relationships: [
        {
          id: "self",
          parent: { table: "nodes", columns: ["id"] },
          child: { table: "nodes", columns: ["parent_id"] },
          nullable: false,
          includeChildren: true,
          maximumChildrenPerParent: 1,
          maximumRows: 5,
        },
      ],
    });
    const records = [1, 2, 3].map((id) => ({
      table: "nodes",
      row: { id, parent_id: id === 3 ? 1 : id + 1 },
    }));
    const result = sampleShapeGraph({
      records,
      policy: validateBaselineShapePolicy(input),
      privacyKey: key,
    });
    expect(result.records).toHaveLength(3);
    expect(result.relationshipCounts.get("self")).toBe(3);
  });

  it("refuses fan-out, total/table budgets, missing keys and orphaned joins", () => {
    const input = basePolicy();
    input.relationships[0].maximumChildrenPerParent = 0;
    expect(() =>
      sampleShapeGraph({
        records: corpus(),
        policy: validateBaselineShapePolicy(input),
        privacyKey: key,
      }),
    ).toThrow("fan-out");
    const limited = basePolicy({
      maximumRows: 4,
      tables: [
        { name: "authors", key: ["id"], maximumRows: 4, rootRows: 4 },
        {
          schema: "library",
          name: "books",
          key: ["tenant", "id"],
          maximumRows: 4,
        },
      ],
    });
    limited.relationships[0].maximumRows = 4;
    expect(() =>
      sampleShapeGraph({
        records: corpus(),
        policy: validateBaselineShapePolicy(limited),
        privacyKey: key,
      }),
    ).toThrow("row budget");
    const missing = corpus();
    delete missing[0].row.id;
    expect(() =>
      sampleShapeGraph({
        records: missing,
        policy: validateBaselineShapePolicy(basePolicy()),
        privacyKey: key,
      }),
    ).toThrow("key column");
    const orphan = corpus();
    orphan[1].row.author_id = "missing-secret-owner";
    expect(() =>
      sampleShapeGraph({
        records: orphan,
        policy: validateBaselineShapePolicy(basePolicy()),
        privacyKey: key,
      }),
    ).toThrow("orphan");
    expect(() =>
      sampleShapeGraph({
        records: [...corpus(), corpus()[0]],
        policy: validateBaselineShapePolicy(basePolicy()),
        privacyKey: key,
      }),
    ).toThrow("duplicate");
  });

  it("uses only reviewed hash-bound required inclusions", () => {
    const input = basePolicy();
    input.tables[0].requiredKeySha256 = [shapeKeySha256(["source-owner-7"])];
    const sampled = sampleShapeGraph({
      records: corpus(),
      policy: validateBaselineShapePolicy(input),
      privacyKey: key,
    });
    expect(
      sampled.records.some((record) => record.row.id === "source-owner-7"),
    ).toBe(true);
    input.tables[0].requiredKeySha256 = [shapeKeySha256(["absent-owner"])];
    expect(() =>
      sampleShapeGraph({
        records: corpus(),
        policy: validateBaselineShapePolicy(input),
        privacyKey: key,
      }),
    ).toThrow("required shape inclusion");
  });

  it("enforces selected child fan-out even when automatic child traversal is disabled", () => {
    const input = basePolicy();
    input.tables[0].rootRows = 0;
    input.tables[1].rootRows = 2;
    input.relationships[0].includeChildren = false;
    input.relationships[0].maximumChildrenPerParent = 1;
    const source = [
      { table: "authors", row: { id: "owner" } },
      {
        schema: "library",
        table: "books",
        row: { tenant: "synthetic", id: 1, author_id: "owner" },
      },
      {
        schema: "library",
        table: "books",
        row: { tenant: "synthetic", id: 2, author_id: "owner" },
      },
    ];
    expect(() =>
      sampleShapeGraph({
        records: source,
        policy: validateBaselineShapePolicy(input),
        privacyKey: key,
      }),
    ).toThrow("per-parent fan-out");
  });

  it("bounds retained raw graph rows and bytes rather than writing raw staging", () => {
    const limitedRows = basePolicy({
      maximumSourceRows: 10,
      maximumRows: 10,
      tables: [{ name: "authors", key: ["id"], maximumRows: 10, rootRows: 1 }],
      relationships: [],
    });
    expect(() =>
      sampleShapeGraph({
        records: Array.from({ length: 11 }, (_, id) => ({
          table: "authors",
          row: { id },
        })),
        policy: validateBaselineShapePolicy(limitedRows),
        privacyKey: key,
      }),
    ).toThrow("capacity");
    expect(() =>
      sampleShapeGraph({
        records: corpus(),
        policy: validateBaselineShapePolicy(
          basePolicy({ maximumSourceBytes: 1 }),
        ),
        privacyKey: key,
      }),
    ).toThrow("capacity");
  });
});

describe("privacy-safe fidelity evidence", () => {
  it("stratifies a reviewed boolean shape and reports exact safe proportions", () => {
    const policy = validateBaselineShapePolicy(
      basePolicy({
        distributions: [
          {
            id: "active",
            table: "authors",
            column: "active",
            kind: "boolean",
            required: true,
            tolerance: 0,
          },
        ],
      }),
    );
    const source = corpus();
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    const sanitized = selected.map((record) => ({
      ...record,
      row: { ...record.row, name: "Sanitized" },
    }));
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(policy, source, selected, sanitized),
    );
    expect(evidence.distributions[0].status).toBe("passed");
    expect(
      evidence.distributions[0].buckets.find(
        (bucket) => bucket.bucket === "true",
      ),
    ).toMatchObject({ sourceCount: 4, baselineCount: 2, difference: 0 });
    expect(JSON.stringify(evidence)).not.toMatch(
      /SECRET_CANARY|PRIVATE_BOOK|source-owner|synthetic-graph-v1/u,
    );
    expect(
      verifyBaselineShapeEvidence(evidence, {
        generationId,
        privacyPolicySha256: digest,
      }),
    ).toEqual(evidence);
  });

  it("suppresses rare buckets and refuses to certify a required private cohort", () => {
    const source = corpus();
    source[0].row.active = null;
    const goal = {
      id: "active",
      table: "authors",
      column: "active",
      kind: "boolean",
      required: false,
      tolerance: 1,
    };
    const policy = validateBaselineShapePolicy(
      basePolicy({ distributions: [goal] }),
    );
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(policy, source, selected),
    );
    expect(evidence.distributions[0].buckets[0]).toMatchObject({
      sourceCount: null,
      baselineCount: null,
      difference: null,
      suppressed: true,
      status: "suppressed",
    });
    expect(evidence.warnings).toHaveLength(1);
    const required = validateBaselineShapePolicy(
      basePolicy({ distributions: [{ ...goal, required: true }] }),
    );
    expect(() =>
      createBaselineShapeEvidence(evidenceOptions(required, source, selected)),
    ).toThrow("Required shape goal");
  });

  it("uses complementary suppression so total-minus-common cannot reveal the rare count", () => {
    const source = Array.from({ length: 10 }, (_, id) => ({
      table: "items",
      row: { id, active: id !== 0 },
    }));
    const policy = validateBaselineShapePolicy(
      basePolicy({
        maximumRows: 10,
        tables: [{ name: "items", key: ["id"], maximumRows: 10, rootRows: 10 }],
        relationships: [],
        distributions: [
          {
            id: "active",
            table: "items",
            column: "active",
            kind: "boolean",
            required: false,
            tolerance: 0,
          },
        ],
      }),
    );
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(policy, source, selected),
    );
    expect(
      evidence.distributions[0].buckets.every(
        (bucket) =>
          bucket.sourceCount === null &&
          bucket.baselineCount === null &&
          bucket.difference === null &&
          bucket.suppressed,
      ),
    ).toBe(true);
    const modified = structuredClone(evidence);
    modified.distributions[0].buckets[2] = {
      bucket: "true",
      sourceCount: 9,
      baselineCount: 9,
      difference: 0,
      suppressed: false,
      status: "passed",
    };
    const { evidenceSha256: _oldDigest, ...unsigned } = modified;
    modified.evidenceSha256 = shapeEvidenceSha256(unsigned);
    expect(() => verifyBaselineShapeEvidence(modified)).toThrow(
      "complementary",
    );
  });

  it("fails broken post-sanitization joins instead of claiming relationship preservation", () => {
    const policy = validateBaselineShapePolicy(basePolicy());
    const source = corpus();
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    const sanitized = selected.map((record) =>
      record.table === "books"
        ? {
            ...record,
            row: { ...record.row, author_id: "different-namespace" },
          }
        : record,
    );
    expect(() =>
      createBaselineShapeEvidence(
        evidenceOptions(policy, source, selected, sanitized),
      ),
    ).toThrow("relationship is broken");
  });

  it("detects altered evidence, cross-generation reuse and additional private fields", () => {
    const policy = validateBaselineShapePolicy(basePolicy());
    const source = corpus();
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(policy, source, selected),
    );
    expect(() =>
      verifyBaselineShapeEvidence({ ...evidence, seedSha256: "f".repeat(64) }),
    ).toThrow("checksum");
    expect(() =>
      verifyBaselineShapeEvidence(evidence, {
        generationId: "20261013T210001Z-222222222222",
      }),
    ).toThrow("does not match");
    expect(() =>
      verifyBaselineShapeEvidence({ ...evidence, rows: source }),
    ).toThrow("unexpected fields");
  });

  it("measures explicit numeric, timestamps and length buckets without source values", () => {
    const source = Array.from({ length: 20 }, (_, id) => ({
      table: "items",
      row: {
        id,
        amount: id < 10 ? 0 : 100,
        at: id < 10 ? "2020-01-01T00:00:00Z" : "2030-01-01T00:00:00Z",
        text: id < 10 ? "" : "SECRET_UNIQUE_LONG",
        list: id < 10 ? [] : [1, 2, 3],
      },
    }));
    const distributions = [
      { id: "amount", column: "amount", kind: "number", boundaries: [50] },
      {
        id: "date",
        column: "at",
        kind: "timestamp",
        boundaries: [Date.parse("2025-01-01T00:00:00Z")],
      },
      { id: "length", column: "text", kind: "string-length", boundaries: [5] },
      { id: "items", column: "list", kind: "array-length", boundaries: [1] },
      { id: "nulls", column: "text", kind: "null" },
    ].map((goal) => ({
      ...goal,
      table: "items",
      required: true,
      tolerance: 0,
    }));
    const policy = validateBaselineShapePolicy(
      basePolicy({
        maximumRows: 20,
        tables: [{ name: "items", key: ["id"], maximumRows: 20, rootRows: 20 }],
        relationships: [],
        distributions,
      }),
    );
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(policy, source, selected),
    );
    expect(
      evidence.distributions.every((goal) => goal.status === "passed"),
    ).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("SECRET_UNIQUE_LONG");
  });

  it("profiles canonical PostgreSQL decimal strings but refuses lossy numeric precision", () => {
    const policy = validateBaselineShapePolicy(
      basePolicy({
        maximumRows: 20,
        tables: [{ name: "items", key: ["id"], maximumRows: 20, rootRows: 20 }],
        relationships: [],
        distributions: [
          {
            id: "amount",
            table: "items",
            column: "amount",
            kind: "number",
            boundaries: [50],
            required: true,
            tolerance: 0,
          },
        ],
      }),
    );
    const source = Array.from({ length: 20 }, (_, id) => ({
      table: "items",
      row: { id: String(id), amount: id < 10 ? "42.5000" : "100.000" },
    }));
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    expect(
      createBaselineShapeEvidence(evidenceOptions(policy, source, selected))
        .distributions[0].status,
    ).toBe("passed");
    for (const value of [
      "0.1000000000000000001",
      "9007199254740992",
      "001",
      "1e3",
      "SECRET_NUMBER",
      Number.NaN,
    ]) {
      const broken = [
        ...source,
        { table: "items", row: { id: "99", amount: value } },
      ];
      expect(() =>
        sampleShapeGraph({ records: broken, policy, privacyKey: key }),
      ).toThrow("numeric field");
    }
  });

  it("applies existing privacy rules only after graph selection and enforces FK coverage", async () => {
    const policy = validateBaselineShapePolicy(basePolicy());
    const privacy = {
      policyVersion: 2,
      migrationCutoff: "20260101000000",
      tables: [
        {
          name: "authors",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            {
              name: "id",
              action: "PSEUDONYMIZE",
              recipe: { format: "uuid", namespace: "author" },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "active",
              action: "KEEP",
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "name",
              action: "REPLACE",
              recipe: { kind: "constant", value: "Safe author" },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
        {
          schema: "library",
          name: "books",
          sourceRows: "STREAM AND SANITIZE",
          columns: [
            {
              name: "tenant",
              action: "KEEP",
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "id",
              action: "KEEP",
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
            {
              name: "author_id",
              action: "PSEUDONYMIZE",
              recipe: { format: "uuid", namespace: "author" },
              generated: "NEVER",
              identity: "NO",
              foreignKey: { schema: "public", table: "authors", column: "id" },
            },
            {
              name: "name",
              action: "REPLACE",
              recipe: { kind: "constant", value: "Safe book" },
              generated: "NEVER",
              identity: "NO",
              foreignKey: null,
            },
          ],
        },
      ],
    };
    const privacyEngine = createPrivacyEngine({ policy: privacy, key });
    const normalized = (
      await import("../../../dist/src/baseline/privacy_engine.mjs")
    ).validateExecutablePrivacyPolicy(privacy);
    async function* records() {
      yield* corpus();
    }
    const prepared = await prepareShapedBaseline({
      sourceRecords: records(),
      policy,
      privacyPolicy: normalized,
      privacyEngine,
      privacyKey: key,
      generationId,
      privacyPolicySha256: digest,
      sourceSchemaSha256: "b".repeat(64),
      sourceSnapshotSha256: "c".repeat(64),
    });
    expect(prepared.records).toHaveLength(8);
    expect(JSON.stringify(prepared)).not.toMatch(
      /SECRET_CANARY|PRIVATE_BOOK|source-owner/u,
    );
    const undeclared = validateBaselineShapePolicy(
      basePolicy({ relationships: [] }),
    );
    expect(() => assertShapePrivacyCoverage(undeclared, normalized)).toThrow(
      "lacks an explicit shape",
    );
  });
});
