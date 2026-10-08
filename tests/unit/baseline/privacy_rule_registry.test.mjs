import { describe, expect, it } from "vitest";
import {
  PRIVACY_ACTION_RULES,
  PRIVACY_DERIVATION_RULES,
} from "../../../dist/src/baseline/privacy_rule_registry.mjs";
import { pseudonymize } from "../../../dist/src/baseline/privacy_transforms.mjs";

describe("privacy rule registry", () => {
  it("registers every reviewed action and derivation family explicitly", () => {
    expect(Object.keys(PRIVACY_ACTION_RULES).sort()).toEqual([
      "DERIVE",
      "EXCLUDE",
      "KEEP",
      "PSEUDONYMIZE",
      "REPLACE",
    ]);
    expect(Object.keys(PRIVACY_DERIVATION_RULES).sort()).toEqual([
      "approved-owner",
      "binding-substitute",
      "date-shift",
      "digest",
      "enum",
      "json-array",
      "json-dictionary",
      "json-object",
      "json-union",
      "path-map",
      "validated-string",
    ]);
  });

  it.each([
    ["uuid", { format: "uuid", namespace: "uuid" }, "source-a"],
    ["email", { format: "email", namespace: "email" }, "source-a"],
    ["text", { format: "text", namespace: "text", maxLength: 32 }, "source-a"],
    ["integer", { format: "integer", namespace: "integer" }, 42],
    ["hex", { format: "hex", namespace: "hex", length: 32 }, "source-a"],
    [
      "gtin",
      { format: "gtin", namespace: "gtin", length: 13 },
      "4006381333931",
    ],
    [
      "url",
      {
        format: "url",
        namespace: "url",
        origin: "https://127.0.0.1:8443",
        maxLength: 256,
      },
      "https://private.invalid/object?token=secret-canary",
    ],
  ])(
    "keeps %s transforms deterministic and key-dependent",
    (_name, recipe, value) => {
      const first = pseudonymize(Buffer.alloc(32, 7), recipe, value);
      expect(pseudonymize(Buffer.alloc(32, 7), recipe, value)).toEqual(first);
      expect(pseudonymize(Buffer.alloc(32, 8), recipe, value)).not.toEqual(
        first,
      );
      expect(JSON.stringify(first)).not.toContain("secret-canary");
    },
  );

  it("keeps distinct reviewed inputs distinct in the fixed collision corpus", () => {
    const recipe = { format: "hex", namespace: "collision", length: 64 };
    const outputs = Array.from({ length: 1_000 }, (_unused, index) =>
      pseudonymize(Buffer.alloc(32, 7), recipe, `source-${index}`),
    );
    expect(new Set(outputs).size).toBe(outputs.length);
  });

  it("rejects malformed shaped inputs without echoing their values", () => {
    const privateValue = "secret-canary";
    let failure;
    try {
      pseudonymize(
        Buffer.alloc(32, 7),
        { format: "gtin", namespace: "gtin", length: 13 },
        privateValue,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure?.message).toContain("valid normalized GTIN-13");
    expect(failure?.message).not.toContain(privateValue);
  });
});
