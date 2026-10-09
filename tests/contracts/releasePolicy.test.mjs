import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseChannel } from "../../scripts/release/channel.mjs";

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

  it("routes a stable version through latest", () => {
    expect(releaseChannel("0.1.0", false)).toEqual({
      version: "0.1.0",
      prerelease: false,
      npmTag: "latest",
    });
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
});
