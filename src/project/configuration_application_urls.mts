/** An application cannot listen on the database or provider service ports it depends on. */
import { assertLoopbackUrl } from "./configuration_validation.mjs";

export const assertApplicationPortDoesNotOverlap = (
  url: string,
  servicePorts: readonly number[],
  path: string,
): void => {
  const parsed = new URL(url);
  if (parsed.port && servicePorts.includes(Number(parsed.port)))
    throw new Error(
      `${path} overlaps a configured database/API/Studio service port. Choose a separate application port and align the project start command; no services were started.`,
    );
};

export const normalizeApplicationUrls = ({
  applicationUrl,
  readinessUrl,
  allowedHosts,
  servicePorts,
}: {
  readonly applicationUrl: unknown;
  readonly readinessUrl: unknown;
  readonly allowedHosts: readonly string[];
  readonly servicePorts: readonly number[];
}) => {
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  const normalized = assertLoopbackUrl(
    applicationUrl,
    "config.runtime.applicationUrl",
    allowedHosts,
    loopbackHosts,
  );
  const ready =
    readinessUrl === undefined
      ? null
      : assertLoopbackUrl(
          readinessUrl,
          "config.application.readiness.url",
          allowedHosts,
          loopbackHosts,
        );
  assertApplicationPortDoesNotOverlap(
    normalized,
    servicePorts,
    "config.runtime.applicationUrl",
  );
  if (ready !== null)
    assertApplicationPortDoesNotOverlap(
      ready,
      servicePorts,
      "config.application.readiness.url",
    );
  return Object.freeze({ applicationUrl: normalized, readinessUrl: ready });
};
