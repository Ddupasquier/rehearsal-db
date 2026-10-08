import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const documentedExamples = new Map([
  ["javascript-config", "tests/types/documented_configuration.mjs"],
  ["type-usage", "tests/types/documented_type_usage.mts"],
]);

describe("TypeScript documentation", () => {
  it("keeps every displayed example identical to its compiled source", async () => {
    const documentation = await readFile(
      join(root, "docs/typescript.md"),
      "utf8",
    );
    const examples = new Map(
      [
        ...documentation.matchAll(
          /<!-- checked-example: ([a-z-]+) -->\n\n```(?:js|ts)\n([\s\S]*?)\n```/gu,
        ),
      ].map(([, name, source]) => [name, `${source}\n`]),
    );

    expect([...examples.keys()]).toEqual([...documentedExamples.keys()]);
    for (const [name, relativePath] of documentedExamples) {
      const checkedSource = await readFile(join(root, relativePath), "utf8");
      expect(examples.get(name)).toBe(checkedSource);
    }
  });

  it("states the reviewed root contract and generated subpath boundary", async () => {
    const documentation = await readFile(
      join(root, "docs/typescript.md"),
      "utf8",
    );

    expect(documentation).toContain("RehearsalConfigVersion");
    expect(documentation).toContain("RehearsalConfig");
    expect(documentation).toContain("NormalizedRehearsalConfig");
    expect(documentation).toContain("defineRehearsalConfig()");
    expect(documentation).toContain(
      "All shipped Rehearsal implementation source",
    );
    expect(documentation).toContain("also receive generated declarations");
    expect(documentation).toContain(
      "Keep the generated configuration as `.mjs`",
    );
  });
});
