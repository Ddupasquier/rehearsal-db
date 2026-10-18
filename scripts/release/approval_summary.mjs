/** Display the exact candidate for one ordinary protected GitHub approval. */
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseVersion } from "./channel.mjs";

export function releaseApprovalSummary({
  operation,
  version,
  runId,
  attempt,
  sourceSha,
  artifactSha256,
}) {
  if (
    !["publish", "sync-tags"].includes(operation) ||
    ![runId, attempt].every(
      (value) =>
        typeof value === "string" &&
        /^[1-9][0-9]{0,15}$/u.test(value) &&
        Number.isSafeInteger(Number(value)),
    ) ||
    typeof sourceSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(sourceSha) ||
    typeof artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifactSha256)
  )
    throw new Error("Invalid release summary context.");
  releaseVersion(version);
  return `## Review ${operation === "publish" ? "publication" : "channel repair"}: @rehearsal-db/core@${version}

| Candidate | Exact value |
| --- | --- |
| Version | \`${version}\` |
| SHA-256 | \`${artifactSha256}\` |
| Source commit | \`${sourceSha}\` |
| Workflow run / attempt | ${runId} / ${attempt} |

Review the exact candidate and passed checks above. Choose **Review deployments → npm → Approve and deploy** to authorize this operation. A comment is optional; no pasted approval block or separate chat approval is required.

GitHub's protected environment enforces human approval. The workflow independently checks the frozen artifact bytes and live release settings before writing; publication also uses trusted OIDC with provenance. Review history is run-level corroboration, not proof of a particular attempt or its bytes.
`;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (process.argv.length !== 3 || !process.env.GITHUB_STEP_SUMMARY)
      throw new Error("Invalid release summary context.");
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      releaseApprovalSummary({
        operation: process.argv[2],
        version: process.env.PACKAGE_VERSION,
        runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        sourceSha: process.env.GITHUB_SHA,
        artifactSha256: process.env.EXPECTED_SHA256,
      }),
    );
  } catch {
    console.error(
      "Release approval summary refused: missing or invalid candidate metadata.",
    );
    process.exitCode = 1;
  }
}
