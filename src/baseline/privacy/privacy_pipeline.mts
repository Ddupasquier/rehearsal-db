/** Resolve reviewed bindings and execute the dependency-aware row privacy pipeline. */

import { createHash } from "node:crypto";
import type {
  PrivacyEngine,
  PrivacySourceRecord,
  PrivacyTable,
} from "./privacy_contract.mjs";
import { PRIVACY_KEY_BYTES } from "./privacy_key.mjs";
import { validateExecutablePrivacyPolicy } from "./privacy_policy.mjs";
import { executePrivacyDeclaration } from "./privacy_rule_registry.mjs";
import { remapPrivacyPath } from "./privacy_transforms.mjs";
import { IDENTIFIER, isPrivacyObject } from "./privacy_validation_shared.mjs";

export const createPrivacyEngine = ({
  policy,
  key,
  environment = process.env,
}: {
  policy: unknown;
  key: Uint8Array | string;
  environment?: NodeJS.ProcessEnv;
}): Readonly<PrivacyEngine> => {
  const normalized = validateExecutablePrivacyPolicy(policy);
  const secret = Buffer.isBuffer(key) ? key : Buffer.from(key ?? "");
  if (secret.length < PRIVACY_KEY_BYTES) {
    throw new Error(
      `Privacy key must contain at least ${PRIVACY_KEY_BYTES} bytes.`,
    );
  }
  const bindingValues = new Map<string, string>(
    Object.entries(normalized.bindings).map(([name, binding]) => {
      const value = environment[binding.environmentVariable];
      if (typeof value !== "string" || !value) {
        throw new Error(
          `Privacy binding ${name} requires ${binding.environmentVariable}.`,
        );
      }
      const receipt = createHash("sha256").update(value).digest("hex");
      if (receipt !== binding.approvedValueSha256) {
        throw new Error(
          `Privacy binding ${name} does not match its review receipt.`,
        );
      }
      return [name, value];
    }),
  );
  const tables = new Map<string, PrivacyTable>(
    normalized.tables.map((table) => [
      table.schema === "public" ? table.name : `${table.schema}.${table.name}`,
      table,
    ]),
  );
  return Object.freeze({
    keyFingerprint: createHash("sha256").update(secret).digest("hex"),
    remapPath({
      mapping: mappingName,
      value,
    }: {
      mapping: string;
      value: string;
    }): string {
      const mapping = normalized.pathMappings[mappingName];
      if (!mapping) {
        throw new Error(`Privacy path mapping ${mappingName} is not declared.`);
      }
      return remapPrivacyPath({
        key: secret,
        mapping,
        bindingValue: bindingValues.get(mapping.binding),
        value,
        label: `Privacy path mapping ${mappingName}`,
      });
    },
    sanitize(record: unknown): PrivacySourceRecord | null {
      if (
        !isPrivacyObject(record) ||
        typeof (record.schema ?? "public") !== "string" ||
        !IDENTIFIER.test(String(record.schema ?? "public")) ||
        typeof record.table !== "string" ||
        !IDENTIFIER.test(record.table) ||
        !isPrivacyObject(record.row)
      ) {
        throw new Error("Source record has an invalid privacy-engine shape.");
      }
      const schema = String(record.schema ?? "public");
      const rowSource = record.row;
      const relation =
        schema === "public" ? record.table : `${schema}.${record.table}`;
      const table = tables.get(relation);
      if (!table) {
        throw new Error(`Privacy policy does not classify table ${relation}.`);
      }
      if (table.sourceRows === "EXCLUDE") return null;
      const actual = Object.keys(rowSource).sort();
      const expected = table.columns.map((column) => column.name).sort();
      if (actual.join("\0") !== expected.join("\0")) {
        throw new Error(
          `Source table ${relation} contains an unclassified or missing column.`,
        );
      }
      let ownerApproved: boolean | undefined;
      if (table.ownerBinding) {
        const approvedValue = bindingValues.get(table.ownerBinding.binding);
        const owners = table.ownerBinding.columns.map(
          (column) => rowSource[column],
        );
        for (const owner of owners) {
          if (owner === null) {
            if (table.ownerBinding.nullBehavior !== "otherwise") {
              throw new Error(
                `${relation} has an invalid owner binding value.`,
              );
            }
            continue;
          }
          if (
            !["string", "number"].includes(typeof owner) ||
            owner === "" ||
            (typeof owner === "number" && !Number.isFinite(owner))
          ) {
            throw new Error(`${relation} has an invalid owner binding value.`);
          }
        }
        ownerApproved = owners.some(
          (owner) => owner !== null && String(owner) === approvedValue,
        );
      }
      const sanitizedColumns = new Map<string, unknown>();
      const resolvingColumns = new Set<string>();
      const sanitizeColumn = (columnName: string): unknown => {
        if (sanitizedColumns.has(columnName)) {
          return sanitizedColumns.get(columnName);
        }
        if (resolvingColumns.has(columnName)) {
          throw new Error(`${relation} contains a cyclic digest dependency.`);
        }
        const column = table.columns.find((entry) => entry.name === columnName);
        if (!column) {
          throw new Error(
            `${relation} digest references unknown column ${columnName}.`,
          );
        }
        resolvingColumns.add(columnName);
        try {
          const transformed = executePrivacyDeclaration({
            declaration: column,
            value: rowSource[column.name],
            key: secret,
            path: `${relation}.${column.name}`,
            ownerApproved,
            pathMappings: normalized.pathMappings,
            bindingValues,
            resolveInput: sanitizeColumn,
          });
          sanitizedColumns.set(columnName, transformed);
          return transformed;
        } finally {
          resolvingColumns.delete(columnName);
        }
      };
      const row = Object.fromEntries(
        table.columns.flatMap((column) => {
          const transformed = sanitizeColumn(column.name);
          return transformed === undefined ? [] : [[column.name, transformed]];
        }),
      );
      return schema === "public"
        ? { table: record.table, row }
        : { schema, table: record.table, row };
    },
  });
};
