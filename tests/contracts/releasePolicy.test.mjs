import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  releaseChannel,
  releaseTagsMatch,
  releaseVersion,
  shouldUpdateLatest,
} from "../../scripts/release/channel.mjs";

const root = process.cwd();

describe("release channel policy", () => {
  it("routes beta and release-candidate versions through the beta channel", () => {
    expect(releaseChannel("0.1.0-beta.18", true)).toEqual({
      version: "0.1.0-beta.18",
      prerelease: true,
      npmTag: "beta",
    });
    expect(releaseChannel("0.1.0-rc.1", true).npmTag).toBe("beta");
  });

  it.each(["0.1.0", "1.0.0"])("routes stable %s through latest", (version) => {
    expect(releaseChannel(version, false)).toEqual({
      version,
      prerelease: false,
      npmTag: "latest",
    });
  });

  it.each([
    ["1.0.0+reviewed-build", false, "latest"],
    ["1.0.0-rc.1+reviewed-build", true, "beta"],
    ["1.0.0+001", false, "latest"],
    ["1.0.0-alpha-1+build-2", true, "beta"],
  ])(
    "classifies %s by prerelease identifiers, never build-metadata hyphens",
    (version, prerelease, npmTag) => {
      expect(releaseVersion(version)).toEqual({ version, prerelease, npmTag });
      expect(releaseChannel(version, prerelease).npmTag).toBe(npmTag);
      expect(() => releaseChannel(version, !prerelease)).toThrow(
        /must be published/u,
      );
    },
  );

  it("preserves stable latest with hyphenated build metadata while accepting the new beta tag", () => {
    const tags = {
      latest: "1.0.0+reviewed-build",
      beta: "1.1.0-rc.1+reviewed-build",
    };
    expect(shouldUpdateLatest(tags)).toBe(false);
    expect(releaseTagsMatch(tags, tags.beta, "beta")).toBe(true);
    expect(releaseTagsMatch(tags, tags.latest, "latest")).toBe(true);
    expect(
      releaseTagsMatch({ ...tags, beta: "1.1.0-rc.0" }, tags.beta, "beta"),
    ).toBe(false);
  });

  it("allows prereleases to follow only missing or prerelease latest values", () => {
    expect(shouldUpdateLatest({})).toBe(true);
    expect(shouldUpdateLatest({ latest: "1.0.0-rc.1+reviewed-build" })).toBe(
      true,
    );
    expect(shouldUpdateLatest({ latest: "1.0.0" })).toBe(false);
    expect(
      releaseTagsMatch(
        { latest: "1.0.0-rc.1", beta: "1.0.0-rc.2" },
        "1.0.0-rc.2",
        "beta",
      ),
    ).toBe(false);
    expect(
      releaseTagsMatch(
        { latest: "1.0.0-rc.2", beta: "1.0.0-rc.2" },
        "1.0.0-rc.2",
        "beta",
      ),
    ).toBe(true);
    expect(() =>
      releaseTagsMatch({ latest: "1.0.0" }, "1.0.0", "beta"),
    ).toThrow(/channel/u);
  });

  it.each([
    undefined,
    null,
    10,
    "",
    "latest",
    "1.0",
    "01.0.0",
    "1.0.0-01",
    "1.0.0+build..invalid",
    "1.0.0+build+again",
  ])("refuses malformed versions and existing latest evidence: %s", (value) => {
    expect(() => releaseVersion(value)).toThrow("Invalid package version");
    expect(() => shouldUpdateLatest({ latest: value })).toThrow(
      "Invalid package version",
    );
    expect(() =>
      releaseTagsMatch(
        { latest: value, beta: "1.0.0-rc.2" },
        "1.0.0-rc.2",
        "beta",
      ),
    ).toThrow("Invalid package version");
  });

  it("refuses malformed versions and mismatched GitHub release types", () => {
    expect(() => releaseChannel("beta.18", true)).toThrow(
      "Invalid package version",
    );
    expect(() => releaseChannel("0.1.0-beta.18", false)).toThrow(
      "must be published as a GitHub prerelease",
    );
    expect(() => releaseChannel("0.1.0", true)).toThrow(
      "must be published as a non-prerelease GitHub release",
    );
  });

  it("keeps the protected workflow aligned with the channel policy", async () => {
    const workflow = await readFile(
      join(root, ".github/workflows/publish.yml"),
      "utf8",
    );

    expect(workflow).toContain("scripts/release/channel.mjs");
    expect(workflow).toContain(
      'npm publish "$TARBALL" --access public --tag "$PUBLISH_TAG"',
    );
    expect(workflow).toContain('if test "$PUBLISH_TAG" = "beta"; then');
    expect(workflow).toContain(
      'npm dist-tag add "$PACKAGE_NAME@$PACKAGE_VERSION" latest',
    );
  });

  it("builds and checks generated package metadata before packing release bytes", async () => {
    const gate = await readFile(
      join(root, "scripts/verification/release_gate.mjs"),
      "utf8",
    );
    const check = gate.indexOf('execute("package", "npm", ["run", "check"])');
    const pack = gate.indexOf(
      "const preparedArtifact = await prepareCandidateArtifact",
    );

    expect(check).toBeGreaterThan(-1);
    expect(pack).toBeGreaterThan(check);
  });

  it("checks current release protections before preparation and every privileged mutation path", async () => {
    const workflow = await readFile(
      join(root, ".github/workflows/publish.yml"),
      "utf8",
    );
    const prepare = workflow.slice(
      workflow.indexOf("\n  prepare:"),
      workflow.indexOf("\n  publish:"),
    );
    const publish = workflow.slice(
      workflow.indexOf("\n  publish:"),
      workflow.indexOf("\n  sync-tags:"),
    );
    const sync = workflow.slice(workflow.indexOf("\n  sync-tags:"));
    for (const [phase, body] of [
      ["prepare", prepare],
      ["publish", publish],
      ["sync-tags", sync],
    ]) {
      expect(body).toContain("ref: ${{ github.sha }}");
      expect(body).toContain("GITHUB_TOKEN: ${{ github.token }}");
      expect(body).toContain(
        `run: node scripts/release/preflight.mjs ${phase}`,
      );
    }
    expect(prepare.indexOf("preflight.mjs prepare")).toBeLessThan(
      prepare.indexOf("npm ci --ignore-scripts"),
    );
    expect(publish.indexOf("preflight.mjs publish")).toBeLessThan(
      publish.indexOf('npm publish "$TARBALL"'),
    );
    expect(publish.indexOf("preflight.mjs publish")).toBeLessThan(
      publish.indexOf("npm dist-tag add"),
    );
    expect(sync.indexOf("preflight.mjs sync-tags")).toBeLessThan(
      sync.indexOf("npm dist-tag add"),
    );
    expect(prepare).toContain("timeout-minutes: 30");
    expect(publish).toContain("timeout-minutes: 20");
    expect(sync).toContain("timeout-minutes: 10");
    for (const body of [publish, sync]) {
      expect(body).toContain("environment: npm");
      expect(body).toContain("actions: read");
      expect(body).toContain("id-token: write");
      expect(body.indexOf("preflight.mjs")).toBeLessThan(
        body.indexOf("npm install --global"),
      );
    }
    expect(publish).toContain('--tag "$PUBLISH_TAG" --provenance');
    expect(workflow).not.toMatch(/secrets\.(?:NPM|NODE_AUTH|GH|GITHUB)_TOKEN/u);
  });

  it("binds tag repair to freshly checked registry bytes and publishes an owner review comment before the gate", async () => {
    const workflow = await readFile(
      join(root, ".github/workflows/publish.yml"),
      "utf8",
    );
    const sync = workflow.slice(workflow.indexOf("\n  sync-tags:"));
    expect(sync).toContain("needs: prepare-tags");
    expect(sync).toContain(
      "EXPECTED_SHA256: ${{ needs.prepare-tags.outputs.sha256 }}",
    );
    expect(sync).toContain(
      'echo "$EXPECTED_SHA256  $RUNNER_TEMP/$TARBALL" | sha256sum --check --strict',
    );
    expect(sync.indexOf("sha256sum --check --strict")).toBeLessThan(
      sync.indexOf("npm dist-tag add"),
    );
    expect(workflow).toContain(
      "run: node scripts/release/approval_summary.mjs publish",
    );
    expect(workflow).toContain(
      "run: node scripts/release/approval_summary.mjs sync-tags",
    );
    expect(workflow).toContain(
      "run: node scripts/release/preflight.mjs prepare-tags",
    );
  });

  it("uses the shared SemVer authority for both mutation paths and post-update checks", async () => {
    const workflow = await readFile(
      join(root, ".github/workflows/publish.yml"),
      "utf8",
    );
    expect(workflow.match(/import \{ shouldUpdateLatest \}/gu)).toHaveLength(2);
    expect(workflow.match(/import \{ releaseTagsMatch \}/gu)).toHaveLength(2);
    expect(workflow).toContain(
      "String(releaseVersion(process.argv[1]).prerelease)",
    );
    expect(workflow).not.toContain("*-*");
    expect(workflow).not.toContain('.includes("-")');
    const publish = workflow.slice(
      workflow.indexOf("\n  publish:"),
      workflow.indexOf("\n  sync-tags:"),
    );
    const sync = workflow.slice(workflow.indexOf("\n  sync-tags:"));
    for (const body of [publish, sync]) {
      expect(
        body.indexOf("shouldUpdateLatest(JSON.parse(process.argv[1]))"),
      ).toBeLessThan(
        body.indexOf('npm dist-tag add "$PACKAGE_NAME@$PACKAGE_VERSION" beta'),
      );
    }
  });

  it("serializes publication and tag repair across versions without cancelling an active mutation", async () => {
    const workflow = await readFile(
      join(root, ".github/workflows/publish.yml"),
      "utf8",
    );
    const publish = workflow.slice(
      workflow.indexOf("\n  publish:"),
      workflow.indexOf("\n  sync-tags:"),
    );
    const sync = workflow.slice(workflow.indexOf("\n  sync-tags:"));
    for (const body of [publish, sync]) {
      expect(body).toContain(
        "    concurrency:\n      group: rehearsal-core-npm-mutations\n      cancel-in-progress: false\n",
      );
    }
  });
});
