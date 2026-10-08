/** Typed, normalized contract shared by privacy validation and execution stages. */

export type PrivacyAction =
  "KEEP" | "PSEUDONYMIZE" | "REPLACE" | "EXCLUDE" | "DERIVE";
export type PrivacyObject = Record<string, unknown>;

export interface PseudonymRecipe {
  format: "uuid" | "email" | "text" | "integer" | "hex" | "gtin" | "url";
  namespace: string;
  maxLength?: number;
  length?: number;
  allowedLengths?: readonly number[];
  origin?: string;
}

export interface ConstantRecipe {
  kind: "constant";
  value: unknown;
}

export interface DateShiftRecipe {
  kind: "date-shift";
  days: number;
  representation: "iso-string" | "epoch-milliseconds";
  group?: string;
}

export interface EnumRecipe {
  kind: "enum";
  allowNull: boolean;
  values: readonly (string | number | boolean)[];
}

export interface ValidatedStringRecipe {
  kind: "validated-string";
  format: "portable-code";
  maximumBytes: number;
  allowNull: boolean;
}

export interface DigestRecipe {
  kind: "digest";
  format: "hex";
  length: number;
  namespace: string;
  inputs: readonly string[];
}

export interface BindingSubstituteRecipe {
  kind: "binding-substitute";
  binding: string;
  format: "uuid";
  namespace: string;
  maximumBytes: number;
}

export interface PathMapRecipe {
  kind: "path-map";
  mapping: string;
}

export interface ApprovedOwnerRecipe {
  kind: "approved-owner";
  approved: NormalizedDeclaration;
  otherwise: NormalizedDeclaration;
}

export interface JsonArrayRecipe {
  kind: "json-array";
  allowNull: boolean;
  maximumBytes: number;
  maximumDepth: number;
  maximumItems: number;
  items: NormalizedDeclaration;
}

export interface JsonObjectRecipe {
  kind: "json-object";
  allowNull: boolean;
  maximumBytes: number;
  maximumDepth: number;
  fields: Readonly<Record<string, NormalizedDeclaration>>;
}

export interface JsonUnionRecipe {
  kind: "json-union";
  allowNull: boolean;
  maximumBytes: number;
  maximumDepth: number;
  maximumItems: number;
  variants: Readonly<Record<string, NormalizedDeclaration>>;
}

export interface JsonDictionaryRecipe {
  kind: "json-dictionary";
  allowNull: boolean;
  maximumBytes: number;
  maximumDepth: number;
  maximumItems: number;
  keys: Readonly<Record<string, unknown>>;
  values: NormalizedDeclaration;
}

export type DerivationRecipe =
  | DateShiftRecipe
  | EnumRecipe
  | ValidatedStringRecipe
  | DigestRecipe
  | BindingSubstituteRecipe
  | PathMapRecipe
  | ApprovedOwnerRecipe
  | JsonArrayRecipe
  | JsonObjectRecipe
  | JsonUnionRecipe
  | JsonDictionaryRecipe;
export type NormalizedRecipe =
  PseudonymRecipe | ConstantRecipe | DerivationRecipe | null;

export interface NormalizedDeclaration {
  action: PrivacyAction;
  recipe: NormalizedRecipe;
  required?: boolean;
}

export interface PrivacyBinding {
  environmentVariable: string;
  approvedValueSha256: string;
}

export interface PrivacyPathMapping extends PseudonymRecipe {
  binding: string;
  format: "uuid" | "text";
  maximumBytes: number;
  maximumSegments: number;
}

export interface PrivacyForeignKey {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
}

export interface PrivacyColumn extends NormalizedDeclaration {
  name: string;
  generated: "ALWAYS" | "NEVER";
  identity: "YES" | "NO";
  foreignKey: PrivacyForeignKey | null;
}

export interface PrivacyTable {
  schema: string;
  name: string;
  sourceRows: "STREAM AND SANITIZE" | "EXCLUDE";
  ownerBinding: Readonly<{
    binding: string;
    columns: readonly string[];
    match: "any";
    nullBehavior?: "otherwise";
  }> | null;
  columns: readonly PrivacyColumn[];
}

export interface ExecutablePrivacyPolicy {
  readonly policyVersion: 2;
  readonly migrationCutoff: string;
  readonly bindings: Readonly<Record<string, PrivacyBinding>>;
  readonly pathMappings: Readonly<Record<string, PrivacyPathMapping>>;
  readonly tables: readonly PrivacyTable[];
}

export interface PrivacySourceRecord {
  schema?: string;
  table: string;
  row: Record<string, unknown>;
}

export interface PrivacyEngine {
  readonly keyFingerprint: string;
  remapPath(input: { mapping: string; value: string }): string;
  sanitize(record: unknown): PrivacySourceRecord | null;
}
