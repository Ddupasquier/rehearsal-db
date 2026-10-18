import { describe, expect, it } from "vitest";
import { releaseApprovalSummary } from "../../../scripts/release/approval_summary.mjs";

const context = {
  operation: "publish",
  version: "1.0.0",
  runId: "12345",
  attempt: "2",
  sourceSha: "a".repeat(40),
  artifactSha256: "b".repeat(64),
};

describe("one human release approval", () => {
  it.each(["publish", "sync-tags"])(
    "displays the exact %s candidate without a pasted phrase",
    (operation) => {
      const text = releaseApprovalSummary({ ...context, operation });
      expect(text).toContain("@rehearsal-db/core@1.0.0");
      expect(text).toContain(context.sourceSha);
      expect(text).toContain(context.artifactSha256);
      expect(text).toContain("12345 / 2");
      expect(text).toContain("Review deployments → npm → Approve and deploy");
      expect(text).toContain("A comment is optional");
      expect(text).toContain(
        "no pasted approval block or separate chat approval",
      );
      expect(text).toContain("not proof of a particular attempt or its bytes");
      expect(text).not.toContain("Rehearsal release approval v1");
    },
  );
  it.each([
    { operation: "prepare" },
    { version: "<script>private-sentinel</script>" },
    { runId: "01" },
    { runId: "9007199254740992" },
    { attempt: "0" },
    { attempt: undefined },
    { sourceSha: "private-sentinel" },
    { artifactSha256: "private-sentinel" },
    { version: undefined },
  ])("refuses malformed display metadata without echoing it: %j", (change) => {
    expect(() => releaseApprovalSummary({ ...context, ...change })).toThrow();
    expect(() => releaseApprovalSummary({ ...context, ...change })).not.toThrow(
      "private-sentinel",
    );
  });
});
