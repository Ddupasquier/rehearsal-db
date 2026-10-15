/** Classify a reviewed GitHub release without relying on mutable npm state. */

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const releaseVersion = (version) => {
  const match =
    typeof version === "string" && version.length <= 200
      ? SEMVER.exec(version)
      : null;
  if (!match || match[1]?.split(".").some((part) => /^0\d+$/u.test(part)))
    throw new Error("Invalid package version.");
  const prerelease = match[1] !== undefined;
  return Object.freeze({
    version,
    prerelease,
    npmTag: prerelease ? "beta" : "latest",
  });
};

export const releaseChannel = (version, githubPrerelease) => {
  const channel = releaseVersion(version);
  const { prerelease } = channel;
  if (githubPrerelease !== prerelease) {
    throw new Error(
      prerelease
        ? `${version} must be published as a GitHub prerelease.`
        : `${version} must be published as a non-prerelease GitHub release.`,
    );
  }

  return channel;
};

const checkedTags = (tags) => {
  if (!tags || typeof tags !== "object" || Array.isArray(tags))
    throw new Error("Invalid npm dist-tag result.");
  for (const key of ["latest", "beta"])
    if (Object.hasOwn(tags, key)) releaseVersion(tags[key]);
  return tags;
};

/** A prerelease may follow a missing/prerelease latest, never a stable latest. */
export const shouldUpdateLatest = (tags) => {
  checkedTags(tags);
  return (
    !Object.hasOwn(tags, "latest") || releaseVersion(tags.latest).prerelease
  );
};

/** Validate observable registry tags using the same SemVer authority as publishing. */
export const releaseTagsMatch = (tags, version, npmTag) => {
  checkedTags(tags);
  const expected = releaseVersion(version);
  if (npmTag !== expected.npmTag)
    throw new Error("Release channel does not match the package version.");
  if (npmTag === "latest") return tags.latest === version;
  return (
    tags.beta === version &&
    (tags.latest === version ||
      (Object.hasOwn(tags, "latest") &&
        !releaseVersion(tags.latest).prerelease))
  );
};

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const [version, prereleaseValue] = process.argv.slice(2);
  if (!version || !["true", "false"].includes(prereleaseValue)) {
    console.error(
      "Usage: node scripts/release/channel.mjs <version> <true|false>",
    );
    process.exitCode = 2;
  } else {
    try {
      console.log(
        JSON.stringify(releaseChannel(version, prereleaseValue === "true")),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
