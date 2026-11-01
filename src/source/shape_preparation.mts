/** Keep bounded raw graph rows ephemeral, then reuse the reviewed privacy engine. */

import type {
  ExecutablePrivacyPolicy,
  PrivacyEngine,
} from "../baseline/privacy/privacy_contract.mjs";
import type {
  BaselineShapeEvidence,
  BaselineShapePolicy,
  ShapeRecord,
} from "./shape_contract.mjs";
import { shapeTableIdentity } from "./shape_contract.mjs";
import { createBaselineShapeEvidence } from "./shape_evidence.mjs";
import { sampleShapeGraph } from "./shape_sampler.mjs";
import { throwIfOperationCancelled } from "../shared/cancellation.mjs";
import type { ShapeKeyContext } from "./shape_keys.mjs";

export const assertShapePrivacyCoverage = (
  policy: BaselineShapePolicy,
  privacy: ExecutablePrivacyPolicy,
): void => {
  const included = privacy.tables.filter(
    (table) => table.sourceRows !== "EXCLUDE",
  );
  const declared = new Map(
    policy.tables.map((table) => [
      shapeTableIdentity(table.schema, table.name),
      table,
    ]),
  );
  if (
    declared.size !== included.length ||
    included.some(
      (table) => !declared.has(shapeTableIdentity(table.schema, table.name)),
    )
  ) {
    throw new Error(
      "Shape tables must exactly cover every included privacy table.",
    );
  }
  const privacyByTable = new Map(
    included.map((table) => [
      shapeTableIdentity(table.schema, table.name),
      table,
    ]),
  );
  const requireRetained = (
    schema: string,
    table: string,
    columns: readonly string[],
  ): void => {
    const privacyTable = privacyByTable.get(shapeTableIdentity(schema, table));
    if (
      columns.some(
        (name) =>
          !privacyTable?.columns.some(
            (column) =>
              column.name === name &&
              column.action !== "EXCLUDE" &&
              column.generated !== "ALWAYS",
          ),
      )
    ) {
      throw new Error(
        "Shape keys, relationships, and goals require explicitly retained, non-generated privacy columns.",
      );
    }
  };
  for (const table of policy.tables)
    requireRetained(table.schema, table.name, table.key);
  for (const relation of policy.relationships) {
    requireRetained(
      relation.parent.schema,
      relation.parent.table,
      relation.parent.columns,
    );
    requireRetained(
      relation.child.schema,
      relation.child.table,
      relation.child.columns,
    );
  }
  for (const goal of policy.distributions)
    if (goal.column !== null)
      requireRetained(goal.schema, goal.table, [goal.column]);
  for (const table of included) {
    for (const column of table.columns) {
      const key = column.foreignKey;
      if (column.action === "EXCLUDE" || !key) continue;
      if (
        !policy.relationships.some(
          (relation) =>
            relation.child.schema === table.schema &&
            relation.child.table === table.name &&
            relation.parent.schema === key.schema &&
            relation.parent.table === key.table &&
            relation.child.columns.some(
              (name, index) =>
                name === column.name &&
                relation.parent.columns[index] === key.column,
            ),
        )
      ) {
        throw new Error(
          "A retained privacy foreign key lacks an explicit shape relationship declaration.",
        );
      }
    }
  }
};

export const prepareShapedBaseline = async ({
  sourceRecords,
  policy,
  privacyPolicy,
  privacyEngine,
  privacyKey,
  generationId,
  privacyPolicySha256,
  sourceSchemaSha256,
  sourceSnapshotSha256,
  keyContext,
}: {
  readonly sourceRecords: AsyncIterable<ShapeRecord>;
  readonly policy: BaselineShapePolicy;
  readonly privacyPolicy: ExecutablePrivacyPolicy;
  readonly privacyEngine: Readonly<PrivacyEngine>;
  readonly privacyKey: Uint8Array | string;
  readonly generationId: string;
  readonly privacyPolicySha256: string;
  readonly sourceSchemaSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly keyContext?: ShapeKeyContext | undefined;
}): Promise<
  Readonly<{ records: readonly ShapeRecord[]; evidence: BaselineShapeEvidence }>
> => {
  assertShapePrivacyCoverage(policy, privacyPolicy);
  const included = new Set(
    policy.tables.map((table) => shapeTableIdentity(table.schema, table.name)),
  );
  const source: ShapeRecord[] = [];
  let bytes = 0;
  for await (const record of sourceRecords) {
    throwIfOperationCancelled();
    if (
      !included.has(shapeTableIdentity(record.schema ?? "public", record.table))
    )
      continue;
    bytes += Buffer.byteLength(JSON.stringify(record));
    if (
      source.length + 1 > policy.maximumSourceRows ||
      bytes > policy.maximumSourceBytes
    ) {
      throw new Error(
        "The approved source exceeds the bounded shape graph capacity; narrow its reviewed scope or use full extraction.",
      );
    }
    source.push(record);
  }
  const selected = sampleShapeGraph({
    records: source,
    policy,
    privacyKey,
    keyContext,
  });
  const sanitized = selected.records.map((record) => {
    throwIfOperationCancelled();
    const result = privacyEngine.sanitize(record);
    if (!result)
      throw new Error(
        "A selected shape row was excluded by privacy; review the shape scope.",
      );
    return result;
  });
  const evidence = createBaselineShapeEvidence({
    source,
    selected: selected.records,
    sanitized,
    policy,
    generationId,
    privacyPolicySha256,
    sourceSchemaSha256,
    sourceSnapshotSha256,
    keyContext,
  });
  return Object.freeze({ records: Object.freeze(sanitized), evidence });
};
