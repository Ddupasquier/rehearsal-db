/** Emit the exact comment the owner must submit through GitHub's held npm deployment. */
import { appendFile } from "node:fs/promises";
import { approvalComment, controlsWitnessDigest } from "./controls_witness.mjs";
import { readControlsWitness } from "./settings_witness.mjs";

try {
  if (process.argv.length !== 3 || !process.env.GITHUB_STEP_SUMMARY)
    throw new Error("invalid_summary_context");
  const comment = approvalComment({
    operation: process.argv[2],
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    sourceSha: process.env.GITHUB_SHA,
    artifactSha256: process.env.EXPECTED_SHA256,
    witnessSha256: controlsWitnessDigest(await readControlsWitness()),
  });
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Owner approval required\n\nCompare the artifact checksum with accepted evidence. Independently confirm the repository rulesets still have no bypass actors. Paste this exact comment into **Review deployments → npm**, then approve manually:\n\n\`\`\`text\n${comment}\n\`\`\`\n\nThis unsigned settings witness is not authenticated until your matching deployment review is observed. This workflow never approves itself.\n`,
  );
} catch {
  console.error(
    "Release approval summary refused: missing or invalid binding.",
  );
  process.exitCode = 1;
}
