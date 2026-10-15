import { describe, expect, it } from "vitest";
import {
  githubReleaseReader,
  releaseExecution,
  releasePreflight,
  RELEASE_POLICY,
  verifyReleaseSettings,
} from "../../../scripts/release/preflight.mjs";

const base = "/repos/Ddupasquier/rehearsal-db";
const sha = "a".repeat(40);
const mainSha = "b".repeat(40);
const context = (mode = "prepare") => ({
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: RELEASE_POLICY.repository,
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_JOB: mode,
  GITHUB_EVENT_NAME: mode === "sync-tags" ? "workflow_dispatch" : "release",
  GITHUB_REF:
    mode === "sync-tags" ? "refs/heads/main" : "refs/tags/v0.1.0-rc.5",
  GITHUB_SHA: sha,
  GITHUB_WORKFLOW_SHA: sha,
  GITHUB_WORKFLOW_REF: `${RELEASE_POLICY.repository}/${RELEASE_POLICY.workflow}@${mode === "sync-tags" ? "refs/heads/main" : "refs/tags/v0.1.0-rc.5"}`,
  GITHUB_TOKEN: "private-test-sentinel",
});

function fixture(mode = "prepare") {
  const ruleset = (id, target, reference, rules) => ({
    id,
    target,
    source_type: "Repository",
    source: RELEASE_POLICY.repository,
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: [reference], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }, ...rules],
  });
  const branch = ruleset(1, "branch", "refs/heads/main", [
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: RELEASE_POLICY.checks.map((context) => ({
          context,
        })),
      },
    },
  ]);
  const tag = ruleset(2, "tag", "refs/tags/v*", [{ type: "update" }]);
  const values = new Map([
    [
      base,
      {
        full_name: RELEASE_POLICY.repository,
        visibility: "public",
        private: false,
        archived: false,
        default_branch: "main",
      },
    ],
    [
      `${base}/branches/main`,
      {
        name: "main",
        protected: true,
        commit: { sha: mode === "sync-tags" ? sha : mainSha },
      },
    ],
    [
      `${base}/environments/npm`,
      {
        name: "npm",
        can_admins_bypass: false,
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: false,
            reviewers: [
              {
                type: "User",
                reviewer: { id: 123, login: "never-log-reviewers" },
              },
            ],
          },
        ],
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      },
    ],
    [
      `${base}/environments/npm/deployment-branch-policies?per_page=100`,
      {
        total_count: 2,
        branch_policies: [
          { name: "main", type: "branch" },
          { name: "v*", type: "tag" },
        ],
      },
    ],
    [`${base}/rulesets?includes_parents=true&per_page=100`, [branch, tag]],
    [`${base}/rulesets/1`, branch],
    [`${base}/rulesets/2`, tag],
    [
      `${base}/git/ref/tags/v0.1.0-rc.5`,
      { ref: "refs/tags/v0.1.0-rc.5", object: { type: "commit", sha } },
    ],
    [
      `${base}/compare/${sha}...${mainSha}?per_page=1`,
      { status: "ahead", behind_by: 0, merge_base_commit: { sha } },
    ],
  ]);
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname + new URL(url).search;
    if (!values.has(path)) return new Response("unavailable", { status: 404 });
    return Response.json(values.get(path));
  };
  return { branch, tag, values, calls, fetcher };
}

describe("release protection preflight", () => {
  it("accepts valid build metadata without confusing its hyphen with a prerelease", () => {
    const environment = context();
    environment.GITHUB_REF = "refs/tags/v1.0.0+reviewed-build";
    environment.GITHUB_WORKFLOW_REF = `${RELEASE_POLICY.repository}/${RELEASE_POLICY.workflow}@${environment.GITHUB_REF}`;
    expect(releaseExecution("prepare", environment).reference).toBe(
      environment.GITHUB_REF,
    );
  });
  it.each(["1.0.0-rc.1+reviewed-build", "1.0.0+001"])(
    "accepts the shared SemVer classification for %s",
    (version) => {
      const environment = context();
      environment.GITHUB_REF = `refs/tags/v${version}`;
      environment.GITHUB_WORKFLOW_REF = `${RELEASE_POLICY.repository}/${RELEASE_POLICY.workflow}@${environment.GITHUB_REF}`;
      expect(releaseExecution("prepare", environment).reference).toBe(
        environment.GITHUB_REF,
      );
    },
  );
  it.each(["1.0.0-01", "1.0.0+build..invalid"])(
    "refuses malformed version in release tag %s",
    (version) => {
      const environment = context();
      environment.GITHUB_REF = `refs/tags/v${version}`;
      environment.GITHUB_WORKFLOW_REF = `${RELEASE_POLICY.repository}/${RELEASE_POLICY.workflow}@${environment.GITHUB_REF}`;
      expect(() => releaseExecution("prepare", environment)).toThrow(
        "invalid_release_tag",
      );
    },
  );
  it.each(["prepare", "publish", "sync-tags"])(
    "validates %s using only bounded read-only GitHub metadata",
    async (mode) => {
      const f = fixture(mode);
      const result = await releasePreflight({
        mode,
        environment: context(mode),
        fetcher: f.fetcher,
      });
      expect(result.status).toBe("passed");
      expect(result.limitations.join(" ")).toContain(
        "do not establish an observed approval hold",
      );
      expect(JSON.stringify(result)).not.toMatch(
        /private-test-sentinel|never-log-reviewers/u,
      );
      expect(
        f.calls.every(
          (call) =>
            call.options.method === "GET" &&
            call.options.redirect === "error" &&
            call.url.startsWith(`https://api.github.com${base}`),
        ),
      ).toBe(true);
      expect(f.calls.length).toBeLessThanOrEqual(10);
      expect(
        f.calls.every(
          (call) =>
            call.options.headers.Authorization ===
            "Bearer private-test-sentinel",
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["GITHUB_ACTIONS", "false"],
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_REPOSITORY", "someone/rehearsal-db"],
    ["GITHUB_API_URL", "https://untrusted.test"],
    ["GITHUB_SERVER_URL", "https://untrusted.test"],
    ["GITHUB_JOB", "other"],
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_SHA", "short"],
    ["GITHUB_WORKFLOW_SHA", mainSha],
    [
      "GITHUB_WORKFLOW_REF",
      `${RELEASE_POLICY.repository}/.github/workflows/other.yml@refs/tags/v0.1.0-rc.5`,
    ],
  ])(
    "refuses untrusted execution field %s before any API call",
    async (key, value) => {
      const f = fixture();
      await expect(
        releasePreflight({
          mode: "prepare",
          environment: { ...context(), [key]: value },
          fetcher: f.fetcher,
        }),
      ).rejects.toThrow("Release preflight refused:");
      expect(f.calls).toEqual([]);
    },
  );

  it("refuses private source immediately and never mistakes admin access for provenance readiness", async () => {
    const f = fixture();
    f.values.set(base, {
      ...f.values.get(base),
      private: true,
      visibility: "private",
      permissions: { admin: true },
    });
    await expect(
      releasePreflight({
        mode: "prepare",
        environment: context(),
        fetcher: f.fetcher,
      }),
    ).rejects.toThrow("repository_not_public_release_source");
    expect(f.calls).toHaveLength(1);
  });

  it.each([403, 404, 429, 500])(
    "treats HTTP %i as unavailable protection, without retries or raw response logging",
    async (status) => {
      let calls = 0;
      await expect(
        releasePreflight({
          mode: "prepare",
          environment: context(),
          fetcher: async () => {
            calls++;
            return new Response("private-test-sentinel", { status });
          },
        }),
      ).rejects.toThrow("metadata_unavailable_or_paginated");
      expect(calls).toBe(1);
    },
  );

  it.each([
    [
      "administrator bypass",
      (environment) => {
        environment.can_admins_bypass = true;
      },
    ],
    [
      "unknown bypass policy",
      (environment) => {
        delete environment.can_admins_bypass;
      },
    ],
    [
      "missing review rule",
      (environment) => {
        environment.protection_rules = [];
      },
    ],
    [
      "empty reviewers",
      (environment) => {
        environment.protection_rules[0].reviewers = [];
      },
    ],
    [
      "unknown reviewer",
      (environment) => {
        environment.protection_rules[0].reviewers[0].type = "App";
      },
    ],
    [
      "ambiguous branch policy",
      (environment) => {
        environment.deployment_branch_policy = {
          protected_branches: true,
          custom_branch_policies: false,
        };
      },
    ],
  ])("refuses %s", async (_name, mutate) => {
    const f = fixture();
    mutate(f.values.get(`${base}/environments/npm`));
    await expect(
      releasePreflight({
        mode: "prepare",
        environment: context(),
        fetcher: f.fetcher,
      }),
    ).rejects.toThrow("Release preflight refused:");
  });

  it.each([
    [
      "broad deployment pattern",
      (policies) => {
        policies.branch_policies[0].name = "*";
      },
    ],
    [
      "missing branch/tag type",
      (policies) => {
        delete policies.branch_policies[1].type;
      },
    ],
    [
      "unread next page",
      (policies) => {
        policies.total_count = 3;
      },
    ],
  ])("refuses %s", async (_name, mutate) => {
    const f = fixture();
    mutate(
      f.values.get(
        `${base}/environments/npm/deployment-branch-policies?per_page=100`,
      ),
    );
    await expect(
      releasePreflight({
        mode: "prepare",
        environment: context(),
        fetcher: f.fetcher,
      }),
    ).rejects.toThrow("deployment_scope_not_exact");
  });

  it.each([
    [
      "evaluate mode",
      (f) => {
        f.branch.enforcement = "evaluate";
      },
    ],
    [
      "bypass actor",
      (f) => {
        f.branch.bypass_actors = [
          { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
        ];
      },
    ],
    [
      "excluded main",
      (f) => {
        f.branch.conditions.ref_name.exclude = ["refs/heads/main"];
      },
    ],
    [
      "wrong main rule target",
      (f) => {
        f.branch.conditions.ref_name.include = ["refs/heads/*"];
      },
    ],
    [
      "missing status check",
      (f) => {
        f.branch.rules[3].parameters.required_status_checks.pop();
      },
    ],
    [
      "missing PR rule",
      (f) => {
        f.branch.rules = f.branch.rules.filter(
          (rule) => rule.type !== "pull_request",
        );
      },
    ],
    [
      "wrong source repository",
      (f) => {
        f.tag.source = "another/repository";
      },
    ],
    [
      "tag updates permitted",
      (f) => {
        f.tag.rules = f.tag.rules.filter((rule) => rule.type !== "update");
      },
    ],
  ])("refuses %s", async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(
      releasePreflight({
        mode: "prepare",
        environment: context(),
        fetcher: f.fetcher,
      }),
    ).rejects.toThrow("Release preflight refused:");
  });

  it("rejects changed ruleset identity between listing and detail", async () => {
    const f = fixture();
    f.values.set(`${base}/rulesets/1`, { ...f.branch, id: 99 });
    await expect(
      releasePreflight({
        mode: "prepare",
        environment: context(),
        fetcher: f.fetcher,
      }),
    ).rejects.toThrow("ruleset_identity_changed");
  });

  it("refuses a moved release tag, unrelated main and dispatch after main moved", async () => {
    const moved = fixture();
    moved.values.get(`${base}/git/ref/tags/v0.1.0-rc.5`).object.sha = mainSha;
    await expect(
      releasePreflight({
        mode: "prepare",
        environment: context(),
        fetcher: moved.fetcher,
      }),
    ).rejects.toThrow("release_tag_moved");
    const unrelated = fixture();
    unrelated.values.get(
      `${base}/compare/${sha}...${mainSha}?per_page=1`,
    ).behind_by = 1;
    await expect(
      releasePreflight({
        mode: "prepare",
        environment: context(),
        fetcher: unrelated.fetcher,
      }),
    ).rejects.toThrow("release_not_on_reviewed_main");
    const dispatch = fixture("sync-tags");
    dispatch.values.get(`${base}/branches/main`).commit.sha = mainSha;
    await expect(
      releasePreflight({
        mode: "sync-tags",
        environment: context("sync-tags"),
        fetcher: dispatch.fetcher,
      }),
    ).rejects.toThrow("main_moved_since_dispatch");
  });

  it("supports a bounded annotated tag and refuses cyclic tag resolution", async () => {
    const f = fixture();
    const tagSha = "c".repeat(40);
    f.values.get(`${base}/git/ref/tags/v0.1.0-rc.5`).object = {
      type: "tag",
      sha: tagSha,
    };
    f.values.set(`${base}/git/tags/${tagSha}`, {
      object: { type: "commit", sha },
    });
    await expect(
      releasePreflight({
        mode: "prepare",
        environment: context(),
        fetcher: f.fetcher,
      }),
    ).resolves.toMatchObject({ status: "passed" });
    f.values.set(`${base}/git/tags/${tagSha}`, {
      object: { type: "tag", sha: tagSha },
    });
    await expect(
      releasePreflight({
        mode: "prepare",
        environment: context(),
        fetcher: f.fetcher,
      }),
    ).rejects.toThrow("invalid_tag_chain");
  });

  it("bounds response size, pages, paths, transport errors and invalid JSON", async () => {
    const path = base;
    for (const response of [
      new Response("{}", {
        headers: { link: '<https://api.github.com/next>; rel="next"' },
      }),
      new Response("not json"),
      new Response("x".repeat(1024 * 1024 + 1)),
    ])
      await expect(
        githubReleaseReader({ fetcher: async () => response })(path),
      ).rejects.toThrow("Release preflight refused:");
    await expect(
      githubReleaseReader({
        fetcher: async () => {
          throw new Error("private-test-sentinel");
        },
      })(path),
    ).rejects.toThrow("metadata_unavailable");
    await expect(
      githubReleaseReader({
        fetcher: async () => {
          throw Error("must not call");
        },
      })("/repos/other/repo"),
    ).rejects.toThrow("untrusted_api_path");
    await expect(
      githubReleaseReader({
        fetcher: async () => {
          throw Error("must not call");
        },
      })(`${base}/../../other/repo`),
    ).rejects.toThrow("untrusted_api_path");
    const read = githubReleaseReader({
      fetcher: async () => Response.json({}),
    });
    for (let index = 0; index < 20; index++) await read(path);
    await expect(read(path)).rejects.toThrow("request_bound");
  });

  it("does not treat a bare protected flag or malformed metadata as complete settings proof", async () => {
    const f = fixture();
    f.values.set(`${base}/rulesets?includes_parents=true&per_page=100`, []);
    await expect(
      verifyReleaseSettings((path) => Promise.resolve(f.values.get(path))),
    ).rejects.toThrow("rulesets_unavailable");
    expect(() => releaseExecution("unknown", context())).toThrow(
      "invalid_execution",
    );
  });
});
