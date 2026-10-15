/** Read settings using the existing signed-in gh CLI; prints unsigned public evidence only. */
import { execFileSync } from "node:child_process";
import { createControlsWitness } from "./controls_witness.mjs";
import { RELEASE_POLICY, verifyReleaseSettings } from "./preflight.mjs";

try {
  if (process.argv.length !== 2) throw new Error("unexpected_arguments");
  const read = async (path) =>
    JSON.parse(
      execFileSync("gh", ["api", path], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  const base = `/repos/${RELEASE_POLICY.repository}`;
  const user = await read("/user");
  const repository = await read(base);
  const environment = await read(`${base}/environments/npm`);
  if (
    user.type !== "User" ||
    user.id !== repository.owner?.id ||
    repository.owner?.type !== "User"
  )
    throw new Error("repository_owner_required");
  const ownerReviewer = environment.protection_rules?.some(
    (rule) =>
      rule.type === "required_reviewers" &&
      rule.reviewers?.some(
        (entry) => entry.type === "User" && entry.reviewer?.id === user.id,
      ),
  );
  if (!ownerReviewer) throw new Error("owner_reviewer_required");
  await verifyReleaseSettings(read);
  const summaries = await read(
    `${base}/rulesets?includes_parents=true&per_page=100`,
  );
  if (!Array.isArray(summaries) || summaries.length > 8)
    throw new Error("ruleset_bound");
  const rulesets = [];
  for (const summary of summaries) {
    if (!Number.isSafeInteger(summary.id) || summary.id < 1)
      throw new Error("invalid_ruleset");
    if (
      summary.source !== RELEASE_POLICY.repository ||
      summary.source_type !== "Repository" ||
      summary.enforcement !== "active"
    )
      continue;
    const rule = await read(`${base}/rulesets/${summary.id}`);
    const reference =
      rule.target === "branch"
        ? "refs/heads/main"
        : rule.target === "tag"
          ? "refs/tags/v*"
          : null;
    if (
      reference &&
      rule.conditions?.ref_name?.include?.length === 1 &&
      rule.conditions.ref_name.include[0] === reference &&
      rule.conditions.ref_name.exclude?.length === 0
    )
      rulesets.push(rule);
  }
  console.log(
    JSON.stringify(
      createControlsWitness({
        repository: RELEASE_POLICY.repository,
        repositoryId: repository.id,
        ownerId: user.id,
        environmentId: environment.id,
        observedAt: new Date().toISOString(),
        rulesets,
      }),
      null,
      2,
    ),
  );
} catch {
  console.error(
    "Release witness observation refused. Use the signed-in repository owner and inspect live controls; no settings were changed.",
  );
  process.exitCode = 1;
}
