export const key = Buffer.alloc(32, 8);
export const generationId = "20261013T210000Z-111111111111";
export const digest = "a".repeat(64);
export const basePolicy = (overrides = {}) => ({
  shapeVersion: 1,
  seed: "synthetic-graph-v1",
  maximumSourceRows: 100,
  maximumSourceBytes: 100_000,
  maximumRows: 50,
  minimumCohortSize: 2,
  tables: [
    { name: "authors", key: ["id"], maximumRows: 20, rootRows: 4 },
    {
      schema: "library",
      name: "books",
      key: ["tenant", "id"],
      maximumRows: 30,
    },
  ],
  relationships: [
    {
      id: "book_author",
      parent: { table: "authors", columns: ["id"] },
      child: { schema: "library", table: "books", columns: ["author_id"] },
      nullable: true,
      includeChildren: true,
      maximumChildrenPerParent: 3,
      maximumRows: 30,
    },
  ],
  distributions: [],
  ...overrides,
});

export const evidenceOptions = (
  policy,
  source,
  selected,
  sanitized = selected,
) => ({
  source,
  selected,
  sanitized,
  policy,
  generationId,
  privacyPolicySha256: digest,
  sourceSchemaSha256: "b".repeat(64),
  sourceSnapshotSha256: "c".repeat(64),
});
