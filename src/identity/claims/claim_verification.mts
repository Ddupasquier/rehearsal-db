/** Pure post-read checks used by the transactional identity executor. */

import { isDeepStrictEqual } from "node:util";
import type {
  JsonObject,
  SignupDefaultDeclaration,
} from "./claim_contract.mjs";

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface DefaultInspection {
  readonly matches: boolean;
  readonly actualColumns: string[];
  readonly mismatchedColumns: string[];
}

export const inspectDeclaredDefault = ({
  row,
  declaration,
}: {
  row: unknown;
  declaration: SignupDefaultDeclaration;
}): DefaultInspection => {
  if (!isObject(row)) {
    return { matches: false, actualColumns: [], mismatchedColumns: [] };
  }
  const comparable = { ...row };
  delete comparable[declaration.identityColumn];
  for (const column of declaration.ignoredColumns) delete comparable[column];
  const actualColumns = Object.keys(comparable).sort();
  const declaredColumns = Object.keys(declaration.values).sort();
  const mismatchedColumns = Object.entries(declaration.values)
    .filter(([column, matcher]) =>
      matcher.kind === "pattern"
        ? typeof comparable[column] !== "string" ||
          !new RegExp(matcher.pattern, "u").test(comparable[column])
        : !isDeepStrictEqual(comparable[column], matcher.value),
    )
    .map(([column]) => column)
    .sort();
  return {
    matches:
      isDeepStrictEqual(actualColumns, declaredColumns) &&
      mismatchedColumns.length === 0,
    actualColumns,
    mismatchedColumns,
  };
};

export const containsJson = (actual: unknown, expected: unknown): boolean => {
  if (!isObject(expected)) return isDeepStrictEqual(actual, expected);
  if (!isObject(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    containsJson(actual[key], value),
  );
};

export const valueKind = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
