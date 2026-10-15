import { describe, expect, it } from "vitest";
import {
  createBaselineShapeEvidence,
  sampleShapeGraph,
  shapeKeyContextFromSchema,
  shapeKeySha256,
  validateBaselineShapePolicy,
} from "../../../dist/src/source/shape.mjs";
import { key, evidenceOptions } from "./shape_fixtures.mjs";
import { createPrivacyEngine } from "../../../dist/src/baseline/privacy_engine.mjs";

const declaration = () => ({
  shapeVersion: 1,
  seed: "typed-keys-v1",
  maximumRows: 10,
  minimumCohortSize: 2,
  tables: [
    { name: "parents", key: ["tenant", "id"], maximumRows: 5, rootRows: 1 },
    { schema: "library", name: "children", key: ["id"], maximumRows: 5 },
  ],
  relationships: [
    {
      id: "parent_child",
      parent: { table: "parents", columns: ["tenant", "id"] },
      child: {
        schema: "library",
        table: "children",
        columns: ["tenant", "parent_id"],
      },
      nullable: false,
      includeChildren: true,
      maximumChildrenPerParent: 5,
      maximumRows: 5,
    },
  ],
});
const schema = (parentType = "int8", childType = "int4") => [
  {
    schema: "public",
    name: "parents",
    columns: [
      { name: "tenant", underlyingType: "text" },
      { name: "id", underlyingType: parentType },
    ],
  },
  {
    schema: "library",
    name: "children",
    columns: [
      { name: "id", underlyingType: "int4" },
      { name: "tenant", underlyingType: "text" },
      { name: "parent_id", underlyingType: childType },
    ],
  },
];
const records = (parent = "1", child = 1) => [
  { table: "parents", row: { tenant: "synthetic", id: parent } },
  {
    schema: "library",
    table: "children",
    row: { id: 9, tenant: "synthetic", parent_id: child },
  },
];

describe("schema-owned SQL shape keys", () => {
  it("matches compatible numeric widths in composite joins without changing raw or sanitized values", () => {
    const policy = validateBaselineShapePolicy(declaration());
    for (const [parentType, childType, parent, child] of [
      ["int8", "int4", "1", 1],
      ["int4", "int8", 1, "1"],
      ["numeric", "int8", "1.0000", "1"],
      ["int8", "numeric", "9007199254740993", "9007199254740993.0000"],
    ]) {
      const source = records(parent, child);
      const before = structuredClone(source);
      const keyContext = shapeKeyContextFromSchema(
        policy,
        schema(parentType, childType),
      );
      const selected = sampleShapeGraph({
        records: source,
        policy,
        privacyKey: key,
        keyContext,
      }).records;
      expect(selected).toHaveLength(2);
      expect(source).toEqual(before);
      const evidence = createBaselineShapeEvidence({
        ...evidenceOptions(policy, source, selected),
        keyContext,
      });
      expect(evidence.relationships[0].checkedRows).toBe(1);
    }
  });

  it("does not guess numeric formats from primitive values or coerce text identities", () => {
    const policy = validateBaselineShapePolicy(declaration());
    expect(() =>
      sampleShapeGraph({ records: records(), policy, privacyKey: key }),
    ).toThrow("orphan");
    expect(() =>
      shapeKeyContextFromSchema(policy, schema("text", "int4")),
    ).toThrow("never inferred from text");
    const keyContext = shapeKeyContextFromSchema(
      policy,
      schema("text", "text"),
    );
    expect(() =>
      sampleShapeGraph({
        records: records("01", "1"),
        policy,
        privacyKey: key,
        keyContext,
      }),
    ).toThrow("orphan");
    expect(shapeKeySha256(["01"], ["text"])).not.toBe(
      shapeKeySha256([1], ["int4"]),
    );
    expect(() =>
      sampleShapeGraph({
        records: records(9007199254740992, "9007199254740992"),
        policy,
        privacyKey: key,
        keyContext: shapeKeyContextFromSchema(policy, schema()),
      }),
    ).toThrow("unsafe JavaScript");
  });

  it("binds explicit required-key receipts to the same inspected numeric comparison", () => {
    const input = declaration();
    input.tables[0].requiredKeySha256 = [
      shapeKeySha256(["synthetic", "1.000"], ["text", "numeric"]),
    ];
    const policy = validateBaselineShapePolicy(input);
    const keyContext = shapeKeyContextFromSchema(policy, schema());
    expect(
      sampleShapeGraph({
        records: records(),
        policy,
        privacyKey: key,
        keyContext,
      }).records,
    ).toHaveLength(2);
    expect(shapeKeySha256([1], ["int4"])).toBe(
      shapeKeySha256(["1.000"], ["numeric"]),
    );
    expect(() => shapeKeySha256([1, 2], ["int4"])).toThrow(
      "every reviewed key component",
    );
  });

  it("does not conceal incompatible existing privacy transformations of mixed numeric inputs", () => {
    const policy = validateBaselineShapePolicy(declaration());
    const keyContext = shapeKeyContextFromSchema(policy, schema());
    const source = records();
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
      keyContext,
    }).records;
    const column = (name, namespace) => ({
      name,
      action: namespace ? "PSEUDONYMIZE" : "KEEP",
      ...(namespace ? { recipe: { format: "integer", namespace } } : {}),
      generated: "NEVER",
      identity: "NO",
      foreignKey: null,
    });
    const engine = createPrivacyEngine({
      key,
      policy: {
        policyVersion: 2,
        migrationCutoff: "20260101000000",
        tables: [
          {
            name: "parents",
            sourceRows: "STREAM AND SANITIZE",
            columns: [column("tenant"), column("id", "parent")],
          },
          {
            schema: "library",
            name: "children",
            sourceRows: "STREAM AND SANITIZE",
            columns: [
              column("id", "child"),
              column("tenant"),
              column("parent_id", "parent"),
            ],
          },
        ],
      },
    });
    const sanitized = selected.map((record) => engine.sanitize(record));
    expect(() =>
      createBaselineShapeEvidence({
        ...evidenceOptions(policy, source, selected, sanitized),
        keyContext,
      }),
    ).toThrow("sanitized shape relationship is broken");
    expect(source).toEqual(records());
  });
});
