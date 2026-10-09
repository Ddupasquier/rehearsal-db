/** Classify a reviewed GitHub release without relying on mutable npm state. */

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const releaseChannel = (version, githubPrerelease) => {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Invalid package version: ${version}`);

  const prerelease = match[1] !== undefined;
  if (githubPrerelease !== prerelease) {
    throw new Error(
      prerelease
        ? `${version} must be published as a GitHub prerelease.`
        : `${version} must be published as a non-prerelease GitHub release.`,
    );
  }

  return Object.freeze({
    version,
    prerelease,
    npmTag: prerelease ? "beta" : "latest",
  });
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
