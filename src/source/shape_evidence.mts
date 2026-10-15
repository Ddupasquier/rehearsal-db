/** Bind aggregate shape evidence to exact sanitized bytes and reviewed policies. */

import { createHash } from "node:crypto";
import type {
  BaselineShapeEvidence,
  BaselineShapePolicy,
  ShapeBucketEvidence,
  ShapeRecord,
} from "./shape_contract.mjs";
import { shapeTableIdentity } from "./shape_contract.mjs";
import {
  allShapeGoals,
  shapeGoalBucketNames,
  profileShapeRecords,
} from "./shape_profiles.mjs";
import { shapePolicySha256 } from "./shape_policy.mjs";
import { shapeKeyTuple, shapeKeyFormats } from "./shape_keys.mjs";
import type { ShapeKeyContext } from "./shape_keys.mjs";
import { REHEARSAL_VERSION, RehearsalError } from "../shared/diagnostics.mjs";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const shapeEvidenceSha256 = (
  evidence: Omit<BaselineShapeEvidence, "evidenceSha256">,
): string => sha256(canonical(evidence));

const tableCounts = (
  records: readonly ShapeRecord[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const row of records) {
    const table = shapeTableIdentity(row.schema ?? "public", row.table);
    counts.set(table, (counts.get(table) ?? 0) + 1);
  }
  return counts;
};

export const verifyShapedRelationships = (
  records: readonly ShapeRecord[],
  policy: BaselineShapePolicy,
  keyContext?: ShapeKeyContext,
): readonly {
  readonly id: string;
  readonly checkedRows: number;
  readonly status: "passed";
}[] => {
  const rowsByTable = new Map<string, ShapeRecord[]>();
  for (const record of records) {
    const table = shapeTableIdentity(record.schema ?? "public", record.table);
    const rows = rowsByTable.get(table) ?? [];
    rows.push(record);
    rowsByTable.set(table, rows);
  }
  for (const table of policy.tables) {
    const keys = new Set<string>();
    for (const record of rowsByTable.get(
      shapeTableIdentity(table.schema, table.name),
    ) ?? []) {
      const key = shapeKeyTuple(
        record.row,
        table.key,
        false,
        shapeKeyFormats(keyContext, table.schema, table.name, table.key),
      )!;
      if (keys.has(key))
        throw new Error(
          "Sanitization produced duplicate shape keys; review pseudonym and replacement declarations.",
        );
      keys.add(key);
    }
  }
  return policy.relationships.map((relation) => {
    const parentKeys = new Set(
      (
        rowsByTable.get(
          shapeTableIdentity(relation.parent.schema, relation.parent.table),
        ) ?? []
      ).map((record) =>
        shapeKeyTuple(
          record.row,
          relation.parent.columns,
          false,
          shapeKeyFormats(
            keyContext,
            relation.parent.schema,
            relation.parent.table,
            relation.parent.columns,
          ),
        )!,
      ),
    );
    let checkedRows = 0;
    for (const record of rowsByTable.get(
      shapeTableIdentity(relation.child.schema, relation.child.table),
    ) ?? []) {
      const key = shapeKeyTuple(
        record.row,
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
      if (!parentKeys.has(key))
        throw new Error(
          "A sanitized shape relationship is broken; review privacy namespaces and key transformations.",
        );
      checkedRows += 1;
    }
    return Object.freeze({
      id: relation.id,
      checkedRows,
      status: "passed" as const,
    });
  });
};

export const createBaselineShapeEvidence = ({
  source,
  selected,
  sanitized,
  policy,
  generationId,
  privacyPolicySha256,
  sourceSchemaSha256,
  sourceSnapshotSha256,
  keyContext,
}: {
  readonly source: readonly ShapeRecord[];
  readonly selected: readonly ShapeRecord[];
  readonly sanitized: readonly ShapeRecord[];
  readonly policy: BaselineShapePolicy;
  readonly generationId: string;
  readonly privacyPolicySha256: string;
  readonly sourceSchemaSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly keyContext?: ShapeKeyContext | undefined;
}): BaselineShapeEvidence => {
  const sourceCounts = tableCounts(source);
  const selectedCounts = tableCounts(selected);
  const emittedCounts = tableCounts(sanitized);
  const sourceProfiles = profileShapeRecords(source, policy, keyContext);
  const baselineProfiles = profileShapeRecords(sanitized, policy, keyContext);
  const originalByKey = new Map<string, ShapeRecord>();
  const declarations = new Map(
    policy.tables.map((table) => [
      shapeTableIdentity(table.schema, table.name),
      table,
    ]),
  );
  const rowIdentity = (record: ShapeRecord): string => {
    const table = shapeTableIdentity(record.schema ?? "public", record.table);
    const declaration = declarations.get(table);
    if (!declaration)
      throw new Error("Shape evidence contains an undeclared table.");
    return `${table}\0${shapeKeyTuple(record.row, declaration.key, false, shapeKeyFormats(keyContext, declaration.schema, declaration.name, declaration.key))!}`;
  };
  for (const record of source) originalByKey.set(rowIdentity(record), record);
  const selectedOriginals = selected.map((record) => {
    const original = originalByKey.get(rowIdentity(record));
    if (!original)
      throw new Error(
        "Shape selection does not belong to its reviewed source snapshot.",
      );
    return original;
  });
  const warnings: string[] = [];
  const distributions = allShapeGoals(policy).map((goal) => {
    const table = shapeTableIdentity(goal.schema, goal.table);
    const sourceTotal = sourceCounts.get(table) ?? 0;
    const baselineTotal = emittedCounts.get(table) ?? 0;
    const selectedBucketCounts = new Map<string, number>();
    for (const record of selectedOriginals) {
      const bucket = sourceProfiles.assignments.get(goal.id)!.get(record);
      if (bucket !== undefined)
        selectedBucketCounts.set(
          bucket,
          (selectedBucketCounts.get(bucket) ?? 0) + 1,
        );
    }
    const measuredBuckets: ShapeBucketEvidence[] = shapeGoalBucketNames(
      goal,
    ).map((bucket) => {
      const sourceCount = sourceProfiles.counts.get(goal.id)!.get(bucket) ?? 0;
      const selectedSourceCount = selectedBucketCounts.get(bucket) ?? 0;
      const baselineCount =
        baselineProfiles.counts.get(goal.id)!.get(bucket) ?? 0;
      const difference =
        sourceTotal && baselineTotal
          ? Math.abs(sourceCount / sourceTotal - baselineCount / baselineTotal)
          : sourceTotal === baselineTotal
            ? 0
            : 1;
      const suppressed =
        (sourceCount > 0 && sourceCount < policy.minimumCohortSize) ||
        (selectedSourceCount > 0 &&
          selectedSourceCount < policy.minimumCohortSize) ||
        (baselineCount > 0 && baselineCount < policy.minimumCohortSize);
      const failed =
        difference > goal.tolerance + Number.EPSILON ||
        (sourceCount >= policy.minimumCohortSize &&
          (selectedSourceCount < goal.minimumBucketRows ||
            baselineCount < goal.minimumBucketRows)) ||
        (goal.requiredBuckets.includes(bucket) &&
          (sourceCount < goal.minimumBucketRows ||
            selectedSourceCount < goal.minimumBucketRows ||
            baselineCount < goal.minimumBucketRows));
      const reason = suppressed
        ? "privacy-cohort"
        : difference > goal.tolerance + Number.EPSILON
          ? "outside-tolerance"
          : goal.requiredBuckets.includes(bucket) &&
              sourceCount < goal.minimumBucketRows
            ? "missing-required-source-class"
            : (sourceCount >= policy.minimumCohortSize ||
                  goal.requiredBuckets.includes(bucket)) &&
                selectedSourceCount < goal.minimumBucketRows
              ? "insufficient-selected-class"
              : (sourceCount >= policy.minimumCohortSize ||
                    goal.requiredBuckets.includes(bucket)) &&
                  baselineCount < goal.minimumBucketRows
                ? "insufficient-sanitized-class"
                : "within-tolerance";
      const disposition =
        sourceCount === 0
          ? baselineCount === 0
            ? "absent"
            : "introduced"
          : selectedSourceCount === 0
            ? "omitted"
            : baselineCount === 0
              ? "transformed"
              : "represented";
      return Object.freeze({
        bucket,
        sourceCount: suppressed ? null : sourceCount,
        selectedSourceCount: suppressed ? null : selectedSourceCount,
        baselineCount: suppressed ? null : baselineCount,
        disposition: suppressed ? "suppressed" : disposition,
        difference: suppressed ? null : difference,
        suppressed,
        reason,
        status: suppressed
          ? ("suppressed" as const)
          : failed
            ? ("failed" as const)
            : ("passed" as const),
      });
    });
    // Complementary suppression prevents a hidden rare count being recovered
    // by subtracting the remaining disclosed buckets from the table total.
    const hideGoalCounts = measuredBuckets.some((bucket) => bucket.suppressed);
    const buckets: readonly ShapeBucketEvidence[] = hideGoalCounts
      ? measuredBuckets.map((bucket) =>
          Object.freeze({
            bucket: bucket.bucket,
            sourceCount: null,
            selectedSourceCount: null,
            baselineCount: null,
            disposition: "suppressed" as const,
            difference: null,
            suppressed: true,
            reason: "privacy-cohort" as const,
            status: "suppressed" as const,
          }),
        )
      : measuredBuckets;
    const status = buckets.some((bucket) => bucket.status === "failed")
      ? ("failed" as const)
      : buckets.some((bucket) => bucket.suppressed)
        ? ("suppressed" as const)
        : ("passed" as const);
    if (goal.required && status !== "passed") {
      throw new RehearsalError({
        category: "baseline_invalid",
        code: "SHAPE_FIDELITY_REFUSED",
        message: `Required shape goal ${goal.id} could not be proved within its privacy cohort, row budget, and tolerance. The prior baseline remains active.`,
        expected:
          "every required goal proved within its reviewed tolerance and minimum privacy cohort",
        actual: "a failed or suppressed required goal",
        refused: "No new baseline was activated and no runtime was reset.",
        suggestions: [
          "Review the shape policy: increase its safe row budget, revise reviewed tolerances, or mark the goal advisory only when that loss is acceptable.",
          "Do not lower privacy cohort protection to conceal a unique or unsafe source class.",
        ],
      });
    }
    if (status !== "passed")
      warnings.push(
        `Advisory shape goal ${goal.id}: ${status}; no preservation claim is made.`,
      );
    return Object.freeze({
      id: goal.id,
      required: goal.required,
      tolerance: goal.tolerance,
      status,
      buckets: Object.freeze(buckets),
    });
  });
  const dataHash = createHash("sha256");
  for (const record of sanitized)
    dataHash.update(`${JSON.stringify(record)}\n`);
  const evidence: Omit<BaselineShapeEvidence, "evidenceSha256"> = {
    shapeVersion: 1,
    algorithm: "bounded-keyed-graph-v1",
    rehearsalVersion: REHEARSAL_VERSION,
    generationId,
    baselineDataSha256: dataHash.digest("hex"),
    policySha256: shapePolicySha256(policy),
    privacyPolicySha256,
    sourceSchemaSha256,
    sourceSnapshotSha256,
    seedSha256: sha256(policy.seed),
    maximumRows: policy.maximumRows,
    maximumSourceRows: policy.maximumSourceRows,
    maximumSourceBytes: policy.maximumSourceBytes,
    maximumDepth: policy.maximumDepth,
    minimumCohortSize: policy.minimumCohortSize,
    tables: Object.freeze(
      policy.tables.map((table) => {
        const identity = shapeTableIdentity(table.schema, table.name);
        return Object.freeze({
          schema: table.schema,
          table: table.name,
          sourceRows: sourceCounts.get(identity) ?? 0,
          selectedRows: selectedCounts.get(identity) ?? 0,
          emittedRows: emittedCounts.get(identity) ?? 0,
        });
      }),
    ),
    relationships: Object.freeze(
      verifyShapedRelationships(sanitized, policy, keyContext),
    ),
    distributions: Object.freeze(distributions),
    warnings: Object.freeze(warnings),
    limitations: Object.freeze([
      "Only explicitly declared relationships and fields are measured; this is not production equivalence.",
      "The approved source graph is capped in memory; larger exports must narrow their reviewed scope or use full extraction.",
      "One declared joint or scalar goal per root table drives stratification; other goals are verified, not silently optimized. Impossible competing goals refuse when required.",
      "Private low-count buckets are suppressed. Required goals with suppressed evidence refuse activation.",
      "Cohort suppression is not formal anonymity against prior knowledge or combinations of separately reviewed reports.",
      "Edge classes are measured before selection and again after privacy transformation. Selected, omitted and transformed classes are reported without raw literals.",
      "No synthetic rows are generated. Unique or insufficiently represented edge classes cannot be certified below the privacy cohort.",
    ]),
  };
  return Object.freeze({
    ...evidence,
    evidenceSha256: shapeEvidenceSha256(evidence),
  });
};

const exactObject = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Shape evidence has an invalid object.");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error("Shape evidence contains missing or unexpected fields.");
  }
  return object;
};

const boundedList = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error("Shape evidence exceeds its list boundary.");
  return value;
};
const safeCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validName = (value: unknown): boolean =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);

export const verifyBaselineShapeEvidence = (
  value: unknown,
  expected: Readonly<{
    generationId?: string;
    baselineDataSha256?: string;
    policySha256?: string;
    privacyPolicySha256?: string;
    sourceSchemaSha256?: string;
  }> = {},
): BaselineShapeEvidence => {
  const evidence = exactObject(value, [
    "shapeVersion",
    "algorithm",
    "rehearsalVersion",
    "generationId",
    "baselineDataSha256",
    "policySha256",
    "privacyPolicySha256",
    "sourceSchemaSha256",
    "sourceSnapshotSha256",
    "seedSha256",
    "maximumRows",
    "maximumSourceRows",
    "maximumSourceBytes",
    "maximumDepth",
    "minimumCohortSize",
    "tables",
    "relationships",
    "distributions",
    "warnings",
    "limitations",
    "evidenceSha256",
  ]);
  if (
    evidence.shapeVersion !== 1 ||
    evidence.algorithm !== "bounded-keyed-graph-v1" ||
    typeof evidence.generationId !== "string" ||
    !/^\d{8}T\d{6}Z-[a-f0-9]{12}$/u.test(evidence.generationId) ||
    !safeCount(evidence.maximumRows) ||
    Number(evidence.maximumRows) < 1 ||
    Number(evidence.maximumRows) > 100_000 ||
    !safeCount(evidence.minimumCohortSize) ||
    Number(evidence.minimumCohortSize) < 2 ||
    Number(evidence.minimumCohortSize) > 1000
  ) {
    throw new Error("Shape evidence version or boundaries are invalid.");
  }
  if (
    typeof evidence.rehearsalVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(evidence.rehearsalVersion) ||
    !safeCount(evidence.maximumSourceRows) ||
    Number(evidence.maximumSourceRows) < Number(evidence.maximumRows) ||
    Number(evidence.maximumSourceRows) > 100_000 ||
    !safeCount(evidence.maximumSourceBytes) ||
    Number(evidence.maximumSourceBytes) < 1 ||
    Number(evidence.maximumSourceBytes) > 128 * 1024 * 1024 ||
    !safeCount(evidence.maximumDepth) ||
    Number(evidence.maximumDepth) < 1 ||
    Number(evidence.maximumDepth) > 32
  ) {
    throw new Error(
      "Shape evidence runtime version or source capacity is invalid.",
    );
  }
  for (const field of [
    "baselineDataSha256",
    "policySha256",
    "privacyPolicySha256",
    "sourceSchemaSha256",
    "sourceSnapshotSha256",
    "seedSha256",
    "evidenceSha256",
  ]) {
    if (
      typeof evidence[field] !== "string" ||
      !/^[a-f0-9]{64}$/u.test(evidence[field])
    ) {
      throw new Error("Shape evidence requires exact digest receipts.");
    }
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && evidence[field] !== expectedValue)
      throw new Error(
        "Shape evidence does not match its immutable baseline or reviewed policy.",
      );
  }
  let emitted = 0;
  const tableIds = new Set<string>();
  for (const value of boundedList(evidence.tables, 100)) {
    const table = exactObject(value, [
      "schema",
      "table",
      "sourceRows",
      "selectedRows",
      "emittedRows",
    ]);
    if (
      !validName(table.schema) ||
      !validName(table.table) ||
      ![table.sourceRows, table.selectedRows, table.emittedRows].every(
        safeCount,
      ) ||
      Number(table.selectedRows) > Number(table.sourceRows) ||
      table.emittedRows !== table.selectedRows
    ) {
      throw new Error("Shape table evidence is invalid or contradictory.");
    }
    const id = `${String(table.schema)}.${String(table.table)}`;
    if (tableIds.has(id)) throw new Error("Shape evidence repeats a table.");
    tableIds.add(id);
    emitted += Number(table.emittedRows);
  }
  if (emitted > Number(evidence.maximumRows))
    throw new Error("Shape evidence exceeds its row budget.");
  for (const value of boundedList(evidence.relationships, 200)) {
    const relation = exactObject(value, ["id", "checkedRows", "status"]);
    if (
      !validName(relation.id) ||
      !safeCount(relation.checkedRows) ||
      relation.status !== "passed"
    ) {
      throw new Error("Shape relationship evidence is invalid.");
    }
  }
  for (const value of boundedList(evidence.distributions, 120)) {
    const goal = exactObject(value, [
      "id",
      "required",
      "tolerance",
      "status",
      "buckets",
    ]);
    if (
      !validName(goal.id) ||
      typeof goal.required !== "boolean" ||
      typeof goal.tolerance !== "number" ||
      !Number.isFinite(goal.tolerance) ||
      goal.tolerance < 0 ||
      goal.tolerance > 1 ||
      !["passed", "failed", "suppressed"].includes(String(goal.status)) ||
      (goal.required && goal.status !== "passed")
    )
      throw new Error("Shape distribution evidence is invalid.");
    const buckets = boundedList(goal.buckets, 64);
    if (
      buckets.some(
        (bucket) => (bucket as Record<string, unknown>)?.suppressed === true,
      ) &&
      buckets.some(
        (bucket) => (bucket as Record<string, unknown>)?.suppressed !== true,
      )
    ) {
      throw new Error("Shape evidence lacks complementary cohort suppression.");
    }
    const bucketNames = new Set<string>();
    for (const value of buckets) {
      const bucket = exactObject(value, [
        "bucket",
        "sourceCount",
        "selectedSourceCount",
        "baselineCount",
        "disposition",
        "difference",
        "suppressed",
        "reason",
        "status",
      ]);
      if (
        typeof bucket.bucket !== "string" ||
        !/^(?:null|non-null|true|false|empty|non-empty|other|minimum|maximum|minimum-maximum|interior|zero|one|many|(?:bucket|category|joint)-\d{1,2})$/u.test(
          bucket.bucket,
        ) ||
        typeof bucket.suppressed !== "boolean" ||
        ![
          "within-tolerance",
          "outside-tolerance",
          "missing-required-source-class",
          "insufficient-selected-class",
          "insufficient-sanitized-class",
          "privacy-cohort",
        ].includes(String(bucket.reason)) ||
        ![
          "represented",
          "transformed",
          "omitted",
          "absent",
          "introduced",
          "suppressed",
        ].includes(String(bucket.disposition)) ||
        !["passed", "failed", "suppressed"].includes(String(bucket.status)) ||
        (bucket.suppressed
          ? bucket.sourceCount !== null ||
            bucket.selectedSourceCount !== null ||
            bucket.baselineCount !== null ||
            bucket.disposition !== "suppressed" ||
            bucket.difference !== null ||
            bucket.status !== "suppressed"
          : !safeCount(bucket.sourceCount) ||
            !safeCount(bucket.selectedSourceCount) ||
            !safeCount(bucket.baselineCount) ||
            bucket.disposition === "suppressed" ||
            typeof bucket.difference !== "number" ||
            !Number.isFinite(bucket.difference) ||
            bucket.difference < 0 ||
            bucket.difference > 1 ||
            bucket.status === "suppressed")
      ) {
        throw new Error(
          "Shape bucket evidence is invalid or leaks an unsafe cohort.",
        );
      }
      if (
        (bucket.status === "passed" && bucket.reason !== "within-tolerance") ||
        (bucket.status === "suppressed" &&
          bucket.reason !== "privacy-cohort") ||
        (bucket.status === "failed" &&
          ["within-tolerance", "privacy-cohort"].includes(
            String(bucket.reason),
          ))
      ) {
        throw new Error(
          "Shape bucket explanation contradicts its gate status.",
        );
      }
      if (
        !bucket.suppressed &&
        [
          bucket.sourceCount,
          bucket.selectedSourceCount,
          bucket.baselineCount,
        ].some(
          (count) =>
            Number(count) > 0 &&
            Number(count) < Number(evidence.minimumCohortSize),
        )
      ) {
        throw new Error("Shape bucket evidence exposes a low-count cohort.");
      }
      if (bucketNames.has(String(bucket.bucket)))
        throw new Error("Shape evidence repeats a bucket.");
      bucketNames.add(String(bucket.bucket));
      if (
        !bucket.suppressed &&
        ((bucket.status === "passed" &&
          Number(bucket.difference) > goal.tolerance + Number.EPSILON) ||
          Number(bucket.sourceCount) > 100_000 ||
          Number(bucket.selectedSourceCount) > Number(bucket.sourceCount) ||
          Number(bucket.selectedSourceCount) > Number(evidence.maximumRows) ||
          Number(bucket.baselineCount) > Number(evidence.maximumRows))
      ) {
        throw new Error(
          "Shape bucket evidence contradicts its tolerance or row boundary.",
        );
      }
      if (!bucket.suppressed) {
        const disposition =
          Number(bucket.sourceCount) === 0
            ? Number(bucket.baselineCount) === 0
              ? "absent"
              : "introduced"
            : Number(bucket.selectedSourceCount) === 0
              ? "omitted"
              : Number(bucket.baselineCount) === 0
                ? "transformed"
                : "represented";
        if (bucket.disposition !== disposition)
          throw new Error(
            "Shape class disposition contradicts its aggregate counts.",
          );
      }
    }
    const actualStatus = buckets.some(
      (value) => (value as Record<string, unknown>).status === "failed",
    )
      ? "failed"
      : buckets.some(
            (value) =>
              (value as Record<string, unknown>).status === "suppressed",
          )
        ? "suppressed"
        : "passed";
    if (actualStatus !== goal.status)
      throw new Error("Shape goal status contradicts its bucket evidence.");
  }
  for (const field of ["warnings", "limitations"]) {
    if (
      boundedList(evidence[field], 100).some(
        (value) => typeof value !== "string" || value.length > 500,
      )
    ) {
      throw new Error("Shape evidence explanation exceeds its safe boundary.");
    }
  }
  const { evidenceSha256, ...unsigned } = evidence;
  if (
    shapeEvidenceSha256(
      unsigned as unknown as Omit<BaselineShapeEvidence, "evidenceSha256">,
    ) !== evidenceSha256
  ) {
    throw new Error("Shape evidence checksum is invalid.");
  }
  return evidence as unknown as BaselineShapeEvidence;
};
