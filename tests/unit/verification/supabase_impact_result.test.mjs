import { describe, expect, it } from "vitest";
import { readSupabaseImpactCliResult } from "../../../scripts/verification/fixtures/supabase_impact.mjs";

const secret = "DO_NOT_EXPOSE_PRIVATE_PROVIDER_INPUT";
const envelope = (
  category = "configuration_invalid",
  code = "CONFIGURATION_INVALID",
) => ({
  schemaVersion: 1,
  status: "error",
  error: { category, code, message: secret, context: { password: secret } },
});
const result = (extra = {}) => ({
  status: 2,
  signal: null,
  stdout: JSON.stringify(envelope()),
  stderr: secret,
  ...extra,
});
const failureText = (value, options = {}) => {
  try {
    readSupabaseImpactCliResult(value, {
      phase: "changed-preview",
      ...options,
    });
  } catch (error) {
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain(secret);
    return error.message;
  }
  throw new Error("Expected a refused child result.");
};

describe("Supabase impact child diagnostics", () => {
  it("retains phase and known public tuple while withholding raw message/context/stderr", () => {
    const text = failureText(result());
    expect(text).toContain("changed-preview");
    expect(text).toContain('"exitCode":2');
    expect(text).toContain('"category":"configuration_invalid"');
    expect(text).toContain('"code":"CONFIGURATION_INVALID"');
    expect(text).not.toContain("password");
  });

  it("does not promote arbitrary public error category or code into diagnostics", () => {
    const text = failureText(
      result({ stdout: JSON.stringify(envelope(secret, secret)) }),
    );
    expect(text).toContain('"category":null');
    expect(text).toContain('"code":null');
  });

  it("reports timeout metadata without retaining child Error argv/cause", () => {
    const error = Object.assign(new Error(secret), {
      code: "ETIMEDOUT",
      cause: new Error(secret),
      spawnargs: [secret],
    });
    const text = failureText(
      result({ status: null, signal: "SIGKILL", error }),
      { success: false },
    );
    expect(text).toContain('"spawnCode":"ETIMEDOUT"');
    expect(text).toContain('"signal":"SIGKILL"');
    expect(text).toContain('"killed":true');
  });

  it("allows expected nonzero envelopes only when the caller explicitly requests a negative case", () => {
    const child = result();
    expect(
      readSupabaseImpactCliResult(child, {
        phase: "stale-consent",
        success: false,
      }),
    ).toEqual({ result: child, envelope: envelope() });
    expect(() =>
      readSupabaseImpactCliResult(child, { phase: "stale-consent" }),
    ).toThrow("Supabase impact CLI failed");
  });

  it.each([null, -1, 256, 1.5])(
    "refuses invalid exit status %s even for a negative case",
    (status) => {
      expect(failureText(result({ status }), { success: false })).toContain(
        "changed-preview",
      );
    },
  );

  it("refuses malformed JSON with the same bounded diagnostic projection", () => {
    const text = failureText(result({ status: 0, stdout: secret }));
    expect(text).toContain('"category":null');
    expect(text).toContain('"stdoutBytes":');
  });

  it("does not parse oversized diagnostic JSON or leak its nested fields", () => {
    const stdout = JSON.stringify({
      ...envelope(),
      padding: "x".repeat(65536),
    });
    const text = failureText(result({ stdout }));
    expect(text).toContain('"category":null');
    expect(text.length).toBeLessThan(600);
  });

  it("preserves the impact canary refusal and rejects arbitrary diagnostic phases", () => {
    expect(() =>
      readSupabaseImpactCliResult(
        result({ stdout: "PRIVATE_IMPACT_SQL_CANARY" }),
        { phase: "preview" },
      ),
    ).toThrow("private output withheld");
    expect(failureText(result(), { phase: secret })).toContain(
      "private inputs and output withheld",
    );
  });
});
