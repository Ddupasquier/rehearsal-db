import { describe, expect, it } from "vitest";
import {
  createBaselineShapeEvidence,
  sampleShapeGraph,
  validateBaselineShapePolicy,
} from "../../../dist/src/source/shape.mjs";
import { key, basePolicy, evidenceOptions } from "./shape_fixtures.mjs";
import { createPrivacyEngine } from "../../../dist/src/baseline/privacy_engine.mjs";

describe("reviewed categorical, joint and edge-case fidelity", () => {
  const privacyColumn = (name, recipe) => ({
    name,
    action: recipe ? "PSEUDONYMIZE" : "KEEP",
    ...(recipe ? { recipe } : {}),
    generated: "NEVER",
    identity: "NO",
    foreignKey: null,
  });
  const privateText = (name) => ({
    ...privacyColumn(name),
    action: "REPLACE",
    recipe: { kind: "constant", value: "Safe synthetic text" },
  });

  it("closes both required parents of a composite many-to-many join across overlapping schema names", () => {
    const policy = validateBaselineShapePolicy(
      basePolicy({
        maximumSourceRows: 100,
        maximumRows: 40,
        tables: [
          { name: "members", key: ["id"], maximumRows: 8, rootRows: 0 },
          {
            schema: "library",
            name: "members",
            key: ["id"],
            maximumRows: 8,
            rootRows: 0,
          },
          {
            name: "memberships",
            key: ["left_id", "right_id"],
            maximumRows: 16,
            rootRows: 8,
          },
        ],
        relationships: [
          {
            id: "left_membership",
            parent: { table: "members", columns: ["id"] },
            child: { table: "memberships", columns: ["left_id"] },
            nullable: false,
            includeChildren: false,
            maximumChildrenPerParent: 2,
            maximumRows: 16,
          },
          {
            id: "right_membership",
            parent: { schema: "library", table: "members", columns: ["id"] },
            child: { table: "memberships", columns: ["right_id"] },
            nullable: false,
            includeChildren: false,
            maximumChildrenPerParent: 2,
            maximumRows: 16,
          },
        ],
        distributions: [],
      }),
    );
    const source = Array.from({ length: 8 }, (_, index) => [
      {
        table: "members",
        row: { id: `PRIVATE_LEFT_${index}`, note: "SECRET_JOIN_LEFT" },
      },
      {
        schema: "library",
        table: "members",
        row: { id: `PRIVATE_RIGHT_${index}`, note: "SECRET_JOIN_RIGHT" },
      },
      ...[index, (index + 1) % 8].map((right) => ({
        table: "memberships",
        row: {
          left_id: `PRIVATE_LEFT_${index}`,
          right_id: `PRIVATE_RIGHT_${right}`,
        },
      })),
    ]).flat();
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    expect(
      sampleShapeGraph({
        records: [...source].reverse(),
        policy,
        privacyKey: key,
      }).records,
    ).toEqual(selected);
    const links = selected.filter((record) => record.table === "memberships");
    expect(links).toHaveLength(8);
    for (const link of links) {
      expect(
        selected.some(
          (record) =>
            record.table === "members" &&
            (record.schema ?? "public") === "public" &&
            record.row.id === link.row.left_id,
        ),
      ).toBe(true);
      expect(
        selected.some(
          (record) =>
            record.table === "members" &&
            record.schema === "library" &&
            record.row.id === link.row.right_id,
        ),
      ).toBe(true);
    }
    const engine = createPrivacyEngine({
      key,
      policy: {
        policyVersion: 2,
        migrationCutoff: "20260101000000",
        tables: [
          {
            name: "members",
            sourceRows: "STREAM AND SANITIZE",
            columns: [
              privacyColumn("id", { format: "uuid", namespace: "left-member" }),
              privateText("note"),
            ],
          },
          {
            schema: "library",
            name: "members",
            sourceRows: "STREAM AND SANITIZE",
            columns: [
              privacyColumn("id", {
                format: "uuid",
                namespace: "right-member",
              }),
              privateText("note"),
            ],
          },
          {
            name: "memberships",
            sourceRows: "STREAM AND SANITIZE",
            columns: [
              privacyColumn("left_id", {
                format: "uuid",
                namespace: "left-member",
              }),
              privacyColumn("right_id", {
                format: "uuid",
                namespace: "right-member",
              }),
            ],
          },
        ],
      },
    });
    const sanitized = selected.map((record) => engine.sanitize(record));
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(policy, source, selected, sanitized),
    );
    expect(
      evidence.relationships.map((relation) => relation.checkedRows),
    ).toEqual([8, 8]);
    expect(JSON.stringify({ sanitized, evidence })).not.toMatch(
      /PRIVATE_LEFT|PRIVATE_RIGHT|SECRET_JOIN/u,
    );
  });

  it("preserves multiple correlated enums and long-tailed numbers/timestamps in a five-times-smaller sanitized sample", () => {
    const distributions = [
      {
        id: "state",
        table: "items",
        column: "state",
        kind: "enum",
        values: ["active", "queued", "archived"],
        required: true,
        tolerance: 0,
        minimumBucketRows: 2,
      },
      {
        id: "tier",
        table: "items",
        column: "tier",
        kind: "enum",
        values: ["basic", "premium"],
        required: true,
        tolerance: 0,
        minimumBucketRows: 2,
      },
      {
        id: "amount_tail",
        table: "items",
        column: "amount",
        kind: "number",
        boundaries: [1000, 100000000],
        required: true,
        tolerance: 0,
        minimumBucketRows: 2,
      },
      {
        id: "date_tail",
        table: "items",
        column: "at",
        kind: "timestamp",
        boundaries: [
          Date.parse("2000-01-01T00:00:00Z"),
          Date.parse("2025-01-01T00:00:00Z"),
        ],
        required: true,
        tolerance: 0,
        minimumBucketRows: 2,
      },
    ];
    const input = basePolicy({
      maximumSourceRows: 1000,
      maximumSourceBytes: 1_000_000,
      maximumRows: 200,
      tables: [{ name: "items", key: ["id"], maximumRows: 200, rootRows: 200 }],
      relationships: [],
      distributions,
      jointDistributions: [
        {
          id: "state_tier",
          table: "items",
          goals: ["state", "tier"],
          required: true,
          tolerance: 0,
          minimumBucketRows: 2,
        },
      ],
    });
    const policy = validateBaselineShapePolicy(input);
    const source = Array.from({ length: 1000 }, (_, id) => ({
      table: "items",
      row: {
        id,
        state: id < 900 ? "active" : id < 990 ? "queued" : "archived",
        tier:
          id < 900
            ? id % 2
              ? "premium"
              : "basic"
            : id < 990
              ? "basic"
              : "premium",
        amount: id < 900 ? id % 7 : id < 990 ? 100000 + id : 1000000000 + id,
        at:
          id < 900
            ? "2026-01-01T00:00:00Z"
            : id < 990
              ? "2020-01-01T00:00:00Z"
              : "1990-01-01T00:00:00Z",
        note: `SECRET_LONG_TAIL_${id}`,
      },
    }));
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    expect(selected).toHaveLength(200);
    expect(
      sampleShapeGraph({
        records: [...source].reverse(),
        policy,
        privacyKey: key,
      }).records,
    ).toEqual(selected);
    const columns = [
      privacyColumn("id", { format: "integer", namespace: "tail-item" }),
      ...["state", "tier", "amount", "at"].map((name) => privacyColumn(name)),
      privateText("note"),
    ];
    const engine = createPrivacyEngine({
      key,
      policy: {
        policyVersion: 2,
        migrationCutoff: "20260101000000",
        tables: [{ name: "items", sourceRows: "STREAM AND SANITIZE", columns }],
      },
    });
    const sanitized = selected.map((record) => engine.sanitize(record));
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(policy, source, selected, sanitized),
    );
    expect(
      evidence.distributions.every((goal) => goal.status === "passed"),
    ).toBe(true);
    expect(
      evidence.distributions
        .find((goal) => goal.id === "amount_tail")
        .buckets.slice(1)
        .map((bucket) => bucket.baselineCount),
    ).toEqual([180, 18, 2]);
    expect(JSON.stringify({ sanitized, evidence })).not.toContain(
      "SECRET_LONG_TAIL",
    );
    const erasedTail = sanitized.map((record) => ({
      ...record,
      row: { ...record.row, amount: 42 },
    }));
    expect(() =>
      createBaselineShapeEvidence(
        evidenceOptions(policy, source, selected, erasedTail),
      ),
    ).toThrow("Required shape goal amount_tail");
    const protectedPolicy = validateBaselineShapePolicy({
      ...input,
      minimumCohortSize: 5,
    });
    expect(() =>
      createBaselineShapeEvidence(
        evidenceOptions(protectedPolicy, source, selected, sanitized),
      ),
    ).toThrow("Required shape goal");
  });
  const itemsPolicy = (distributions, overrides = {}) =>
    validateBaselineShapePolicy(
      basePolicy({
        maximumSourceRows: 1000,
        maximumRows: 200,
        tables: [
          { name: "items", key: ["id"], maximumRows: 200, rootRows: 40 },
        ],
        relationships: [],
        distributions,
        ...overrides,
      }),
    );
  const itemGoal = (id, column, kind, overrides = {}) => ({
    id,
    table: "items",
    column,
    kind,
    required: true,
    tolerance: 0.05,
    minimumBucketRows: 2,
    ...overrides,
  });

  it("preserves a correlated enum/boolean joint without disclosing category literals", () => {
    const distributions = [
      itemGoal("state", "state", "enum", { values: ["draft", "active"] }),
      itemGoal("enabled", "enabled", "boolean"),
    ];
    const policy = itemsPolicy(distributions, {
      jointDistributions: [
        {
          id: "state_enabled",
          table: "items",
          goals: ["state", "enabled"],
          required: true,
          tolerance: 0.05,
          minimumBucketRows: 2,
        },
      ],
    });
    const source = Array.from({ length: 200 }, (_, id) => ({
      table: "items",
      row: { id, state: id < 150 ? "draft" : "active", enabled: id >= 150 },
    }));
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
    expect(
      evidence.distributions
        .find((goal) => goal.id === "state_enabled")
        .buckets.filter((bucket) => bucket.sourceCount > 0),
    ).toHaveLength(2);
    expect(JSON.stringify(evidence)).not.toMatch(/draft|active/u);
    const broken = selected.map((record) => ({
      ...record,
      row: { ...record.row, enabled: false },
    }));
    expect(() =>
      createBaselineShapeEvidence(
        evidenceOptions(policy, source, selected, broken),
      ),
    ).toThrow("Required shape goal");
  });

  it("bounds joint classes, reviewed category codes, same-table components and required bucket names", () => {
    const goals = [
      itemGoal("state", "state", "enum", { values: ["draft", "active"] }),
      itemGoal("enabled", "enabled", "boolean"),
    ];
    for (const values of [
      ["private user name"],
      ["https://secret.example"],
      ["a", "a"],
    ])
      expect(() => itemsPolicy([{ ...goals[0], values }])).toThrow();
    expect(() =>
      itemsPolicy(goals, {
        jointDistributions: [
          {
            id: "joint",
            table: "other",
            goals: ["state", "enabled"],
            required: false,
            tolerance: 1,
          },
        ],
      }),
    ).toThrow("same table");
    expect(() =>
      itemsPolicy(goals, {
        jointDistributions: [
          {
            id: "joint",
            table: "items",
            goals: ["state", "missing"],
            required: false,
            tolerance: 1,
          },
        ],
      }),
    ).toThrow("same table");
    const large = [
      itemGoal("left", "left", "enum", {
        values: Array.from({ length: 8 }, (_, i) => `code_${i}`),
      }),
      itemGoal("right", "right", "enum", {
        values: Array.from({ length: 8 }, (_, i) => `code_${i}`),
      }),
    ];
    expect(() =>
      itemsPolicy(large, {
        jointDistributions: [
          {
            id: "joint",
            table: "items",
            goals: ["left", "right"],
            required: false,
            tolerance: 1,
          },
        ],
      }),
    ).toThrow("64-bucket");
    expect(() =>
      itemsPolicy([{ ...goals[0], requiredBuckets: ["private-label"] }]),
    ).toThrow("declared classes");
    const policy = itemsPolicy([goals[0]]);
    expect(() =>
      sampleShapeGraph({
        records: [{ table: "items", row: { id: 1, state: "SECRET_CLASS" } }],
        policy,
        privacyKey: key,
      }),
    ).toThrow("no source value was printed");
  });

  it("records empty, min/max, oldest/newest and text/array-length edge classes after privacy", () => {
    const distributions = [
      itemGoal("number_edges", "amount", "number-extrema", {
        requiredBuckets: ["minimum", "maximum"],
      }),
      itemGoal("date_edges", "at", "timestamp-extrema", {
        requiredBuckets: ["minimum", "maximum"],
      }),
      itemGoal("text_edges", "text", "string-length-extrema", {
        requiredBuckets: ["minimum", "maximum"],
      }),
      itemGoal("array_edges", "list", "array-length-extrema", {
        requiredBuckets: ["minimum", "maximum"],
      }),
      itemGoal("empty_text", "text", "empty", {
        requiredBuckets: ["empty", "non-empty"],
      }),
    ];
    const policy = itemsPolicy(distributions, {
      tables: [{ name: "items", key: ["id"], maximumRows: 200, rootRows: 60 }],
    });
    const source = Array.from({ length: 60 }, (_, id) => ({
      table: "items",
      row: {
        id,
        amount: id < 20 ? -100 : id < 40 ? 0 : 100,
        at:
          id < 20
            ? "2000-01-01T00:00:00Z"
            : id < 40
              ? "2020-01-01T00:00:00Z"
              : "2040-01-01T00:00:00Z",
        text: id < 20 ? "" : id < 40 ? "safe" : "STRUCTURAL_CANARY",
        list: id < 20 ? [] : id < 40 ? [0] : [0, 1, 2],
      },
    }));
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
    expect(JSON.stringify(evidence)).not.toContain("STRUCTURAL_CANARY");
    const lost = selected.map((record) => ({
      ...record,
      row: { ...record.row, text: "safe" },
    }));
    expect(() =>
      createBaselineShapeEvidence(
        evidenceOptions(policy, source, selected, lost),
      ),
    ).toThrow("Required shape goal");
  });

  it("does not silently claim unique or absent required edge representatives", () => {
    const source = Array.from({ length: 20 }, (_, id) => ({
      table: "items",
      row: { id, amount: id === 0 ? -100 : 100 },
    }));
    const policy = itemsPolicy([
      itemGoal("edges", "amount", "number-extrema", {
        tolerance: 1,
        requiredBuckets: ["minimum", "maximum"],
      }),
    ]);
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    expect(() =>
      createBaselineShapeEvidence(evidenceOptions(policy, source, selected)),
    ).toThrow("Required shape goal");
    const noEmpty = itemsPolicy([
      itemGoal("empty", "text", "empty", { requiredBuckets: ["empty"] }),
    ]);
    const safe = source.map((record) => ({
      ...record,
      row: { ...record.row, text: "all nonempty" },
    }));
    expect(() =>
      createBaselineShapeEvidence(evidenceOptions(noEmpty, safe, safe)),
    ).toThrow("Required shape goal");
    const advisory = itemsPolicy([
      itemGoal("empty", "text", "empty", {
        required: false,
        requiredBuckets: ["empty"],
      }),
    ]);
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(advisory, safe, safe),
    );
    expect(evidence.distributions[0].status).toBe("failed");
    expect(
      evidence.distributions[0].buckets.find(
        (bucket) => bucket.bucket === "empty",
      ).disposition,
    ).toBe("absent");
  });

  it("checks zero/one/many relationship fan-out classes on selected and restored graph", () => {
    const input = basePolicy({
      maximumSourceRows: 200,
      maximumRows: 100,
      tables: [
        { name: "authors", key: ["id"], maximumRows: 30, rootRows: 12 },
        {
          schema: "library",
          name: "books",
          key: ["tenant", "id"],
          maximumRows: 60,
        },
      ],
      distributions: [
        {
          id: "fanout",
          table: "authors",
          kind: "relationship-fanout",
          relationship: "book_author",
          required: true,
          tolerance: 0,
          minimumBucketRows: 2,
          requiredBuckets: ["zero", "one", "many"],
        },
      ],
    });
    const source = Array.from({ length: 24 }, (_, id) => [
      { table: "authors", row: { id } },
      ...Array.from({ length: id < 8 ? 0 : id < 16 ? 1 : 3 }, (_, child) => ({
        schema: "library",
        table: "books",
        row: { tenant: "safe", id: id * 3 + child, author_id: id },
      })),
    ]).flat();
    const policy = validateBaselineShapePolicy(input);
    const selected = sampleShapeGraph({
      records: source,
      policy,
      privacyKey: key,
    }).records;
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(policy, source, selected),
    );
    expect(evidence.distributions[0].status).toBe("passed");
    expect(
      evidence.distributions[0].buckets.map(
        (bucket) => bucket.selectedSourceCount,
      ),
    ).toEqual([4, 4, 4]);
  });

  it("distinguishes omitted and privacy-transformed classes without fabricating rows", () => {
    const policy = itemsPolicy([
      itemGoal("empty", "text", "empty", {
        required: false,
        tolerance: 1,
        minimumBucketRows: 0,
      }),
    ]);
    const source = Array.from({ length: 40 }, (_, id) => ({
      table: "items",
      row: { id, text: id < 20 ? "" : "PRIVATE" },
    }));
    const selected = source.slice(20);
    const sanitized = selected.map((record) => ({
      ...record,
      row: { ...record.row, text: "" },
    }));
    const evidence = createBaselineShapeEvidence(
      evidenceOptions(policy, source, selected, sanitized),
    );
    expect(
      evidence.distributions[0].buckets.find(
        (bucket) => bucket.bucket === "empty",
      ),
    ).toMatchObject({ selectedSourceCount: 0, disposition: "omitted" });
    expect(
      evidence.distributions[0].buckets.find(
        (bucket) => bucket.bucket === "non-empty",
      ),
    ).toMatchObject({ selectedSourceCount: 20, disposition: "transformed" });
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
  });
});
