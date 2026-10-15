/** Installed-consumer proof of public bounded shaping and immutable receipts. */

export const shapeConsumerAssertions = `
import {
  validateBaselineShapePolicy, sampleShapeGraph, createBaselineShapeEvidence,
  verifyBaselineShapeEvidence, shapeKeySha256, readVerifiedBaselineShapeEvidence,
  shapeKeyContextFromSchema,
} from "@rehearsal-db/core/shape";
import { createAndActivateBaseline, verifyActiveBaseline, removeBaselineArtifactRoot } from "@rehearsal-db/core/baseline";
import { join as shapeJoin } from "node:path";
{
  const shapeSource = Array.from({ length: 1000 }, (_, index) => [
    { table: "authors", row: { tenant: "synthetic", id: index, available: index < 500,
      category: index < 500 ? "draft" : "active", shape_size: index < 500 ? 0 : 100, name: "SECRET_SHAPE_AUTHOR_" + index } },
    ...Array.from({ length: 5 }, (_, child) => ({ schema: "library", table: "books", row: {
      tenant: "synthetic", id: index * 5 + child, author_id: index, name: "PRIVATE_SHAPE_BOOK_" + index + "_" + child,
    } })),
  ]).flat();
  const shapeDeclaration = {
    shapeVersion: 1, seed: "packed-library-v1", maximumSourceRows: 7000,
    maximumSourceBytes: 2000000, maximumRows: 300, minimumCohortSize: 5,
    tables: [
      { name: "authors", key: ["tenant", "id"], maximumRows: 50, rootRows: 40 },
      { schema: "library", name: "books", key: ["tenant", "id"], maximumRows: 250 },
    ],
    relationships: [{ id: "book_author", parent: { table: "authors", columns: ["tenant", "id"] },
      child: { schema: "library", table: "books", columns: ["tenant", "author_id"] }, nullable: false,
      includeChildren: true, maximumChildrenPerParent: 5, maximumRows: 250 }],
    distributions: [
      { id: "availability", table: "authors", column: "available", kind: "boolean", required: true, tolerance: 0 },
      { id: "category", table: "authors", column: "category", kind: "enum", values: ["draft", "active"], required: true, tolerance: 0, requiredBuckets: ["category-0", "category-1"] },
      { id: "size_edges", table: "authors", column: "shape_size", kind: "number-extrema", required: true, tolerance: 0, requiredBuckets: ["minimum", "maximum"] },
      { id: "fanout", table: "authors", kind: "relationship-fanout", relationship: "book_author", required: true, tolerance: 0, requiredBuckets: ["many"] },
    ],
    jointDistributions: [{ id: "category_availability", table: "authors", goals: ["category", "availability"], required: true, tolerance: 0 }],
  };
  const shapePolicy = validateBaselineShapePolicy(shapeDeclaration);
  const typedPolicy = validateBaselineShapePolicy({ shapeVersion: 1, seed: "typed-packed-v1", maximumRows: 10, minimumCohortSize: 2,
    tables: [{ name: "parents", key: ["id"], maximumRows: 5, rootRows: 1 }, { name: "children", key: ["id"], maximumRows: 5 }],
    relationships: [{ id: "typed_fk", parent: { table: "parents", columns: ["id"] }, child: { table: "children", columns: ["parent_id"] }, nullable: false, includeChildren: true, maximumChildrenPerParent: 5, maximumRows: 5 }] });
  const typedContext = shapeKeyContextFromSchema(typedPolicy, [
    { schema: "public", name: "parents", columns: [{ name: "id", underlyingType: "int8" }] },
    { schema: "public", name: "children", columns: [{ name: "id", underlyingType: "int4" }, { name: "parent_id", underlyingType: "int4" }] },
  ]);
  const typedRows = [{ table: "parents", row: { id: "1" } }, { table: "children", row: { id: 9, parent_id: 1 } }];
  assert.equal(sampleShapeGraph({ records: typedRows, policy: typedPolicy, privacyKey: Buffer.alloc(32, 9), keyContext: typedContext }).records.length, 2);
  assert.equal(shapeKeySha256([1], ["int4"]), shapeKeySha256(["1.000"], ["numeric"]));
  const shapeKey = Buffer.alloc(32, 9);
  const firstShape = sampleShapeGraph({ records: shapeSource, policy: shapePolicy, privacyKey: shapeKey });
  const repeatShape = sampleShapeGraph({ records: [...shapeSource].reverse(), policy: shapePolicy, privacyKey: shapeKey });
  assert.deepEqual(firstShape.records, repeatShape.records);
  assert.equal(firstShape.records.length, 240);
  assert.equal(firstShape.relationshipCounts.get("book_author"), 200);
  const shapeColumn = (name, action, recipe) => ({ name, action, ...(recipe ? { recipe } : {}), generated: "NEVER", identity: "NO", foreignKey: null });
  const shapePrivacy = { policyVersion: 2, migrationCutoff: "20260101000000", tables: [
    { name: "authors", sourceRows: "STREAM AND SANITIZE", columns: [
      shapeColumn("tenant", "KEEP"), shapeColumn("id", "PSEUDONYMIZE", { format: "integer", namespace: "shape-author" }),
      shapeColumn("available", "KEEP"), shapeColumn("name", "REPLACE", { kind: "constant", value: "Safe author" }),
      shapeColumn("category", "KEEP"), shapeColumn("shape_size", "KEEP"),
    ] },
    { schema: "library", name: "books", sourceRows: "STREAM AND SANITIZE", columns: [
      shapeColumn("tenant", "KEEP"), shapeColumn("id", "PSEUDONYMIZE", { format: "integer", namespace: "shape-book" }),
      shapeColumn("author_id", "PSEUDONYMIZE", { format: "integer", namespace: "shape-author" }),
      shapeColumn("name", "REPLACE", { kind: "constant", value: "Safe book" }),
    ] },
  ] };
  const shapeEngine = createPrivacyEngine({ policy: shapePrivacy, key: shapeKey });
  const sanitizedShape = firstShape.records.map((row) => shapeEngine.sanitize(row));
  const shapeGeneration = "20261013T220000Z-111111111111";
  const shapePrivacyDigest = createHash("sha256").update(JSON.stringify(shapePrivacy)).digest("hex");
  const shapeEvidence = createBaselineShapeEvidence({ source: shapeSource, selected: firstShape.records, sanitized: sanitizedShape,
    policy: shapePolicy, generationId: shapeGeneration, privacyPolicySha256: shapePrivacyDigest,
    sourceSchemaSha256: "b".repeat(64), sourceSnapshotSha256: "c".repeat(64) });
  assert.equal(shapeEvidence.distributions[0].status, "passed");
  assert.equal(shapeEvidence.distributions.every((goal) => goal.status === "passed"), true);
  assert.equal(shapeEvidence.relationships[0].checkedRows, 200);
  assert.deepEqual(verifyBaselineShapeEvidence(shapeEvidence), shapeEvidence);
  assert.equal(/SECRET_SHAPE|PRIVATE_SHAPE|packed-library-v1/.test(JSON.stringify({ sanitizedShape, shapeEvidence })), false);
  const tamperedShape = structuredClone(shapeEvidence); tamperedShape.tables[0].sourceRows += 1;
  assert.throws(() => verifyBaselineShapeEvidence(tamperedShape), /checksum/);
  assert.throws(() => verifyBaselineShapeEvidence(shapeEvidence, { generationId: "20261013T220001Z-222222222222" }), /does not match/);
  const requiredDeclaration = structuredClone(shapeDeclaration);
  requiredDeclaration.tables[0].requiredKeySha256 = [shapeKeySha256(["synthetic", 999])];
  requiredDeclaration.distributions = [];
  requiredDeclaration.jointDistributions = [];
  assert.equal(sampleShapeGraph({ records: shapeSource, policy: validateBaselineShapePolicy(requiredDeclaration), privacyKey: shapeKey }).records.some((row) => row.table === "authors" && row.row.id === 999), true);
  const fanoutDeclaration = structuredClone(shapeDeclaration); fanoutDeclaration.relationships[0].maximumChildrenPerParent = 4;
  assert.throws(() => sampleShapeGraph({ records: shapeSource, policy: validateBaselineShapePolicy(fanoutDeclaration), privacyKey: shapeKey }), /fan-out/);
  const rareSource = structuredClone(shapeSource); rareSource[0].row.available = null;
  const rareDeclaration = structuredClone(shapeDeclaration); rareDeclaration.distributions[0].required = false;
  rareDeclaration.distributions = [rareDeclaration.distributions[0]]; rareDeclaration.jointDistributions = [];
  const rarePolicy = validateBaselineShapePolicy(rareDeclaration);
  const rareSelected = sampleShapeGraph({ records: rareSource, policy: rarePolicy, privacyKey: shapeKey }).records;
  const rareEvidence = createBaselineShapeEvidence({ source: rareSource, selected: rareSelected,
    sanitized: rareSelected.map((row) => shapeEngine.sanitize(row)), policy: rarePolicy,
    generationId: shapeGeneration, privacyPolicySha256: shapePrivacyDigest,
    sourceSchemaSha256: "b".repeat(64), sourceSnapshotSha256: "c".repeat(64) });
  assert.equal(rareEvidence.distributions[0].buckets[0].suppressed, true);
  assert.equal(rareEvidence.distributions[0].buckets[0].sourceCount, null);
  assert.equal(rareEvidence.distributions[0].buckets[0].baselineCount, null);
  assert.equal(rareEvidence.distributions[0].buckets[0].difference, null);
  assert.deepEqual(verifyBaselineShapeEvidence(rareEvidence), rareEvidence);
  const requiredRarePolicy = validateBaselineShapePolicy({ ...rareDeclaration,
    distributions: [{ ...rareDeclaration.distributions[0], required: true }] });
  assert.throws(() => createBaselineShapeEvidence({ source: rareSource, selected: rareSelected,
    sanitized: rareSelected.map((row) => shapeEngine.sanitize(row)), policy: requiredRarePolicy,
    generationId: shapeGeneration, privacyPolicySha256: shapePrivacyDigest,
    sourceSchemaSha256: "b".repeat(64), sourceSnapshotSha256: "c".repeat(64) }), /Required shape goal/);
  const shapeRoot = shapeJoin(process.cwd(), ".rehearsal");
  try {
    const shapeManifest = await createAndActivateBaseline({ artifactRoot: shapeRoot, generationId: shapeGeneration,
      records: sanitizedShape, expectedTables: ["authors", "library.books"], shapeEvidence,
      metadata: { migrationCutoff: "20260101000000", migrationHistorySha256: "a".repeat(64),
        sanitizationPolicySha256: shapePrivacyDigest, sourceSchemaSha256: "b".repeat(64) } });
    assert.equal((await verifyActiveBaseline({ artifactRoot: shapeRoot })).rowCount, 240);
    assert.deepEqual(await readVerifiedBaselineShapeEvidence({ artifactRoot: shapeRoot, baseline: shapeManifest }), shapeEvidence);
  } finally { await removeBaselineArtifactRoot({ artifactRoot: shapeRoot }); }
}
`;
