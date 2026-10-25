import { describe, expect, it } from "vitest";
import { renderPlan, renderDoctor } from "../../../dist/src/cli/renderers.mjs";

describe("CLI renderers", () => {
  it("shows the detected machine and preserves optional engines as unverified choices", () => {
    const output = renderDoctor(
      {
        state: "NOT READY",
        checks: [],
        containerEngines: {
          schemaVersion: 1,
          host: { kind: "macos", supported: true },
          state: "ready",
          selected: { context: "desktop-linux", provider: "docker-desktop" },
          options: [
            {
              label: "OrbStack",
              selected: false,
              contexts: ["orbstack"],
              installed: "detected",
            },
          ],
        },
      },
      "normal",
    );
    expect(output).toContain("Machine: macos");
    expect(output).toContain("Engine: desktop-linux");
    expect(output).toContain("Option: OrbStack");
    expect(output).toContain("not probed; compatibility requires verification");
    expect(output).toContain("NOT READY");
  });
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
