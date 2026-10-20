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

  it("explains Windows/WSL unavailable ports without claiming memory pressure or a proven reservation", () => {
    const summary = summarizeSupabaseStartupFailure({
      status: 1,
      output: `Error response from daemon: ports are not available: exposing port TCP 127.0.0.1:59422: listen tcp 127.0.0.1:59422: bind: An attempt was made to access a socket in a way forbidden by its access permissions.
POSTGRES_PASSWORD=private-password
http://private-host/private-path?token=private-token`,
    });
    expect(summary).toContain("Reported startup evidence: port_unavailable");
    expect(summary).toContain("does not prove an existing listener");
    expect(summary).toContain("runtime.databasePort");
    expect(summary).toContain("runtime.apiPort");
    expect(summary).toContain("runtime.studioPort");
    expect(summary).toContain(
      "matching ports in the dedicated Supabase config",
    );
    expect(summary).toContain(
      "netsh interface ipv4 show excludedportrange protocol=tcp",
    );
    expect(summary).not.toMatch(/memory|out_of_memory/iu);
    for (const value of [
      "59422",
      "private-password",
      "private-host",
      "private-path",
      "private-token",
    ])
      expect(summary).not.toContain(value);
  });

  it("distinguishes an occupied port and does not classify unrelated access denial", () => {
    const occupied = summarizeSupabaseStartupFailure({
      status: 1,
      output: "Bind for 127.0.0.1:59422 failed: port is already allocated",
    });
    expect(occupied).toContain("Reported startup evidence: port_in_use");
    expect(occupied).not.toContain("port_unavailable");
    expect(occupied).not.toContain("excludedportrange");
    const unrelated = summarizeSupabaseStartupFailure({
      status: 1,
      output:
        "permission denied while trying to connect to the Docker daemon socket",
    });
    expect(unrelated).toContain(
      "unknown; provider supplied no recognized safe failure detail",
    );
    expect(unrelated).not.toContain("Port guidance:");
  });
});
