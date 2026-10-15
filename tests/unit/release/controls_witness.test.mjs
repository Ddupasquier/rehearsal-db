import { describe, expect, it } from "vitest";
import {
  approvalComment,
  assertWitnessApproval,
  controlsWitnessDigest,
  createControlsWitness,
  rulesetPublicDigest,
  witnessRulesetProof,
} from "../../../scripts/release/controls_witness.mjs";

const identity = {
  repository: "Ddupasquier/rehearsal-db",
  repositoryId: 123,
  ownerId: 456,
  environmentId: 789,
};
const observedAt = "2026-10-15T18:00:33.000Z";
const now = new Date("2026-10-15T18:00:40.000Z");
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const ruleset = (id, target, reference) => ({
    id,
    name: "Public API description, not an approval",
    source_type: "Repository",
    source: identity.repository,
    target,
    enforcement: "active",
    bypass_actors: [],
    created_at: "2026-10-15T11:00:30.555-07:00",
    updated_at: "2026-10-15T11:00:30.630-07:00",
    conditions: { ref_name: { include: [reference], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  });
  const branch = ruleset(11, "branch", "refs/heads/main");
  const tag = ruleset(12, "tag", "refs/tags/v*");
  const input = { ...identity, observedAt, rulesets: [branch, tag] };
  return { branch, tag, input, witness: createControlsWitness(input) };
}

const bindings = {
  operation: "publish",
  runId: "12345",
  attempt: "2",
  sourceSha: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  witnessSha256: "c".repeat(64),
};
const review = (overrides = {}) => ({
  state: "approved",
  user: { id: identity.ownerId, login: "owner-public-login", type: "User" },
  environments: [{ id: identity.environmentId, name: "npm" }],
  comment: approvalComment(bindings),
  ...overrides,
});
const expected = () => ({
  comment: approvalComment(bindings),
  ownerId: identity.ownerId,
  environmentId: identity.environmentId,
});

describe("unsigned release-controls witness", () => {
  it("records exactly two observed-empty rulesets with normalized offset timestamps and deterministic digests", () => {
    const f = fixture();
    expect(f.witness).toEqual({
      schemaVersion: 1,
      ...identity,
      observedAt,
      rulesets: [
        {
          id: 11,
          target: "branch",
          createdAt: "2026-10-15T18:00:30.555Z",
          updatedAt: "2026-10-15T18:00:30.630Z",
          publicSha256: rulesetPublicDigest(f.branch),
          bypassActors: [],
        },
        {
          id: 12,
          target: "tag",
          createdAt: "2026-10-15T18:00:30.555Z",
          updatedAt: "2026-10-15T18:00:30.630Z",
          publicSha256: rulesetPublicDigest(f.tag),
          bypassActors: [],
        },
      ],
    });
    expect(
      createControlsWitness({ ...f.input, rulesets: [f.tag, f.branch] }),
    ).toEqual(f.witness);
    expect(controlsWitnessDigest(clone(f.witness))).toBe(
      controlsWitnessDigest(f.witness),
    );
    expect(JSON.stringify(f.witness)).not.toMatch(
      /login|credential|token|Public API description/u,
    );
  });

  it("accepts hidden bypass metadata only with matching independent identity and exact live controls", () => {
    const f = fixture();
    const hidden = clone(f.branch);
    delete hidden.bypass_actors;
    expect(
      witnessRulesetProof(f.witness, hidden, {
        ...identity,
        now,
        maximumAgeMs: 7000,
      }),
    ).toBe(true);
    expect(witnessRulesetProof(f.witness, f.tag, { ...identity, now })).toBe(
      true,
    );
    expect(
      witnessRulesetProof(
        f.witness,
        { ...hidden, updated_at: "2026-10-15T18:00:30.630Z" },
        { ...identity, now },
      ),
    ).toBe(true);
    expect(
      witnessRulesetProof(f.witness, hidden, {
        ...identity,
        now,
        maximumAgeMs: 6999,
      }),
    ).toBe(false);
    expect(
      witnessRulesetProof(f.witness, hidden, {
        ...identity,
        now: new Date("2027-10-15T18:00:40Z"),
      }),
    ).toBe(true);
  });

  it.each([undefined, null, "", {}, [{ actor_type: "User", actor_id: 456 }]])(
    "refuses explicitly present unproven/nonempty bypass metadata (%j)",
    (bypass) => {
      const f = fixture();
      f.branch.bypass_actors = bypass;
      expect(
        witnessRulesetProof(f.witness, f.branch, { ...identity, now }),
      ).toBe(false);
      expect(() => createControlsWitness(f.input)).toThrow(
        "bypass_not_observed_empty",
      );
    },
  );

  it("will not generate an assertion when bypass metadata is hidden", () => {
    const f = fixture();
    delete f.branch.bypass_actors;
    expect(() => createControlsWitness(f.input)).toThrow(
      "bypass_not_observed_empty",
    );
  });

  it.each([
    [
      "ruleset identity",
      (f) => {
        f.branch.id = 99;
      },
    ],
    [
      "creation time",
      (f) => {
        f.branch.created_at = "2026-10-15T18:00:30.554Z";
      },
    ],
    [
      "one millisecond drift",
      (f) => {
        f.branch.updated_at = "2026-10-15T18:00:30.631Z";
      },
    ],
    [
      "public rule change",
      (f) => {
        f.branch.rules.push({ type: "update" });
      },
    ],
    [
      "enforcement",
      (f) => {
        f.branch.enforcement = "evaluate";
      },
    ],
    [
      "references",
      (f) => {
        f.branch.conditions.ref_name.include = ["refs/heads/*"];
      },
    ],
    [
      "missing field",
      (f) => {
        delete f.branch.rules;
      },
    ],
    [
      "wrong repository",
      (f) => {
        f.branch.source = "other/repository";
      },
    ],
  ])("fails closed on live %s", (_name, change) => {
    const f = fixture();
    change(f);
    expect(witnessRulesetProof(f.witness, f.branch, { ...identity, now })).toBe(
      false,
    );
  });

  it.each([
    ["repository", "other/repository"],
    ["repositoryId", 999],
    ["ownerId", 999],
    ["environmentId", 999],
    ["now", new Date("2026-10-15T18:00:32Z")],
    ["now", new Date("invalid")],
    ["maximumAgeMs", -1],
    ["maximumAgeMs", Infinity],
  ])("refuses wrong identity/freshness %s", (field, value) => {
    const f = fixture();
    expect(
      witnessRulesetProof(f.witness, f.branch, {
        ...identity,
        now,
        [field]: value,
      }),
    ).toBe(false);
  });

  it.each([
    [
      "unknown version",
      (w) => {
        w.schemaVersion = 2;
      },
    ],
    [
      "unknown root key",
      (w) => {
        w.approved = true;
      },
    ],
    [
      "unknown ruleset key",
      (w) => {
        w.rulesets[0].approved = true;
      },
    ],
    [
      "public hash",
      (w) => {
        w.rulesets[0].publicSha256 = "d".repeat(64);
      },
    ],
    [
      "bypass assertion",
      (w) => {
        w.rulesets[0].bypassActors.push(456);
      },
    ],
    [
      "duplicate identity",
      (w) => {
        w.rulesets[1].id = w.rulesets[0].id;
      },
    ],
    [
      "duplicate target",
      (w) => {
        w.rulesets[1].target = "branch";
      },
    ],
    [
      "missing ruleset",
      (w) => {
        w.rulesets.pop();
      },
    ],
    [
      "quiet period",
      (w) => {
        w.observedAt = "2026-10-15T18:00:31.000Z";
      },
    ],
    [
      "noncanonical timestamp",
      (w) => {
        w.observedAt = "2026-10-15T11:00:33-07:00";
      },
    ],
  ])("refuses tampered witness %s", (_name, change) => {
    const f = fixture();
    change(f.witness);
    expect(witnessRulesetProof(f.witness, f.branch, { ...identity, now })).toBe(
      false,
    );
  });

  it.each([
    "2026-02-30T11:00:30Z",
    "2026-02-29T11:00:30Z",
    "2026-10-15T25:00:30Z",
    "2026-10-15T11:00:60Z",
    "2026-10-15T11:00:30+25:00",
    "2026-10-15T11:00:30+00:60",
    "2026-10-15T11:00:30-00:00",
    "2026-10-15",
    "15 October 2026",
    "2026-10-15T11:00:30.1234Z",
  ])("rejects ambiguous or invalid calendar timestamp %s", (value) => {
    const f = fixture();
    f.branch.updated_at = value;
    expect(() => createControlsWitness(f.input)).toThrow("invalid_timestamp");
    expect(witnessRulesetProof(f.witness, f.branch, { ...identity, now })).toBe(
      false,
    );
  });

  it("requires the full two-second quiet period and permits valid leap dates/offset seconds", () => {
    const f = fixture();
    expect(() =>
      createControlsWitness({
        ...f.input,
        observedAt: "2026-10-15T18:00:32.629Z",
      }),
    ).toThrow("invalid_witness_ruleset");
    expect(
      createControlsWitness({
        ...f.input,
        observedAt: "2026-10-15T18:00:32.630Z",
      }).observedAt,
    ).toBe("2026-10-15T18:00:32.630Z");
    f.branch.created_at = "2024-02-29T01:00:00+01:00";
    expect(createControlsWitness(f.input).rulesets[0].createdAt).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("canonicalizes object keys but binds every public control field and array order", () => {
    const f = fixture();
    const reordered = Object.fromEntries(Object.entries(f.branch).reverse());
    reordered.conditions = {
      ref_name: { exclude: [], include: ["refs/heads/main"] },
    };
    expect(rulesetPublicDigest(reordered)).toBe(rulesetPublicDigest(f.branch));
    expect(
      rulesetPublicDigest({
        ...f.branch,
        bypass_actors: ["hidden"],
        updated_at: "different",
        name: "renamed",
      }),
    ).toBe(rulesetPublicDigest(f.branch));
    expect(
      rulesetPublicDigest({
        ...f.branch,
        rules: [...f.branch.rules].reverse(),
      }),
    ).not.toBe(rulesetPublicDigest(f.branch));
  });

  it("bounds public JSON and refuses excessive nesting, non-JSON values and oversized collections", () => {
    const f = fixture();
    expect(() =>
      rulesetPublicDigest({
        ...f.branch,
        rules: Array(1001).fill({ type: "update" }),
      }),
    ).toThrow("metadata_bound");
    expect(() =>
      rulesetPublicDigest({ ...f.branch, rules: [{ type: undefined }] }),
    ).toThrow("invalid_metadata");
    expect(() =>
      rulesetPublicDigest({
        ...f.branch,
        rules: [{ type: "x".repeat(65_537) }],
      }),
    ).toThrow("metadata_bound");
    let nested = {};
    for (let i = 0; i < 21; i++) nested = { nested };
    expect(() => rulesetPublicDigest({ ...f.branch, rules: [nested] })).toThrow(
      "metadata_bound",
    );
  });
});

describe("authenticated owner approval binding", () => {
  it("accepts the actual owner and exact npm environment approval, with unrelated prior history", () => {
    expect(assertWitnessApproval([review()], expected())).toBe(true);
    expect(
      assertWitnessApproval(
        [review({ comment: "An unrelated earlier approval" }), review()],
        expected(),
      ),
    ).toBe(true);
    expect(
      approvalComment({
        ...bindings,
        operation: "sync-tags",
        runId: 12345,
        attempt: 2,
      }),
    ).toContain("operation=sync-tags\nrun=12345\nattempt=2");
  });

  it.each([
    ["operation", "sync-tags"],
    ["runId", "12346"],
    ["attempt", "3"],
    ["sourceSha", "d".repeat(40)],
    ["artifactSha256", "d".repeat(64)],
    ["witnessSha256", "d".repeat(64)],
  ])("refuses replay or mismatch in %s", (field, value) => {
    expect(() =>
      assertWitnessApproval(
        [review({ comment: approvalComment({ ...bindings, [field]: value }) })],
        expected(),
      ),
    ).toThrow("owner_approval_not_proven");
  });

  it.each([
    ["wrong owner", { user: { id: 999, type: "User" } }],
    ["bot", { user: { id: identity.ownerId, type: "Bot" } }],
    ["rejected", { state: "rejected" }],
    ["wrong environment", { environments: [{ id: 999, name: "npm" }] }],
    [
      "wrong environment name",
      { environments: [{ id: identity.environmentId, name: "other" }] },
    ],
    ["partial approval", { comment: "Ship it!" }],
    [
      "extra environment",
      {
        environments: [
          { id: identity.environmentId, name: "npm" },
          { id: 999, name: "other" },
        ],
      },
    ],
  ])(
    "does not confuse %s with the exact bound human approval",
    (_name, changes) => {
      expect(() =>
        assertWitnessApproval([review(changes)], expected()),
      ).toThrow("owner_approval_not_proven");
    },
  );

  it("refuses ambiguous, empty, malformed, oversized and unknown approval metadata", () => {
    for (const reviews of [
      [],
      null,
      [null],
      [review(), review()],
      [review(), review({ state: "rejected" })],
      [review({ state: "bypassed" })],
      Array(101).fill(review()),
      [review({ comment: "x".repeat(4097) })],
    ])
      expect(() => assertWitnessApproval(reviews, expected())).toThrow(
        "Release witness refused:",
      );
    expect(() =>
      assertWitnessApproval([review()], { ...expected(), comment: "" }),
    ).toThrow("invalid_approval_metadata");
    const unsafeRun = expected().comment.replace(
      "run=12345",
      "run=9999999999999999",
    );
    expect(() =>
      assertWitnessApproval([review({ comment: unsafeRun })], {
        ...expected(),
        comment: unsafeRun,
      }),
    ).toThrow("invalid_approval_binding");
  });

  it.each([
    ["operation", "prepare"],
    ["runId", "01"],
    ["attempt", 0],
    ["runId", Number.MAX_SAFE_INTEGER + 1],
    ["sourceSha", "short"],
    ["artifactSha256", "private-secret"],
    ["witnessSha256", "A".repeat(64)],
  ])(
    "refuses malformed approval binding %s without echoing its value",
    (field, value) => {
      expect(() => approvalComment({ ...bindings, [field]: value })).toThrow(
        "invalid_approval_binding",
      );
      expect(() =>
        approvalComment({ ...bindings, [field]: value }),
      ).not.toThrow("private-secret");
    },
  );
});
