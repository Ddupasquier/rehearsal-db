/** Bounded deterministic root selection and explicit relationship closure. */

import { createHash, createHmac } from "node:crypto";
import type {
  BaselineShapePolicy,
  ShapeEndpoint,
  ShapeRecord,
} from "./shape_contract.mjs";
import { shapeTableIdentity } from "./shape_contract.mjs";
import { profileShapeRecords } from "./shape_profiles.mjs";
import { shapeKeyTuple, shapeKeyFormats } from "./shape_keys.mjs";
import type { ShapeKeyContext } from "./shape_keys.mjs";
export { shapeKeyTuple, shapeKeySha256 } from "./shape_keys.mjs";

const endpointIdentity = (endpoint: ShapeEndpoint): string =>
  shapeTableIdentity(endpoint.schema, endpoint.table);

interface IndexedRow {
  readonly record: ShapeRecord;
  readonly table: string;
  readonly key: string;
  readonly rank: string;
}

export interface ShapeSample {
  readonly records: readonly ShapeRecord[];
  readonly relationshipCounts: ReadonlyMap<string, number>;
}

export const sampleShapeGraph = ({
  records,
  policy,
  privacyKey,
  keyContext,
}: {
  readonly records: readonly ShapeRecord[];
  readonly policy: BaselineShapePolicy;
  readonly privacyKey: Uint8Array | string;
  readonly keyContext?: ShapeKeyContext | undefined;
}): ShapeSample => {
  if (Buffer.byteLength(privacyKey) < 32)
    throw new Error("Shape sampling needs the existing private pseudonym key.");
  const tableDeclarations = new Map(
    policy.tables.map((table) => [
      shapeTableIdentity(table.schema, table.name),
      table,
    ]),
  );
  const tables = new Map<string, Map<string, IndexedRow>>();
  for (const declaration of policy.tables)
    tables.set(
      shapeTableIdentity(declaration.schema, declaration.name),
      new Map(),
    );
  let bytes = 0;
  let indexBytes = 0;
  for (const record of records) {
    bytes += Buffer.byteLength(JSON.stringify(record));
    if (
      records.length > policy.maximumSourceRows ||
      bytes > policy.maximumSourceBytes
    ) {
      throw new Error(
        "The approved source exceeds the bounded shape graph capacity; reduce the approved export or use full extraction.",
      );
    }
    const table = shapeTableIdentity(record.schema ?? "public", record.table);
    const declaration = tableDeclarations.get(table);
    if (!declaration)
      throw new Error(
        "Shape source exposed a table outside its reviewed declarations.",
      );
    const key = shapeKeyTuple(
      record.row,
      declaration.key,
      false,
      shapeKeyFormats(
        keyContext,
        declaration.schema,
        declaration.name,
        declaration.key,
      ),
    )!;
    indexBytes += Buffer.byteLength(key);
    if (indexBytes > 32 * 1024 * 1024)
      throw new Error(
        "Shape key indexes exceed their 32 MiB boundary; narrow source rows or key declarations.",
      );
    const indexed = tables.get(table)!;
    if (indexed.has(key))
      throw new Error("Shape source contains duplicate reviewed row keys.");
    indexed.set(key, {
      record,
      table,
      key,
      rank: createHmac("sha256", privacyKey)
        .update(`shape-root-v1\0${policy.seed}\0${table}\0${key}`)
        .digest("hex"),
    });
  }
  const childIndexes = new Map<string, Map<string, IndexedRow[]>>();
  let relationshipCells = 0;
  for (const relation of policy.relationships) {
    const parents = tables.get(endpointIdentity(relation.parent))!;
    const children = new Map<string, IndexedRow[]>();
    for (const row of tables.get(endpointIdentity(relation.child))!.values()) {
      relationshipCells += 1;
      if (relationshipCells > 1_000_000)
        throw new Error(
          "Shape relationships exceed their one-million-cell work boundary.",
        );
      const key = shapeKeyTuple(
        row.record.row,
        relation.child.columns,
        relation.nullable,
        shapeKeyFormats(
          keyContext,
          relation.child.schema,
          relation.child.table,
          relation.child.columns,
        ),
      );
      if (key === null) continue;
      indexBytes += Buffer.byteLength(key);
      if (indexBytes > 32 * 1024 * 1024)
        throw new Error(
          "Shape key indexes exceed their 32 MiB boundary; narrow source rows or relationship declarations.",
        );
      if (!parents.has(key))
        throw new Error(
          "A reviewed shape relationship has an orphan; widen the approved export or correct the declaration.",
        );
      const matching = children.get(key) ?? [];
      matching.push(row);
      children.set(key, matching);
    }
    childIndexes.set(relation.id, children);
  }
  const profiles = profileShapeRecords(records, policy, keyContext);
  const selected = new Map<string, IndexedRow>();
  const selectedCounts = new Map<string, number>();
  const queue: { row: IndexedRow; depth: number }[] = [];
  const identity = (row: IndexedRow): string => `${row.table}\0${row.key}`;
  const add = (row: IndexedRow, depth: number): void => {
    if (selected.has(identity(row))) return;
    if (depth > policy.maximumDepth)
      throw new Error(
        "Shape relationship traversal exceeds its reviewed depth.",
      );
    const tableCount = (selectedCounts.get(row.table) ?? 0) + 1;
    if (
      selected.size + 1 > policy.maximumRows ||
      tableCount > tableDeclarations.get(row.table)!.maximumRows
    ) {
      throw new Error(
        "Required shape relationship closure exceeds the reviewed row budget.",
      );
    }
    selected.set(identity(row), row);
    selectedCounts.set(row.table, tableCount);
    queue.push({ row, depth });
  };
  for (const declaration of policy.tables) {
    const table = shapeTableIdentity(declaration.schema, declaration.name);
    const ranked = [...tables.get(table)!.values()].sort((left, right) =>
      left.rank.localeCompare(right.rank),
    );
    const required = new Set(declaration.requiredKeySha256);
    for (const row of ranked) {
      const digest = createHash("sha256").update(row.key).digest("hex");
      if (required.delete(digest)) add(row, 0);
    }
    if (required.size)
      throw new Error(
        "A required shape inclusion is absent from the approved source snapshot.",
      );
    // Stratify one joint (if declared) or scalar goal; competing goals are verified afterwards.
    // This is bounded O(n + buckets), not an unbounded repeated optimizer.
    const goal = [...policy.jointDistributions, ...policy.distributions].find(
      (goal) =>
        goal.schema === declaration.schema && goal.table === declaration.name,
    );
    const rootBudget = Math.min(declaration.rootRows, ranked.length);
    if (goal && rootBudget) {
      const buckets = new Map<string, IndexedRow[]>();
      for (const row of ranked) {
        const bucket = profiles.assignments.get(goal.id)!.get(row.record)!;
        const matching = buckets.get(bucket) ?? [];
        matching.push(row);
        buckets.set(bucket, matching);
      }
      const sourceCounts = profiles.counts.get(goal.id)!;
      for (const [bucket, members] of buckets) {
        const count = sourceCounts.get(bucket) ?? 0;
        // Low-cohort buckets receive no special selection priority.
        const allocation =
          count < policy.minimumCohortSize
            ? 0
            : Math.min(
                members.length,
                Math.max(
                  goal.minimumBucketRows,
                  Math.floor((rootBudget * count) / ranked.length),
                ),
              );
        for (const row of members.slice(0, allocation)) {
          if ((selectedCounts.get(table) ?? 0) >= rootBudget) break;
          add(row, 0);
        }
      }
    }
    for (const row of ranked) {
      if ((selectedCounts.get(table) ?? 0) >= rootBudget) break;
      add(row, 0);
    }
  }
  const checkedEdges = new Map(
    policy.relationships.map((relation) => [relation.id, new Set<string>()]),
  );
  const selectedFanOut = new Map(
    policy.relationships.map((relation) => [
      relation.id,
      new Map<string, number>(),
    ]),
  );
  for (let index = 0; index < queue.length; index += 1) {
    const { row, depth } = queue[index]!;
    for (const relation of policy.relationships) {
      if (row.table === endpointIdentity(relation.child)) {
        const parentKey = shapeKeyTuple(
          row.record.row,
          relation.child.columns,
          relation.nullable,
          shapeKeyFormats(
            keyContext,
            relation.child.schema,
            relation.child.table,
            relation.child.columns,
          ),
        );
        if (parentKey !== null) {
          const parent = tables
            .get(endpointIdentity(relation.parent))!
            .get(parentKey)!;
          add(parent, depth + 1);
          checkedEdges.get(relation.id)!.add(identity(row));
          const byParent = selectedFanOut.get(relation.id)!;
          const fanOut = (byParent.get(parentKey) ?? 0) + 1;
          byParent.set(parentKey, fanOut);
          if (fanOut > relation.maximumChildrenPerParent) {
            throw new Error(
              "Selected shape children exceed their reviewed per-parent fan-out budget.",
            );
          }
          if (checkedEdges.get(relation.id)!.size > relation.maximumRows) {
            throw new Error(
              "Shape relationship exceeds its reviewed total edge budget.",
            );
          }
        }
      }
      if (
        relation.includeChildren &&
        row.table === endpointIdentity(relation.parent)
      ) {
        const children = childIndexes.get(relation.id)!.get(row.key) ?? [];
        if (children.length > relation.maximumChildrenPerParent) {
          throw new Error(
            "Shape relationship fan-out exceeds its reviewed per-parent budget.",
          );
        }
        for (const child of children) add(child, depth + 1);
      }
    }
  }
  const chosen = [...selected.values()].sort(
    (left, right) =>
      left.table.localeCompare(right.table) ||
      left.rank.localeCompare(right.rank),
  );
  return Object.freeze({
    records: Object.freeze(chosen.map((row) => row.record)),
    relationshipCounts: new Map(
      [...checkedEdges].map(([id, rows]) => [id, rows.size]),
    ),
  });
};
