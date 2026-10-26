import { expect, it } from "vitest";
import { normalizeMigrationTool } from "../../../dist/src/project/configuration_migration_tool.mjs";
const selected = () => ({
  kind: "prisma",
  version: "7.10.1",
  packageDirectory: "node_modules/prisma",
});
it("leaves native tool support disabled when omitted and requires explicit pinned selection", () => {
  expect(normalizeMigrationTool(undefined)).toBeNull();
  const input = selected();
  const normalized = normalizeMigrationTool(input);
  expect(normalized).toEqual(input);
  expect(Object.isFrozen(normalized)).toBe(true);
  input.version = "8.0.0";
  expect(normalized.version).toBe("7.10.1");
});
it.each([
  null,
  false,
  "prisma",
  [],
  {},
  { kind: "prisma" },
  { kind: "prisma", version: "7.10.1" },
])("refuses incomplete or non-object selection %j", (value) => {
  expect(() => normalizeMigrationTool(value)).toThrow();
});
it.each(["7.10.2", "7", "^7.10.1", "latest", "8.0.0", ""])(
  "refuses an unqualified version %s",
  (version) => {
    expect(() => normalizeMigrationTool({ ...selected(), version })).toThrow();
  },
);
it.each(["drizzle", "Prisma", "postgresql", ""])(
  "refuses unsupported tool kind %s",
  (kind) => {
    expect(() => normalizeMigrationTool({ ...selected(), kind })).toThrow();
  },
);
it.each(["provider", "command", "config", "environment", "allowInstall"])(
  "refuses unknown configuration key %s",
  (key) => {
    expect(() =>
      normalizeMigrationTool({ ...selected(), [key]: "must-not-be-evaluated" }),
    ).toThrow();
  },
);
it.each([
  undefined,
  null,
  "",
  "/absolute/prisma",
  "../prisma",
  "node_modules/../../foreign",
])("refuses unsafe or missing package path %j", (packageDirectory) => {
  expect(() =>
    normalizeMigrationTool({ ...selected(), packageDirectory }),
  ).toThrow();
});
it("accepts an explicit supported project-local package location without deriving or reading it", () => {
  expect(
    normalizeMigrationTool({ ...selected(), packageDirectory: "tools/prisma" }),
  ).toEqual({ ...selected(), packageDirectory: "tools/prisma" });
});
