import { describe, expect, it } from "vitest";
import { renderPlan } from "../../../src/cli/renderers.mjs";

describe("CLI renderers", () => {
  it("prints each declarative authentication callback in a multi-target plan", () => {
    const output = renderPlan(
      {
        targets: [
          {
            name: "primary",
            plan: {
              config: { project: "example" },
              environment: {
                kind: "isolated_local_supabase",
                authenticationProviders: ["google"],
                authenticationCallback:
                  "http://127.0.0.1:58321/auth/v1/callback",
                barriers: [],
              },
              baseline: {
                generationId: "20261004T120000Z-example",
                tableCount: 2,
                rowCount: 3,
              },
              migrations: { candidates: [] },
            },
          },
        ],
        migrations: { candidateCount: 0, candidateSha256: "a".repeat(64) },
        execution: ["verify the runtime"],
        guarantee: "No production resources will be contacted.",
      },
      "normal",
    );

    expect(output).toContain("External identity providers google");
    expect(output).toContain(
      "Register callback http://127.0.0.1:58321/auth/v1/callback",
    );
  });
});
