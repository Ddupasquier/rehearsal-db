/** Require an explicit cooperative application signal before enabling foreground idle stop. */
import { validateApplicationActivityUrl } from "../application/activity_contract.mjs";
import {
  assertKnownKeys,
  assertPlainObject,
} from "./configuration_validation.mjs";

export const normalizeApplicationActivity = ({
  value,
  readinessUrl,
  openPersistence,
  idleTimeoutSeconds,
}: {
  readonly value: unknown;
  readonly readinessUrl: string | null;
  readonly openPersistence: unknown;
  readonly idleTimeoutSeconds: unknown;
}) => {
  const timeout =
    idleTimeoutSeconds === undefined || idleTimeoutSeconds === null
      ? null
      : idleTimeoutSeconds;
  if (
    timeout !== null &&
    (typeof timeout !== "number" ||
      !Number.isSafeInteger(timeout) ||
      timeout < 30 ||
      timeout > 86400)
  )
    throw new Error(
      "config.lifecycle.openIdleTimeoutSeconds must be null or an integer from 30 to 86400.",
    );
  const raw =
    value === undefined || value === null
      ? null
      : assertPlainObject(value, "config.application.activity");
  if (raw) assertKnownKeys(raw, ["url"], "config.application.activity");
  const activity =
    !raw || raw.url === null
      ? null
      : Object.freeze({
          url: validateApplicationActivityUrl(raw.url, readinessUrl),
        });
  if (
    timeout !== null &&
    (openPersistence !== "stop-on-application-exit" || !activity)
  )
    throw new Error(
      "Foreground idle shutdown requires application.activity, readiness, and lifecycle.open = stop-on-application-exit. No inactivity is inferred automatically.",
    );
  return Object.freeze({
    activity,
    openIdleTimeoutSeconds: timeout as number | null,
  });
};
