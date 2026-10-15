/** Read-only release settings gate. Unknown protection is not permission to publish. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseVersion } from "./channel.mjs";

export const RELEASE_POLICY = Object.freeze({
  repository: "Ddupasquier/rehearsal-db",
  workflow: ".github/workflows/publish.yml",
  environment: "npm",
  branch: "main",
  tagPattern: "v*",
  checks: Object.freeze([
    "package (22)",
    "package (24)",
    "package (26)",
    "installed-fixture",
    "onboarding-fixture",
    "postgresql-fixture",
  ]),
});

const fail = (code) => {
  throw new Error(
    `Release preflight refused: ${code}. Review the release boundary; no publication or tag change is authorized.`,
  );
};
const object = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_metadata");
  return value;
};
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const exactList = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  expected.every((value) => actual.includes(value));

export function releaseExecution(mode, environment) {
  const names = {
    prepare: "release",
    publish: "release",
    "sync-tags": "workflow_dispatch",
  };
  if (
    !Object.hasOwn(names, mode) ||
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== names[mode]
  )
    fail("invalid_execution");
  if (
    environment.GITHUB_REPOSITORY !== RELEASE_POLICY.repository ||
    environment.GITHUB_API_URL !== "https://api.github.com" ||
    environment.GITHUB_SERVER_URL !== "https://github.com" ||
    environment.GITHUB_JOB !== mode
  )
    fail("untrusted_workflow_identity");
  const reference = environment.GITHUB_REF;
  if (mode === "sync-tags") {
    if (reference !== "refs/heads/main") fail("unapproved_branch");
  } else {
    if (typeof reference !== "string" || !reference.startsWith("refs/tags/v"))
      fail("unapproved_tag");
    try {
      releaseVersion(reference.slice("refs/tags/v".length));
    } catch {
      fail("invalid_release_tag");
    }
  }
  if (
    !digest(environment.GITHUB_SHA) ||
    environment.GITHUB_WORKFLOW_REF !==
      `${RELEASE_POLICY.repository}/${RELEASE_POLICY.workflow}@${reference}` ||
    environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA
  )
    fail("unpinned_workflow_reference");
  return Object.freeze({ mode, reference, sha: environment.GITHUB_SHA });
}

export function githubReleaseReader({ fetcher = fetch, token } = {}) {
  let requests = 0;
  return async (path) => {
    if (
      !path.startsWith(`/repos/${RELEASE_POLICY.repository}/`) &&
      path !== `/repos/${RELEASE_POLICY.repository}`
    )
      fail("untrusted_api_path");
    const target = new URL(`https://api.github.com${path}`);
    if (target.pathname + target.search !== path || target.hash)
      fail("untrusted_api_path");
    if (++requests > 20) fail("request_bound");
    let response;
    try {
      response = await fetcher(target.href, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      fail("metadata_unavailable");
    }
    if (response.status !== 200 || response.headers.get("link"))
      fail("metadata_unavailable_or_paginated");
    if (!response.body) fail("invalid_metadata");
    const reader = response.body.getReader();
    const parts = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) {
          await reader.cancel();
          fail("metadata_size_bound");
        }
        parts.push(value);
      }
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Release preflight refused:")
      )
        throw error;
      fail("invalid_metadata");
    } finally {
      reader.releaseLock();
    }
  };
}

const refConditions = (ruleset, reference) => {
  const conditions = object(ruleset.conditions);
  if (!exactList(Object.keys(conditions), ["ref_name"])) return false;
  const names = object(conditions.ref_name);
  return exactList(names.include, [reference]) && exactList(names.exclude, []);
};

function protectedRuleset(raw, target, reference) {
  const ruleset = object(raw);
  if (
    ruleset.source_type !== "Repository" ||
    ruleset.source !== RELEASE_POLICY.repository ||
    ruleset.target !== target ||
    ruleset.enforcement !== "active" ||
    !exactList(ruleset.bypass_actors, []) ||
    !refConditions(ruleset, reference) ||
    !Array.isArray(ruleset.rules)
  )
    return false;
  const types = ruleset.rules.map((rule) => object(rule).type);
  if (
    new Set(types).size !== types.length ||
    !types.includes("deletion") ||
    !types.includes("non_fast_forward")
  )
    return false;
  if (target === "tag") return types.includes("update");
  const review = ruleset.rules.find((rule) => rule.type === "pull_request");
  const checks = ruleset.rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  if (!review || !checks) return false;
  const reviewParameters = object(review.parameters);
  const checkParameters = object(checks.parameters);
  // The human artifact approval is the npm environment gate. A single maintainer
  // may use PRs with zero peer approvals, but stale approvals must never survive edits.
  return (
    Number.isSafeInteger(reviewParameters.required_approving_review_count) &&
    reviewParameters.required_approving_review_count >= 0 &&
    reviewParameters.dismiss_stale_reviews_on_push === true &&
    checkParameters.strict_required_status_checks_policy === true &&
    Array.isArray(checkParameters.required_status_checks) &&
    RELEASE_POLICY.checks.every((context) =>
      checkParameters.required_status_checks.some(
        (check) => object(check).context === context,
      ),
    )
  );
}

export async function verifyReleaseSettings(read) {
  const base = `/repos/${RELEASE_POLICY.repository}`;
  const repository = object(await read(base));
  if (
    repository.full_name !== RELEASE_POLICY.repository ||
    repository.private !== false ||
    repository.visibility !== "public" ||
    repository.archived !== false ||
    repository.default_branch !== "main"
  )
    fail("repository_not_public_release_source");
  const branch = object(await read(`${base}/branches/main`));
  if (
    branch.name !== "main" ||
    branch.protected !== true ||
    !digest(object(branch.commit).sha)
  )
    fail("main_not_protected");
  const environment = object(await read(`${base}/environments/npm`));
  if (environment.can_admins_bypass !== false)
    fail("environment_bypass_not_disabled");
  const reviewerRules = Array.isArray(environment.protection_rules)
    ? environment.protection_rules.filter(
        (rule) => object(rule).type === "required_reviewers",
      )
    : [];
  if (environment.name !== "npm" || reviewerRules.length !== 1)
    fail("human_approval_missing");
  const reviewers = reviewerRules[0].reviewers;
  if (
    !Array.isArray(reviewers) ||
    reviewers.length < 1 ||
    reviewers.length > 6 ||
    reviewers.some(
      (entry) =>
        !["User", "Team"].includes(object(entry).type) ||
        !Number.isSafeInteger(object(entry.reviewer).id) ||
        entry.reviewer.id < 1,
    )
  )
    fail("human_approval_missing");
  const deployment = object(environment.deployment_branch_policy);
  if (
    deployment.protected_branches !== false ||
    deployment.custom_branch_policies !== true
  )
    fail("deployment_scope_not_exact");
  const policies = object(
    await read(
      `${base}/environments/npm/deployment-branch-policies?per_page=100`,
    ),
  );
  if (
    policies.total_count !== 2 ||
    !Array.isArray(policies.branch_policies) ||
    policies.branch_policies.length !== 2 ||
    !exactList(
      policies.branch_policies.map(
        (policy) => `${object(policy).type}:${policy.name}`,
      ),
      ["branch:main", "tag:v*"],
    )
  )
    fail("deployment_scope_not_exact");
  const summaries = await read(
    `${base}/rulesets?includes_parents=true&per_page=100`,
  );
  if (!Array.isArray(summaries) || !summaries.length || summaries.length >= 100)
    fail("rulesets_unavailable");
  const candidates = summaries.filter((raw) => {
    const rule = object(raw);
    return (
      rule.enforcement === "active" &&
      rule.source_type === "Repository" &&
      rule.source === RELEASE_POLICY.repository &&
      ["branch", "tag"].includes(rule.target)
    );
  });
  if (candidates.length > 8) fail("ruleset_bound");
  const rulesets = [];
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.id) || candidate.id < 1)
      fail("invalid_ruleset_identity");
    const ruleset = object(await read(`${base}/rulesets/${candidate.id}`));
    if (ruleset.id !== candidate.id || ruleset.target !== candidate.target)
      fail("ruleset_identity_changed");
    rulesets.push(ruleset);
  }
  if (
    !rulesets.some((rule) =>
      protectedRuleset(rule, "branch", "refs/heads/main"),
    )
  )
    fail("main_ruleset_not_proven");
  if (!rulesets.some((rule) => protectedRuleset(rule, "tag", "refs/tags/v*")))
    fail("tag_ruleset_not_proven");
  return { mainSha: branch.commit.sha };
}

export async function releasePreflight({
  mode,
  environment = process.env,
  fetcher = fetch,
}) {
  const execution = releaseExecution(mode, environment);
  const read = githubReleaseReader({
    fetcher,
    token: environment.GITHUB_TOKEN,
  });
  const settings = await verifyReleaseSettings(read);
  const base = `/repos/${RELEASE_POLICY.repository}`;
  if (mode === "sync-tags") {
    if (settings.mainSha !== execution.sha) fail("main_moved_since_dispatch");
  } else {
    const tag = execution.reference.slice("refs/tags/".length);
    let target = object(
      object(await read(`${base}/git/ref/tags/${encodeURIComponent(tag)}`))
        .object,
    );
    const seen = new Set();
    while (target.type === "tag" && seen.size < 4) {
      if (!digest(target.sha) || seen.has(target.sha))
        fail("invalid_tag_chain");
      seen.add(target.sha);
      target = object(
        object(await read(`${base}/git/tags/${target.sha}`)).object,
      );
    }
    if (target.type !== "commit" || target.sha !== execution.sha)
      fail("release_tag_moved");
    const comparison = object(
      await read(
        `${base}/compare/${execution.sha}...${settings.mainSha}?per_page=1`,
      ),
    );
    if (
      !["ahead", "identical"].includes(comparison.status) ||
      comparison.behind_by !== 0 ||
      object(comparison.merge_base_commit).sha !== execution.sha
    )
      fail("release_not_on_reviewed_main");
  }
  return {
    status: "passed",
    operation: mode,
    repository: RELEASE_POLICY.repository,
    workflow: RELEASE_POLICY.workflow,
    environment: RELEASE_POLICY.environment,
    sourceSha: execution.sha,
    limitations: [
      "Settings do not establish an observed approval hold or authorize publication.",
      "npm publisher/account controls and owner approval require separate verification.",
    ],
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (process.argv.length !== 3) fail("expected_one_operation");
    console.log(
      JSON.stringify(
        await releasePreflight({ mode: process.argv[2] }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      error instanceof Error &&
        error.message.startsWith("Release preflight refused:")
        ? error.message
        : "Release preflight refused: unavailable evidence. No publication or tag change is authorized.",
    );
    process.exitCode = 1;
  }
}
