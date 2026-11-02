/** Fail-closed validation for bounded graph and distribution declarations. */

import { createHash } from "node:crypto";
import type {
  BaselineShapePolicy,
  ShapeDistributionKind,
  ShapeEndpoint,
} from "./shape_contract.mjs";
import { shapeTableIdentity } from "./shape_contract.mjs";
import { distributionBucketNames } from "./shape_profiles.mjs";

const object = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Shape declarations must be plain objects.");
  return value as Record<string, unknown>;
};

const keys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Shape declaration contains an unknown field.");
  }
};

const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("Shape declarations require bounded SQL identifiers.");
  }
  return value;
};

const integer = (value: unknown, minimum: number, maximum: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("Shape declaration exceeds a reviewed numeric boundary.");
  }
  return value;
};

const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean")
    throw new Error("Shape flag must be explicit.");
  return value;
};

const list = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error("Shape declaration list is missing or exceeds its limit.");
  }
  return value;
};

const columns = (value: unknown): readonly string[] => {
  const names = list(value, 8).map(identifier);
  if (!names.length || new Set(names).size !== names.length) {
    throw new Error("Shape key columns must be nonempty and unique.");
  }
  return Object.freeze(names);
};

const endpoint = (value: unknown): ShapeEndpoint => {
  const input = object(value);
  keys(input, ["schema", "table", "columns"]);
  return Object.freeze({
    schema: identifier(input.schema ?? "public"),
    table: identifier(input.table),
    columns: columns(input.columns),
  });
};

const distinct = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) {
    throw new Error(`Shape ${label} declarations are duplicated.`);
  }
};

export const shapePolicySha256 = (policy: BaselineShapePolicy): string =>
  createHash("sha256").update(JSON.stringify(policy)).digest("hex");

export const validateBaselineShapePolicy = (
  value: unknown,
): BaselineShapePolicy => {
  const input = object(value);
  keys(input, [
    "shapeVersion",
    "seed",
    "maximumSourceRows",
    "maximumSourceBytes",
    "maximumRows",
    "maximumDepth",
    "minimumCohortSize",
    "tables",
    "relationships",
    "distributions",
    "jointDistributions",
  ]);
  if (input.shapeVersion !== 1)
    throw new Error("Unsupported shape policy version.");
  if (
    typeof input.seed !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,128}$/u.test(input.seed)
  ) {
    throw new Error(
      "Shape seed must be a bounded, non-secret reproducibility label.",
    );
  }
  const maximumSourceRows = integer(
    input.maximumSourceRows ?? 10_000,
    1,
    100_000,
  );
  const maximumRows = integer(input.maximumRows, 1, maximumSourceRows);
  const tables = list(input.tables, 100).map((value) => {
    const table = object(value);
    keys(table, [
      "schema",
      "name",
      "key",
      "maximumRows",
      "rootRows",
      "requiredKeySha256",
    ]);
    const tableMaximum = integer(table.maximumRows, 1, maximumRows);
    const requiredKeySha256 = list(table.requiredKeySha256 ?? [], 100).map(
      (hash) => {
        if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
          throw new Error(
            "Required shape keys must be SHA-256 receipts, never raw keys.",
          );
        }
        return hash;
      },
    );
    distinct(requiredKeySha256, "required-key");
    return Object.freeze({
      schema: identifier(table.schema ?? "public"),
      name: identifier(table.name),
      key: columns(table.key),
      maximumRows: tableMaximum,
      rootRows: integer(table.rootRows ?? 0, 0, tableMaximum),
      requiredKeySha256: Object.freeze(requiredKeySha256),
    });
  });
  if (
    !tables.length ||
    !tables.some((table) => table.rootRows || table.requiredKeySha256.length)
  ) {
    throw new Error(
      "Shape policy requires at least one explicit root or required inclusion.",
    );
  }
  distinct(
    tables.map((table) => shapeTableIdentity(table.schema, table.name)),
    "table",
  );
  const knownTables = new Map(
    tables.map((table) => [
      shapeTableIdentity(table.schema, table.name),
      table,
    ]),
  );
  const relationships = list(input.relationships ?? [], 200).map((value) => {
    const relation = object(value);
    keys(relation, [
      "id",
      "parent",
      "child",
      "nullable",
      "includeChildren",
      "maximumChildrenPerParent",
      "maximumRows",
    ]);
    const parent = endpoint(relation.parent);
    const child = endpoint(relation.child);
    const parentTable = knownTables.get(
      shapeTableIdentity(parent.schema, parent.table),
    );
    const childTable = knownTables.get(
      shapeTableIdentity(child.schema, child.table),
    );
    if (
      !parentTable ||
      !childTable ||
      parent.columns.length !== child.columns.length ||
      parent.columns.join("\0") !== parentTable.key.join("\0")
    ) {
      throw new Error(
        "Shape relationship endpoints must name declared tables and the exact parent key.",
      );
    }
    return Object.freeze({
      id: identifier(relation.id),
      parent,
      child,
      nullable: boolean(relation.nullable),
      includeChildren: boolean(relation.includeChildren),
      maximumChildrenPerParent: integer(
        relation.maximumChildrenPerParent,
        0,
        maximumRows,
      ),
      maximumRows: integer(relation.maximumRows, 1, maximumRows),
    });
  });
  distinct(
    relationships.map((relation) => relation.id),
    "relationship",
  );
  const kinds = [
    "null",
    "boolean",
    "number",
    "timestamp",
    "string-length",
    "array-length",
    "enum",
    "empty",
    "relationship-fanout",
    "number-extrema",
    "timestamp-extrema",
    "string-length-extrema",
    "array-length-extrema",
  ];
  const distributions = list(input.distributions ?? [], 100).map((value) => {
    const distribution = object(value);
    keys(distribution, [
      "id",
      "schema",
      "table",
      "column",
      "kind",
      "boundaries",
      "required",
      "tolerance",
      "minimumBucketRows",
      "values",
      "includeOther",
      "relationship",
      "requiredBuckets",
    ]);
    if (!kinds.includes(String(distribution.kind)))
      throw new Error("Unsupported shape distribution kind.");
    const schema = identifier(distribution.schema ?? "public");
    const table = identifier(distribution.table);
    if (!knownTables.has(shapeTableIdentity(schema, table))) {
      throw new Error("Shape distributions may profile only declared tables.");
    }
    const kind = distribution.kind as ShapeDistributionKind;
    const boundaries = list(
      distribution.boundaries ?? (kind === "relationship-fanout" ? [1, 2] : []),
      30,
    ).map((boundary) => {
      if (typeof boundary !== "number" || !Number.isFinite(boundary)) {
        throw new Error(
          "Shape bucket boundaries must be finite reviewed numbers.",
        );
      }
      if (
        (kind === "string-length" ||
          kind === "array-length" ||
          kind === "relationship-fanout") &&
        (!Number.isSafeInteger(boundary) || boundary < 0)
      ) {
        throw new Error(
          "Shape length boundaries must be nonnegative integers.",
        );
      }
      return boundary;
    });
    if (
      boundaries.some(
        (boundary, index) => index > 0 && boundary <= boundaries[index - 1]!,
      ) ||
      ((["null", "boolean", "enum", "empty"].includes(kind) ||
        kind.endsWith("-extrema")) &&
        boundaries.length)
    ) {
      throw new Error(
        "Shape bucket boundaries are unordered or inappropriate for their kind.",
      );
    }
    const values = list(distribution.values ?? [], 16).map((value) => {
      if (
        (typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean") ||
        (typeof value === "string" && !/^[a-zA-Z0-9_-]{1,64}$/u.test(value)) ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new Error(
          "Shape enum classes must be reviewed structural codes, never identities, URLs, tokens, or private prose.",
        );
      }
      return value;
    });
    distinct(
      values.map((value) => JSON.stringify(value)),
      "enum-value",
    );
    if (
      (kind === "enum" && !values.length) ||
      (kind !== "enum" &&
        (values.length ||
          (distribution.includeOther !== undefined &&
            distribution.includeOther !== false)))
    ) {
      throw new Error(
        "Shape enum declarations must have an explicit nonempty value set and cannot apply to another kind.",
      );
    }
    const includeOther =
      distribution.includeOther === undefined
        ? false
        : boolean(distribution.includeOther);
    let relationship: string | null = null;
    if (kind === "relationship-fanout") {
      relationship = identifier(distribution.relationship);
      const declared = relationships.find(
        (relation) => relation.id === relationship,
      );
      if (
        !declared ||
        declared.parent.schema !== schema ||
        declared.parent.table !== table ||
        (distribution.column !== undefined && distribution.column !== null)
      ) {
        throw new Error(
          "Fan-out goals must name a declared relationship and its exact parent table, not a column.",
        );
      }
    } else if (
      distribution.relationship !== undefined &&
      distribution.relationship !== null
    ) {
      throw new Error(
        "Only relationship-fanout goals may name a relationship.",
      );
    }
    const tolerance = distribution.tolerance;
    if (
      typeof tolerance !== "number" ||
      !Number.isFinite(tolerance) ||
      tolerance < 0 ||
      tolerance > 1
    ) {
      throw new Error(
        "Shape tolerance must be a proportion from zero through one.",
      );
    }
    const normalized = {
      id: identifier(distribution.id),
      schema,
      table,
      column:
        kind === "relationship-fanout" ? null : identifier(distribution.column),
      kind,
      boundaries: Object.freeze(boundaries),
      required: boolean(distribution.required),
      tolerance,
      minimumBucketRows: integer(
        distribution.minimumBucketRows ?? 1,
        0,
        maximumRows,
      ),
      values: Object.freeze(values),
      includeOther,
      relationship,
      requiredBuckets: [] as readonly string[],
    };
    const requiredBuckets = list(distribution.requiredBuckets ?? [], 32).map(
      (value) => {
        if (
          typeof value !== "string" ||
          !distributionBucketNames(normalized).includes(value)
        ) {
          throw new Error(
            "Required shape buckets must name declared classes, never source values.",
          );
        }
        return value;
      },
    );
    distinct(requiredBuckets, "required-bucket");
    if (requiredBuckets.length && normalized.minimumBucketRows < 1)
      throw new Error(
        "Required shape classes need positive minimum representation.",
      );
    return Object.freeze({
      ...normalized,
      requiredBuckets: Object.freeze(requiredBuckets),
    });
  });
  distinct(
    distributions.map((distribution) => distribution.id),
    "distribution",
  );
  const distributionsById = new Map(
    distributions.map((goal) => [goal.id, goal]),
  );
  const jointDistributions = list(input.jointDistributions ?? [], 20).map(
    (value) => {
      const joint = object(value);
      keys(joint, [
        "id",
        "schema",
        "table",
        "goals",
        "required",
        "tolerance",
        "minimumBucketRows",
        "requiredBuckets",
        "bucketCount",
      ]);
      const schema = identifier(joint.schema ?? "public");
      const table = identifier(joint.table);
      const goals = list(joint.goals, 3).map(identifier);
      if (goals.length < 2 || new Set(goals).size !== goals.length)
        throw new Error(
          "Joint shapes require two or three distinct declared goal IDs.",
        );
      let bucketCount = 1;
      for (const id of goals) {
        const goal = distributionsById.get(id);
        if (!goal || goal.schema !== schema || goal.table !== table)
          throw new Error(
            "Joint shapes may combine only declared goals on the same table.",
          );
        bucketCount *= distributionBucketNames(goal).length;
      }
      if (bucketCount > 64)
        throw new Error(
          "Joint shape Cartesian classes exceed the explicit 64-bucket boundary.",
        );
      if (
        typeof joint.tolerance !== "number" ||
        !Number.isFinite(joint.tolerance) ||
        joint.tolerance < 0 ||
        joint.tolerance > 1
      ) {
        throw new Error(
          "Joint shape tolerance must be a proportion from zero through one.",
        );
      }
      const requiredBuckets = list(joint.requiredBuckets ?? [], 64).map(
        (value) => {
          if (
            typeof value !== "string" ||
            !/^joint-(?:0|[1-9]\d?)$/u.test(value) ||
            Number(value.slice(6)) >= bucketCount
          ) {
            throw new Error(
              "Required joint classes must name an in-bounds declared Cartesian bucket.",
            );
          }
          return value;
        },
      );
      if (joint.bucketCount !== undefined && joint.bucketCount !== bucketCount)
        throw new Error(
          "Joint shape normalized bucket count contradicts its declared component classes.",
        );
      distinct(requiredBuckets, "required-joint-bucket");
      const minimumBucketRows = integer(
        joint.minimumBucketRows ?? 1,
        requiredBuckets.length ? 1 : 0,
        maximumRows,
      );
      return Object.freeze({
        id: identifier(joint.id),
        schema,
        table,
        goals: Object.freeze(goals),
        bucketCount,
        required: boolean(joint.required),
        tolerance: joint.tolerance,
        minimumBucketRows,
        requiredBuckets: Object.freeze(requiredBuckets),
      });
    },
  );
  distinct(
    [...distributions, ...jointDistributions].map((goal) => goal.id),
    "goal",
  );
  return Object.freeze({
    shapeVersion: 1,
    seed: input.seed,
    maximumSourceRows,
    maximumSourceBytes: integer(
      input.maximumSourceBytes ?? 16 * 1024 * 1024,
      1,
      128 * 1024 * 1024,
    ),
    maximumRows,
    maximumDepth: integer(input.maximumDepth ?? 8, 1, 32),
    minimumCohortSize: integer(input.minimumCohortSize ?? 5, 2, 1000),
    tables: Object.freeze(tables),
    relationships: Object.freeze(relationships),
    distributions: Object.freeze(distributions),
    jointDistributions: Object.freeze(jointDistributions),
  });
};
