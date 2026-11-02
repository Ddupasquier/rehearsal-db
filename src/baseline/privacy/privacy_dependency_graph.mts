/** Validate cross-rule bindings, dependencies, and shared deterministic groups. */

import { structuredJsonDeclarations } from "./privacy_structured_json.mjs";
import type {
  NormalizedDeclaration,
  NormalizedRecipe,
  PrivacyBinding,
  PrivacyPathMapping,
  PrivacyTable,
} from "./privacy_contract.mjs";

const usesApprovedOwner = (declaration: NormalizedDeclaration): boolean =>
  (declaration.recipe !== null &&
    "kind" in declaration.recipe &&
    declaration.recipe.kind === "approved-owner") ||
  structuredJsonDeclarations<NormalizedDeclaration>(declaration.recipe).some(
    usesApprovedOwner,
  );

const visitRecipes = (
  declaration: NormalizedDeclaration,
  visit: (recipe: NormalizedRecipe) => void,
): void => {
  visit(declaration.recipe);
  if (
    declaration.recipe !== null &&
    "kind" in declaration.recipe &&
    declaration.recipe.kind === "approved-owner"
  ) {
    visitRecipes(declaration.recipe.approved, visit);
    visitRecipes(declaration.recipe.otherwise, visit);
  } else {
    structuredJsonDeclarations<NormalizedDeclaration>(
      declaration.recipe,
    ).forEach((nested) => visitRecipes(nested, visit));
  }
};

const digestInputs = (declaration: NormalizedDeclaration): string[] => {
  if (
    declaration.recipe !== null &&
    "kind" in declaration.recipe &&
    declaration.recipe.kind === "digest"
  ) {
    return [...declaration.recipe.inputs];
  }
  if (
    declaration.recipe !== null &&
    "kind" in declaration.recipe &&
    declaration.recipe.kind === "approved-owner"
  ) {
    return [
      ...digestInputs(declaration.recipe.approved),
      ...digestInputs(declaration.recipe.otherwise),
    ];
  }
  return structuredJsonDeclarations<NormalizedDeclaration>(
    declaration.recipe,
  ).flatMap(digestInputs);
};

const validateTableDependencies = ({
  table,
  index,
  bindings,
  pathMappings,
}: {
  table: PrivacyTable;
  index: number;
  bindings: Readonly<Record<string, PrivacyBinding>>;
  pathMappings: Readonly<Record<string, PrivacyPathMapping>>;
}): void => {
  const label = `policy.tables[${index}]`;
  if (table.columns.some(usesApprovedOwner) && !table.ownerBinding) {
    throw new Error(`${label} uses approved-owner without ownerBinding.`);
  }
  for (const column of table.columns) {
    visitRecipes(column, (recipe) => {
      if (
        recipe &&
        "kind" in recipe &&
        recipe.kind === "path-map" &&
        !Object.hasOwn(pathMappings, recipe.mapping)
      ) {
        throw new Error(
          `${label} references unknown path mapping ${recipe.mapping}.`,
        );
      }
      if (
        recipe !== null &&
        "kind" in recipe &&
        recipe.kind === "binding-substitute" &&
        !Object.hasOwn(bindings, recipe.binding)
      ) {
        throw new Error(
          `${label} references unknown privacy binding ${recipe.binding}.`,
        );
      }
    });
  }
  const dependencies = new Map<string, string[]>(
    table.columns.map((column) => [column.name, []]),
  );
  for (const column of table.columns) {
    const inputs = [...new Set(digestInputs(column))];
    for (const input of inputs) {
      const inputColumn = table.columns.find((entry) => entry.name === input);
      if (!inputColumn) {
        throw new Error(
          `${label}.${column.name} digest references unknown column ${input}.`,
        );
      }
      if (inputColumn.action === "EXCLUDE") {
        throw new Error(
          `${label}.${column.name} digest input ${input} is excluded instead of sanitized.`,
        );
      }
    }
    dependencies.set(column.name, inputs);
  }
  const resolved = new Set<string>();
  const resolving = new Set<string>();
  const visitDependency = (columnName: string): void => {
    if (resolved.has(columnName)) return;
    if (resolving.has(columnName)) {
      throw new Error(`${label} contains a cyclic digest dependency.`);
    }
    resolving.add(columnName);
    for (const input of dependencies.get(columnName) ?? []) {
      visitDependency(input);
    }
    resolving.delete(columnName);
    resolved.add(columnName);
  };
  table.columns.forEach((column) => visitDependency(column.name));
};

export const validatePrivacyDependencyGraph = ({
  tables,
  bindings,
  pathMappings,
}: {
  tables: readonly PrivacyTable[];
  bindings: Readonly<Record<string, PrivacyBinding>>;
  pathMappings: Readonly<Record<string, PrivacyPathMapping>>;
}): void => {
  tables.forEach((table, index) =>
    validateTableDependencies({ table, index, bindings, pathMappings }),
  );
  const dateShiftGroups = new Map<string, number>();
  const validateDateShiftGroup = (declaration: NormalizedDeclaration): void => {
    const recipe = declaration.recipe;
    if (!recipe || !("kind" in recipe)) return;
    if (recipe.kind === "date-shift" && recipe.group) {
      const existing = dateShiftGroups.get(recipe.group);
      if (existing !== undefined && existing !== recipe.days) {
        throw new Error(
          `Privacy date-shift group ${recipe.group} must use one days value.`,
        );
      }
      dateShiftGroups.set(recipe.group, recipe.days);
    }
    if (recipe.kind === "approved-owner") {
      validateDateShiftGroup(recipe.approved);
      validateDateShiftGroup(recipe.otherwise);
    } else {
      structuredJsonDeclarations<NormalizedDeclaration>(recipe).forEach(
        validateDateShiftGroup,
      );
    }
  };
  tables.forEach((table) => table.columns.forEach(validateDateShiftGroup));
};
