/**
 * Validate and normalize the complete reviewed privacy policy version 2.
 */

import type {
  ExecutablePrivacyPolicy,
  PrivacyAction,
  PrivacyBinding,
  PrivacyColumn,
  PrivacyPathMapping,
  PrivacyTable,
} from "./privacy_contract.mjs";
import { validatePrivacyDependencyGraph } from "./privacy_dependency_graph.mjs";
import { validatePrivacyRecipe } from "./privacy_recipe_validation.mjs";
import {
  ACTIONS,
  BINDING_NAME,
  DEFAULT_PATH_MAXIMUM_BYTES,
  DEFAULT_PATH_MAXIMUM_SEGMENTS,
  ENVIRONMENT_KEY,
  HEX_64,
  assertKnownKeys as knownKeys,
  isPrivacyObject as isObject,
  validateIdentifier as identifier,
  validateNonEmpty as nonEmpty,
  validatePositiveInteger as positiveInteger,
} from "./privacy_validation_shared.mjs";
export type {
  ExecutablePrivacyPolicy,
  PrivacyColumn,
  PrivacyEngine,
  PrivacyForeignKey,
  PrivacySourceRecord,
  PrivacyTable,
} from "./privacy_contract.mjs";

export const validateExecutablePrivacyPolicy = (
  policy: unknown,
): ExecutablePrivacyPolicy => {
  if (!isObject(policy)) throw new Error("Privacy policy must be an object.");
  knownKeys(
    policy,
    [
      "policyVersion",
      "draft",
      "migrationCutoff",
      "bindings",
      "pathMappings",
      "tables",
    ],
    "policy",
  );
  if (policy.policyVersion !== 2) {
    throw new Error("Executable privacy policies must use policyVersion 2.");
  }
  if (policy.draft === true) {
    throw new Error("The privacy policy is still a REVIEW REQUIRED draft.");
  }
  if (
    typeof policy.migrationCutoff !== "string" ||
    !/^\d{14}$/u.test(policy.migrationCutoff)
  ) {
    throw new Error(
      "Privacy policy migrationCutoff must be a timestamp version.",
    );
  }
  if (!Array.isArray(policy.tables) || policy.tables.length === 0) {
    throw new Error("Privacy policy must classify at least one table.");
  }
  if (policy.bindings !== undefined && !isObject(policy.bindings)) {
    throw new Error("policy.bindings must be an object.");
  }
  const bindings = Object.fromEntries(
    Object.entries(policy.bindings ?? {}).map(([name, binding]) => {
      if (!BINDING_NAME.test(name) || !isObject(binding)) {
        throw new Error("policy.bindings contains an invalid binding.");
      }
      knownKeys(
        binding,
        ["environmentVariable", "approvedValueSha256"],
        `policy.bindings.${name}`,
      );
      if (
        typeof binding.environmentVariable !== "string" ||
        !ENVIRONMENT_KEY.test(binding.environmentVariable)
      ) {
        throw new Error(
          `policy.bindings.${name}.environmentVariable is invalid.`,
        );
      }
      if (
        typeof binding.approvedValueSha256 !== "string" ||
        !HEX_64.test(binding.approvedValueSha256)
      ) {
        throw new Error(
          `policy.bindings.${name}.approvedValueSha256 must be a lowercase SHA-256 receipt.`,
        );
      }
      return [
        name,
        Object.freeze({
          environmentVariable: binding.environmentVariable,
          approvedValueSha256: binding.approvedValueSha256,
        }),
      ];
    }),
  ) as Record<string, PrivacyBinding>;
  if (policy.pathMappings !== undefined && !isObject(policy.pathMappings)) {
    throw new Error("policy.pathMappings must be an object.");
  }
  const pathMappings = Object.fromEntries(
    Object.entries(policy.pathMappings ?? {}).map(([name, mapping]) => {
      const label = `policy.pathMappings.${name}`;
      if (!BINDING_NAME.test(name) || !isObject(mapping)) {
        throw new Error("policy.pathMappings contains an invalid mapping.");
      }
      knownKeys(
        mapping,
        [
          "binding",
          "format",
          "namespace",
          "maxLength",
          "maximumBytes",
          "maximumSegments",
        ],
        label,
      );
      if (
        typeof mapping.binding !== "string" ||
        !Object.hasOwn(bindings, mapping.binding)
      ) {
        throw new Error(`${label}.binding references an unknown binding.`);
      }
      if (
        typeof mapping.format !== "string" ||
        !["uuid", "text"].includes(mapping.format)
      ) {
        throw new Error(`${label}.format must be uuid or text.`);
      }
      const normalized = {
        binding: mapping.binding,
        format: mapping.format as PrivacyPathMapping["format"],
        namespace: nonEmpty(mapping.namespace, `${label}.namespace`),
        maximumBytes: positiveInteger(
          mapping.maximumBytes ?? DEFAULT_PATH_MAXIMUM_BYTES,
          `${label}.maximumBytes`,
          16_384,
        ),
        maximumSegments: positiveInteger(
          mapping.maximumSegments ?? DEFAULT_PATH_MAXIMUM_SEGMENTS,
          `${label}.maximumSegments`,
          256,
        ),
      };
      if (mapping.format === "text") {
        return [
          name,
          Object.freeze({
            ...normalized,
            maxLength: positiveInteger(
              mapping.maxLength,
              `${label}.maxLength`,
              1_024,
            ),
          }),
        ];
      } else if (mapping.maxLength !== undefined) {
        throw new Error(`${label}.maxLength is supported only for text.`);
      }
      return [name, Object.freeze(normalized)];
    }),
  ) as Record<string, PrivacyPathMapping>;
  const names = new Set<string>();
  const tables = policy.tables.map((table: unknown, tableIndex: number) => {
    const label = `policy.tables[${tableIndex}]`;
    if (!isObject(table)) throw new Error(`${label} must be an object.`);
    knownKeys(
      table,
      ["schema", "name", "sourceRows", "ownerBinding", "columns"],
      label,
    );
    const schema = identifier(table.schema ?? "public", `${label}.schema`);
    const name = identifier(table.name, `${label}.name`);
    const key = schema === "public" ? name : `${schema}.${name}`;
    if (names.has(key))
      throw new Error(`Privacy policy duplicates table ${key}.`);
    names.add(key);
    if (
      typeof table.sourceRows !== "string" ||
      !["STREAM AND SANITIZE", "EXCLUDE"].includes(table.sourceRows)
    ) {
      throw new Error(`${label}.sourceRows is unsupported.`);
    }
    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      throw new Error(`${label}.columns must not be empty.`);
    }
    const sourceRows = table.sourceRows as PrivacyTable["sourceRows"];
    const columnNames = new Set<string>();
    const columns: PrivacyColumn[] = table.columns.map(
      (column: unknown, columnIndex: number) => {
        const columnLabel = `${label}.columns[${columnIndex}]`;
        if (!isObject(column))
          throw new Error(`${columnLabel} must be an object.`);
        knownKeys(
          column,
          ["name", "action", "recipe", "generated", "identity", "foreignKey"],
          columnLabel,
        );
        const columnName = identifier(column.name, `${columnLabel}.name`);
        if (columnNames.has(columnName)) {
          throw new Error(
            `Privacy policy duplicates column ${name}.${columnName}.`,
          );
        }
        columnNames.add(columnName);
        const action = String(column.action ?? "").toUpperCase();
        if (!ACTIONS.has(action))
          throw new Error(`${columnLabel}.action is unsupported.`);
        if (
          typeof column.generated !== "string" ||
          !["ALWAYS", "NEVER"].includes(column.generated)
        ) {
          throw new Error(`${columnLabel}.generated must be ALWAYS or NEVER.`);
        }
        if (
          typeof column.identity !== "string" ||
          !["YES", "NO"].includes(column.identity)
        ) {
          throw new Error(`${columnLabel}.identity must be YES or NO.`);
        }
        if (column.foreignKey !== null) {
          if (!isObject(column.foreignKey)) {
            throw new Error(
              `${columnLabel}.foreignKey must be null or an object.`,
            );
          }
          knownKeys(
            column.foreignKey,
            ["schema", "table", "column"],
            `${columnLabel}.foreignKey`,
          );
          identifier(
            column.foreignKey.schema,
            `${columnLabel}.foreignKey.schema`,
          );
          identifier(
            column.foreignKey.table,
            `${columnLabel}.foreignKey.table`,
          );
          identifier(
            column.foreignKey.column,
            `${columnLabel}.foreignKey.column`,
          );
        }
        return Object.freeze({
          ...column,
          name: columnName,
          action: action as PrivacyAction,
          recipe: validatePrivacyRecipe(
            action as PrivacyAction,
            column.recipe,
            columnLabel,
          ),
          generated: column.generated as PrivacyColumn["generated"],
          identity: column.identity as PrivacyColumn["identity"],
          foreignKey: column.foreignKey,
        }) as PrivacyColumn;
      },
    );
    let ownerBinding: PrivacyTable["ownerBinding"] = null;
    if (table.ownerBinding !== undefined && table.ownerBinding !== null) {
      if (!isObject(table.ownerBinding)) {
        throw new Error(`${label}.ownerBinding must be an object.`);
      }
      knownKeys(
        table.ownerBinding,
        ["binding", "column", "columns", "match", "nullBehavior"],
        `${label}.ownerBinding`,
      );
      const binding = nonEmpty(
        table.ownerBinding.binding,
        `${label}.ownerBinding.binding`,
      );
      const hasColumn = table.ownerBinding.column !== undefined;
      const hasColumns = table.ownerBinding.columns !== undefined;
      if (hasColumn === hasColumns) {
        throw new Error(
          `${label}.ownerBinding must declare exactly one of column or columns.`,
        );
      }
      let ownerColumns: string[];
      if (hasColumn) {
        if (table.ownerBinding.match !== undefined) {
          throw new Error(
            `${label}.ownerBinding.match is supported only with columns.`,
          );
        }
        ownerColumns = [
          identifier(table.ownerBinding.column, `${label}.ownerBinding.column`),
        ];
      } else {
        if (
          !Array.isArray(table.ownerBinding.columns) ||
          table.ownerBinding.columns.length === 0 ||
          table.ownerBinding.columns.length > 16
        ) {
          throw new Error(
            `${label}.ownerBinding.columns must contain 1 through 16 columns.`,
          );
        }
        if (table.ownerBinding.match !== "any") {
          throw new Error(
            `${label}.ownerBinding.match must be any when columns are used.`,
          );
        }
        ownerColumns = table.ownerBinding.columns.map((column, index) =>
          identifier(column, `${label}.ownerBinding.columns[${index}]`),
        );
        if (new Set(ownerColumns).size !== ownerColumns.length) {
          throw new Error(
            `${label}.ownerBinding.columns must not contain duplicates.`,
          );
        }
      }
      if (
        table.ownerBinding.nullBehavior !== undefined &&
        table.ownerBinding.nullBehavior !== "otherwise"
      ) {
        throw new Error(
          `${label}.ownerBinding.nullBehavior must be otherwise when declared.`,
        );
      }
      if (!Object.hasOwn(bindings, binding)) {
        throw new Error(`${label}.ownerBinding references an unknown binding.`);
      }
      for (const column of ownerColumns) {
        if (!columnNames.has(column)) {
          throw new Error(
            `${label}.ownerBinding references an unknown column.`,
          );
        }
        const ownerColumn = columns.find((entry) => entry.name === column);
        if (!ownerColumn || ownerColumn.action !== "PSEUDONYMIZE") {
          throw new Error(
            `${label}.ownerBinding columns must be explicitly pseudonymized.`,
          );
        }
      }
      ownerBinding = Object.freeze({
        binding,
        columns: Object.freeze(ownerColumns),
        match: "any",
        ...(table.ownerBinding.nullBehavior === undefined
          ? {}
          : { nullBehavior: table.ownerBinding.nullBehavior }),
      });
    }
    return Object.freeze({
      schema,
      name,
      sourceRows,
      ownerBinding,
      columns: Object.freeze(columns),
    });
  });
  validatePrivacyDependencyGraph({ tables, bindings, pathMappings });
  return Object.freeze({
    policyVersion: 2,
    migrationCutoff: policy.migrationCutoff,
    bindings: Object.freeze(bindings),
    pathMappings: Object.freeze(pathMappings),
    tables: Object.freeze(tables),
  });
};
