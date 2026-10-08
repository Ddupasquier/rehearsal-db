import { describe, expect, it } from "vitest";
import { formatCount } from "../../../dist/src/shared/human_output.mjs";

describe("human output", () => {
  it("uses singular and plural count labels", () => {
    expect(formatCount(1, "row")).toBe("1 row");
    expect(formatCount(2, "row")).toBe("2 rows");
    expect(formatCount(1, "entry", "entries")).toBe("1 entry");
    expect(formatCount(0, "entry", "entries")).toBe("0 entries");
  });
});
