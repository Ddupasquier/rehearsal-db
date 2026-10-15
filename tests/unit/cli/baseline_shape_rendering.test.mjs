import { describe, expect, it } from "vitest";
import { renderBaselineShape } from "../../../dist/src/cli/baseline_shape_rendering.mjs";
import {
  createBaselineShapeEvidence,
  validateBaselineShapePolicy,
} from "../../../dist/src/source/shape.mjs";
import { evidenceOptions } from "../source/shape_fixtures.mjs";

describe("plain-language baseline shape inspection", () => {
  it("distinguishes an unmeasured baseline from passed reviewed evidence", () => {
    expect(renderBaselineShape(null).join("\n")).toContain(
      "no distribution-preservation claim",
    );
    const policy = validateBaselineShapePolicy({
      shapeVersion: 1,
      seed: "synthetic",
      maximumRows: 10,
      minimumCohortSize: 2,
      tables: [{ name: "items", key: ["id"], maximumRows: 10, rootRows: 10 }],
      distributions: [
        {
          id: "empty",
          table: "items",
          column: "text",
          kind: "empty",
          required: false,
          tolerance: 1,
          requiredBuckets: ["empty"],
        },
      ],
    });
    const source = Array.from({ length: 10 }, (_, id) => ({
      table: "items",
      row: { id, text: "SECRET_RENDER_CANARY" },
    }));
    const report = renderBaselineShape(
      createBaselineShapeEvidence(evidenceOptions(policy, source, source)),
    ).join("\n");
    expect(report).toContain(
      "approved source / selected source / sanitized baseline",
    );
    expect(report).toContain("required class missing from the source");
    expect(report).toContain("not production equivalence");
    expect(report).not.toContain("SECRET_RENDER_CANARY");
  });
});
