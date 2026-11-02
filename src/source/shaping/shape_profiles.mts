/** Classify only explicitly declared fields; never retain source literals. */

import type {
  BaselineShapePolicy,
  ShapeDistribution,
  ShapeGoal,
  ShapeRecord,
} from "./shape_contract.mjs";
import { shapeTableIdentity } from "./shape_contract.mjs";
import { shapeKeyTuple, shapeKeyFormats } from "./shape_keys.mjs";
import type { ShapeKeyContext } from "./shape_keys.mjs";

const decimalSpelling = (value: string): string => {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(value);
  if (!match)
    throw new Error("A shape numeric field is not a canonical decimal.");
  const digits = `${match[2]}${match[3] ?? ""}`;
  const point = match[2]!.length + Number(match[4] ?? 0);
  const expanded =
    point < 1
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const normalized = expanded.includes(".")
    ? expanded.replace(/0+$/u, "").replace(/\.$/u, "")
    : expanded;
  return `${match[1]}${normalized}`;
};

const measuredNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.length <= 256 &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
  ) {
    const converted = Number(value);
    if (
      Number.isFinite(converted) &&
      Math.abs(converted) <= Number.MAX_SAFE_INTEGER &&
      decimalSpelling(value) === decimalSpelling(String(converted))
    )
      return converted;
  }
  throw new Error(
    "A shape numeric field requires finite numbers or losslessly representable canonical PostgreSQL decimals.",
  );
};

export const distributionBucketNames = (
  goal: ShapeDistribution,
): readonly string[] => {
  if (goal.kind === "null") return ["null", "non-null"];
  if (goal.kind === "boolean") return ["null", "false", "true"];
  if (goal.kind === "empty") return ["null", "empty", "non-empty"];
  if (goal.kind === "enum")
    return [
      "null",
      ...goal.values.map((_, index) => `category-${index}`),
      ...(goal.includeOther ? ["other"] : []),
    ];
  if (goal.kind.endsWith("-extrema"))
    return ["null", "minimum", "maximum", "minimum-maximum", "interior"];
  if (goal.kind === "relationship-fanout")
    return goal.boundaries.join(",") === "1,2"
      ? ["zero", "one", "many"]
      : Array.from(
          { length: goal.boundaries.length + 1 },
          (_, index) => `bucket-${index}`,
        );
  return [
    "null",
    ...Array.from(
      { length: goal.boundaries.length + 1 },
      (_, index) => `bucket-${index}`,
    ),
  ];
};

export const allShapeGoals = (
  policy: BaselineShapePolicy,
): readonly ShapeGoal[] => [
  ...policy.distributions,
  ...policy.jointDistributions,
];

export const shapeGoalBucketNames = (goal: ShapeGoal): readonly string[] =>
  "goals" in goal
    ? Array.from({ length: goal.bucketCount }, (_, index) => `joint-${index}`)
    : distributionBucketNames(goal);

const measure = (kind: ShapeDistribution["kind"], value: unknown): number => {
  if (kind.startsWith("number")) return measuredNumber(value);
  if (kind.startsWith("timestamp")) {
    if (
      !(value instanceof Date) &&
      (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
          value,
        ))
    ) {
      throw new Error(
        "A shape timestamp field requires an explicit zoned timestamp.",
      );
    }
    const measured =
      value instanceof Date ? value.valueOf() : Date.parse(value);
    if (!Number.isFinite(measured))
      throw new Error("A shape timestamp is invalid.");
    return measured;
  }
  if (kind.startsWith("string-length")) {
    if (typeof value !== "string")
      throw new Error("A shape string-length field requires text.");
    let length = 0;
    for (const _character of value) length += 1;
    return length;
  }
  if (!Array.isArray(value))
    throw new Error("A shape array-length field requires an array.");
  return value.length;
};

export const classifyShapeBucket = (
  goal: ShapeDistribution,
  row: Readonly<Record<string, unknown>>,
  context: Readonly<{
    minimum?: number;
    maximum?: number;
    fanout?: number;
  }> = {},
): string => {
  if (goal.kind === "relationship-fanout") {
    if (!Number.isSafeInteger(context.fanout) || context.fanout! < 0)
      throw new Error("A declared shape fan-out could not be measured.");
    const index = goal.boundaries.findIndex(
      (boundary) => context.fanout! < boundary,
    );
    const position = index < 0 ? goal.boundaries.length : index;
    return goal.boundaries.join(",") === "1,2"
      ? ["zero", "one", "many"][position]!
      : `bucket-${position}`;
  }
  if (!goal.column || !Object.hasOwn(row, goal.column)) {
    throw new Error(
      "A declared shape field is missing; review source and privacy scope.",
    );
  }
  const value = row[goal.column];
  if (value === null) return "null";
  if (goal.kind === "null") return "non-null";
  if (goal.kind === "enum") {
    const index = goal.values.findIndex((member) => member === value);
    if (index >= 0) return `category-${index}`;
    if (goal.includeOther) return "other";
    throw new Error(
      "A shape category is outside its reviewed structural classes; no source value was printed.",
    );
  }
  if (goal.kind === "empty") {
    if (typeof value === "string" || Array.isArray(value))
      return value.length === 0 ? "empty" : "non-empty";
    if (
      value &&
      typeof value === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return Object.keys(value).length === 0 ? "empty" : "non-empty";
    throw new Error(
      "A shape empty-class field requires text, an array, or a reviewed plain JSON object.",
    );
  }
  if (goal.kind === "boolean") {
    if (typeof value !== "boolean")
      throw new Error("A shape boolean field has an incompatible value.");
    return value ? "true" : "false";
  }
  const measured = measure(goal.kind, value);
  if (goal.kind.endsWith("-extrema")) {
    if (context.minimum === undefined || context.maximum === undefined)
      throw new Error("A shape extremum could not be measured.");
    if (measured === context.minimum && measured === context.maximum)
      return "minimum-maximum";
    if (measured === context.minimum) return "minimum";
    if (measured === context.maximum) return "maximum";
    return "interior";
  }
  const index = goal.boundaries.findIndex((boundary) => measured < boundary);
  return `bucket-${index < 0 ? goal.boundaries.length : index}`;
};

export interface ShapeProfiles {
  readonly counts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly assignments: ReadonlyMap<string, ReadonlyMap<ShapeRecord, string>>;
}

export const profileShapeRecords = (
  records: readonly ShapeRecord[],
  policy: BaselineShapePolicy,
  keyContext?: ShapeKeyContext,
): ShapeProfiles => {
  const goals = allShapeGoals(policy);
  const rowsByTable = new Map<string, ShapeRecord[]>();
  for (const record of records) {
    const key = shapeTableIdentity(record.schema ?? "public", record.table);
    const rows = rowsByTable.get(key) ?? [];
    rows.push(record);
    rowsByTable.set(key, rows);
  }
  const cells = goals.reduce((sum, goal) => {
    const rows =
      rowsByTable.get(shapeTableIdentity(goal.schema, goal.table))?.length ?? 0;
    if (!("kind" in goal)) return sum + rows;
    const relation = goal.relationship
      ? policy.relationships.find(
          (relation) => relation.id === goal.relationship,
        )
      : undefined;
    const childRows = relation
      ? (rowsByTable.get(
          shapeTableIdentity(relation.child.schema, relation.child.table),
        )?.length ?? 0)
      : 0;
    return sum + rows + childRows + (goal.kind.endsWith("-extrema") ? rows : 0);
  }, 0);
  if (cells > 1_000_000)
    throw new Error(
      "Shape profiling exceeds its one-million-cell work boundary; reduce goals or approved source rows.",
    );
  const result = new Map<string, Map<string, number>>();
  const assignments = new Map<string, Map<ShapeRecord, string>>();
  for (const goal of goals) {
    result.set(
      goal.id,
      new Map(shapeGoalBucketNames(goal).map((name) => [name, 0])),
    );
    assignments.set(goal.id, new Map());
  }
  for (const goal of policy.distributions) {
    const rows =
      rowsByTable.get(shapeTableIdentity(goal.schema, goal.table)) ?? [];
    const context: { minimum?: number; maximum?: number } = {};
    if (goal.kind.endsWith("-extrema")) {
      for (const record of rows) {
        if (!goal.column || !Object.hasOwn(record.row, goal.column))
          throw new Error("A declared shape edge field is missing.");
        if (record.row[goal.column] === null) continue;
        const value = measure(goal.kind, record.row[goal.column]);
        context.minimum = Math.min(context.minimum ?? value, value);
        context.maximum = Math.max(context.maximum ?? value, value);
      }
    }
    const fanout = new Map<string, number>();
    const relation = goal.relationship
      ? policy.relationships.find(
          (relation) => relation.id === goal.relationship,
        )
      : undefined;
    if (goal.kind === "relationship-fanout") {
      if (!relation)
        throw new Error("Shape fan-out relationship was not declared.");
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
        if (key !== null) fanout.set(key, (fanout.get(key) ?? 0) + 1);
      }
    }
    for (const record of rows) {
      const bucket = classifyShapeBucket(
        goal,
        record.row,
        relation
          ? {
              ...context,
              fanout:
                fanout.get(
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
                ) ?? 0,
            }
          : context,
      );
      const counts = result.get(goal.id)!;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      assignments.get(goal.id)!.set(record, bucket);
    }
  }
  const declarations = new Map(
    policy.distributions.map((goal) => [goal.id, goal]),
  );
  for (const goal of policy.jointDistributions) {
    const rows =
      rowsByTable.get(shapeTableIdentity(goal.schema, goal.table)) ?? [];
    for (const record of rows) {
      let index = 0;
      for (const component of goal.goals) {
        const names = distributionBucketNames(declarations.get(component)!);
        const value = assignments.get(component)!.get(record);
        const position = names.indexOf(value!);
        if (position < 0)
          throw new Error("Joint shape component evidence is unavailable.");
        index = index * names.length + position;
      }
      const bucket = `joint-${index}`;
      const counts = result.get(goal.id)!;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      assignments.get(goal.id)!.set(record, bucket);
    }
  }
  return Object.freeze({ counts: result, assignments });
};
