import { describe, expect, it } from "vitest";
import { assertRequiredSupabaseServicesEnabled } from "../../../dist/src/targets/supabase_service_requirements.mjs";

describe("Supabase proof service requirements", () => {
  it("accepts declared database and explicitly enabled core/optional services", () => {
    const template = [
      "auth",
      "storage",
      "api",
      "inbucket",
      "studio",
      "realtime",
      "edge_runtime",
      "analytics",
      "storage.image_transformation",
    ]
      .map((section) => `[${section}]\nenabled = true # reviewed`)
      .join("\n");
    expect(() =>
      assertRequiredSupabaseServicesEnabled({
        template,
        requiredServices: [
          "database",
          "auth",
          "storage",
          "postgrest",
          "gateway",
          "mail",
          "studio",
          "realtime",
          "edge-functions",
          "analytics",
          "image-transforms",
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertRequiredSupabaseServicesEnabled({
        template: "",
        requiredServices: ["database"],
      }),
    ).not.toThrow();
  });
  it.each([
    "[realtime]\nenabled = false",
    "[realtime]\nenabled = true\nenabled = false",
    "[realtime]\nenabled = true\n[realtime]\nenabled = true",
    "[realtime]\n",
    "[other]\nenabled = true",
    "[realtime]\nenabled = env(SECRET)",
  ])(
    "refuses disabled, ambiguous, or unproved service declarations",
    (template) => {
      expect(() =>
        assertRequiredSupabaseServicesEnabled({
          template,
          requiredServices: ["realtime"],
        }),
      ).toThrow("disabled or not explicitly enabled");
    },
  );
  it("never includes provider credential values in diagnostics", () => {
    const template =
      '[auth.external.google]\nsecret = "PRIVATE_TEST_VALUE"\n[realtime]\nenabled = false';
    try {
      assertRequiredSupabaseServicesEnabled({
        template,
        requiredServices: ["realtime"],
      });
      throw new Error("Expected refusal");
    } catch (error) {
      expect(error.message).not.toContain("PRIVATE_TEST_VALUE");
    }
  });
});
