import { describe, expect, it } from "vitest";
import { summarizeSupabaseStartupFailure } from "../../../dist/src/targets/supabase_start_failure.mjs";

describe("safe Supabase startup failure evidence", () => {
  it("retains allowlisted unhealthy service states without raw logs or project names", () => {
    const summary = summarizeSupabaseStartupFailure({
      status: 1,
      output: `supabase_auth_private-project container logs:
{"privateRow":"never-print-this","password":"private-password"}
API_URL=http://localhost:54321/private?token=private-token
DB_URL=postgresql://owner:private-password@localhost:54322/private
supabase_auth_private-project container is not ready: starting
supabase_kong_private-project unexpected status 502
Try rerunning the command with --debug to troubleshoot the error.
at start (/private/candidate-acceptance/package/start.mjs:10:2)`,
    });
    expect(summary).toContain("Reported startup evidence: health_check");
    expect(summary).toContain("auth=starting, gateway=http_502");
    expect(summary).toContain("does not establish the underlying cause");
    for (const value of [
      "private-project",
      "private-password",
      "private-token",
      "never-print-this",
      "localhost",
      "candidate-acceptance",
    ])
      expect(summary).not.toContain(value);
  });

  it("does not turn unrecognized provider output into an invented diagnosis", () => {
    const summary = summarizeSupabaseStartupFailure({
      status: 9,
      output: "Some provider failure; secret=private-canary",
    });
    expect(summary).toContain("exit 9");
    expect(summary).toContain(
      "unknown; provider supplied no recognized safe failure detail",
    );
    expect(summary).not.toContain("private-canary");
  });

  it("reports fixed capacity, architecture and process failure codes only", () => {
    expect(
      summarizeSupabaseStartupFailure({
        status: 1,
        output: "no space left on device; exec format error",
      }),
    ).toContain("disk_full, image_architecture");
    expect(
      summarizeSupabaseStartupFailure({
        status: null,
        processErrorCode: "ETIMEDOUT",
        output: "",
      }),
    ).toContain("process_timeout");
    expect(
      summarizeSupabaseStartupFailure({
        status: null,
        processErrorCode: "ENOENT",
        output: "",
      }),
    ).toContain("cli_unavailable");
    expect(
      summarizeSupabaseStartupFailure({
        status: null,
        processErrorCode: "PRIVATE_CANARY",
        output: "",
      }),
    ).not.toContain("PRIVATE_CANARY");
  });
});
