/** Ephemeral composite row identities; only explicit receipts may leave memory. */

import { createHash } from "node:crypto";
import type { BaselineShapePolicy } from "./shape_contract.mjs";

export type ShapeKeyContext = ReadonlyMap<
  string,
  ReadonlyMap<string, "exact" | "numeric">
>;
export interface ShapeSourceSchemaTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly {
    readonly name: string;
    readonly underlyingType: string;
  }[];
}

const numericTypes = new Set(["int2", "int4", "int8", "numeric"]);

/** Actual source metadata, not row spelling, owns numeric SQL comparison. */
export const shapeKeyContextFromSchema = (
  policy: BaselineShapePolicy,
  sourceSchema: readonly ShapeSourceSchemaTable[],
): ShapeKeyContext => {
  const context = new Map(
    sourceSchema.map((table) => [
      `${table.schema}.${table.name}`,
      new Map(
        table.columns.map((column) => [
          column.name,
          numericTypes.has(column.underlyingType)
            ? ("numeric" as const)
            : ("exact" as const),
        ]),
      ),
    ]),
  );
  for (const table of policy.tables) {
    const columns = context.get(`${table.schema}.${table.name}`);
    if (!columns || table.key.some((column) => !columns.has(column)))
      throw new Error("Shape source schema is missing a reviewed key column.");
  }
  for (const relationship of policy.relationships) {
    const parent = context.get(
      `${relationship.parent.schema}.${relationship.parent.table}`,
    );
    const child = context.get(
      `${relationship.child.schema}.${relationship.child.table}`,
    );
    if (
      relationship.parent.columns.some(
        (column, index) =>
          !parent?.has(column) ||
          !child?.has(relationship.child.columns[index]!) ||
          parent.get(column) !== child.get(relationship.child.columns[index]!),
      )
    ) {
      throw new Error(
        "Shape relationship key types are missing or incompatible; numeric keys are never inferred from text.",
      );
    }
  }
  return context;
};

export const shapeKeyFormats = (
  context: ShapeKeyContext | undefined,
  schema: string,
  table: string,
  columns: readonly string[],
): readonly ("exact" | "numeric")[] =>
  columns.map(
    (column) => context?.get(`${schema}.${table}`)?.get(column) ?? "exact",
  );

const canonicalNumericKey = (value: unknown): string => {
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  )
    throw new Error(
      "Shape numeric keys require exact PostgreSQL decimals; unsafe JavaScript magnitudes are refused.",
    );
  if (typeof value !== "number" && typeof value !== "string")
    throw new Error("Shape numeric key has an incompatible SQL value.");
  const spelling = String(value);
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(
    spelling,
  );
  if (
    !match ||
    spelling.length > 1024 ||
    (typeof value === "string" && match[4] !== undefined)
  )
    throw new Error(
      "Shape numeric keys require bounded canonical PostgreSQL decimal values.",
    );
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
  return `${match[1] && normalized !== "0" ? "-" : ""}${normalized}`;
};

export const shapeKeyTuple = (
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
  nullable = false,
  formats: readonly ("exact" | "numeric")[] = [],
): string | null => {
  const values = columns.map((column, index) => {
    if (!Object.hasOwn(row, column))
      throw new Error("A reviewed shape key column is missing.");
    const value = row[column];
    if (value === null && nullable) return null;
    if (formats[index] === "numeric")
      return { numeric: canonicalNumericKey(value) };
    if (
      (typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean") ||
      (typeof value === "string" &&
        (!value.length || Buffer.byteLength(value) > 1024)) ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new Error("Shape keys must be non-null bounded primitive values.");
    }
    return value;
  });
  return values.includes(null) ? null : JSON.stringify(values);
};

export const shapeKeySha256 = (
  values: readonly (string | number | boolean)[],
  sqlTypes: readonly string[] = [],
): string => {
  if (sqlTypes.length && sqlTypes.length !== values.length)
    throw new Error(
      "Shape required-key SQL types must match every reviewed key component.",
    );
  const row = Object.fromEntries(
    values.map((value, index) => [`k${index}`, value]),
  );
  return createHash("sha256")
    .update(
      shapeKeyTuple(
        row,
        Object.keys(row),
        false,
        sqlTypes.map((type) => (numericTypes.has(type) ? "numeric" : "exact")),
      )!,
    )
    .digest("hex");
};
