import { describe, expect, it } from "vitest";
import { validatePrivacyDependencyGraph } from "../../../dist/src/baseline/privacy_dependency_graph.mjs";

const column = (name, recipe, action = "DERIVE") => ({
  name,
  action,
  recipe,
  generated: "NEVER",
  identity: "NO",
  foreignKey: null,
});

const table = (columns, ownerBinding = null) => ({
  schema: "public",
  name: "widgets",
  sourceRows: "STREAM AND SANITIZE",
  ownerBinding,
  columns,
});

describe("privacy dependency graph", () => {
  it("accepts an acyclic sanitized-input graph", () => {
    expect(() =>
      validatePrivacyDependencyGraph({
        tables: [
          table([
            column(
              "source",
              { format: "uuid", namespace: "source" },
              "PSEUDONYMIZE",
            ),
            column("result", {
              kind: "digest",
              format: "hex",
              length: 32,
              namespace: "result",
              inputs: ["source"],
            }),
          ]),
        ],
        bindings: {},
        pathMappings: {},
      }),
    ).not.toThrow();
  });

  it("rejects unknown, excluded, and cyclic digest dependencies", () => {
    const digest = (inputs) => ({
      kind: "digest",
      format: "hex",
      length: 32,
      namespace: "digest",
      inputs,
    });
    const validate = (columns) =>
      validatePrivacyDependencyGraph({
        tables: [table(columns)],
        bindings: {},
        pathMappings: {},
      });
    expect(() => validate([column("result", digest(["missing"]))])).toThrow(
      "references unknown column missing",
    );
    expect(() =>
      validate([
        column("source", null, "EXCLUDE"),
        column("result", digest(["source"])),
      ]),
    ).toThrow("is excluded instead of sanitized");
    expect(() =>
      validate([
        column("first", digest(["second"])),
        column("second", digest(["first"])),
      ]),
    ).toThrow("cyclic digest dependency");
  });

  it("rejects conflicting grouped dates and undeclared references", () => {
    const validate = (columns) =>
      validatePrivacyDependencyGraph({
        tables: [table(columns)],
        bindings: {},
        pathMappings: {},
      });
    expect(() =>
      validate([
        column("created", {
          kind: "date-shift",
          days: 10,
          representation: "iso-string",
          group: "timeline",
        }),
        column("updated", {
          kind: "date-shift",
          days: 20,
          representation: "iso-string",
          group: "timeline",
        }),
      ]),
    ).toThrow("must use one days value");
    expect(() =>
      validate([column("path", { kind: "path-map", mapping: "missing" })]),
    ).toThrow("references unknown path mapping missing");
    expect(() =>
      validate([
        column("text", {
          kind: "binding-substitute",
          binding: "missing",
          format: "uuid",
          namespace: "text",
          maximumBytes: 100,
        }),
      ]),
    ).toThrow("references unknown privacy binding missing");
  });
});
