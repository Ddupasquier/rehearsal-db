/** Resource limits and proof dependencies, validated before any runtime starts. */

import type { ApplicationRequiredService } from "./configuration_contract.mjs";
import {
  assertKnownKeys,
  assertPlainObject,
  assertPositiveInteger,
  type PlainObject,
} from "./configuration_validation.mjs";

export const APPLICATION_REQUIRED_SERVICES = Object.freeze([
  "database",
  "auth",
  "storage",
  "postgrest",
  "gateway",
  "mail",
  "studio",
  "realtime",
  "edge-functions",
  "analytics",
  "image-transforms",
] as const satisfies readonly ApplicationRequiredService[]);

const FULL_PROFILE_ONLY = new Set<ApplicationRequiredService>([
  "studio",
  "realtime",
  "edge-functions",
  "analytics",
  "image-transforms",
]);

const nullablePositiveInteger = (
  value: unknown,
  path: string,
): number | null => {
  if (value === null || value === undefined) return null;
  const normalized = assertPositiveInteger(value, path);
  if (!Number.isSafeInteger(normalized))
    throw new Error(`${path} must be a safe integer.`);
  return normalized;
};

export const normalizeResourcePolicy = (resources: PlainObject) => {
  let workloadQueue:
    { enabled: boolean; waitTimeoutSeconds: number } | undefined;
  if (resources.workloadQueue !== undefined) {
    const path = "config.resources.workloadQueue";
    const value = assertPlainObject(resources.workloadQueue, path);
    assertKnownKeys(value, ["enabled", "waitTimeoutSeconds"], path);
    if (typeof value.enabled !== "boolean")
      throw new Error(`${path}.enabled must be a boolean.`);
    const waitTimeoutSeconds =
      value.waitTimeoutSeconds === undefined ? 30 : value.waitTimeoutSeconds;
    if (
      !Number.isInteger(waitTimeoutSeconds) ||
      typeof waitTimeoutSeconds !== "number" ||
      waitTimeoutSeconds < 0 ||
      waitTimeoutSeconds > 300
    )
      throw new Error(
        `${path}.waitTimeoutSeconds must be an integer from 0 to 300.`,
      );
    workloadQueue = Object.freeze({
      enabled: value.enabled,
      waitTimeoutSeconds,
    });
  }
  const schedule = resources.cleanupSchedule ?? "manual";
  if (
    typeof schedule !== "string" ||
    !["manual", "daily-preview", "weekly-preview"].includes(schedule)
  ) {
    throw new Error(
      "config.resources.cleanupSchedule must be manual, daily-preview, or weekly-preview.",
    );
  }
  const retainedEnvironmentCount = assertPositiveInteger(
    resources.retainedEnvironmentCount ?? 2,
    "config.resources.retainedEnvironmentCount",
  );
  if (retainedEnvironmentCount > 1000) {
    throw new Error(
      "config.resources.retainedEnvironmentCount must be at most 1000.",
    );
  }
  return Object.freeze({
    ...(workloadQueue === undefined ? {} : { workloadQueue }),
    staleAfterSeconds: nullablePositiveInteger(
      resources.staleAfterSeconds,
      "config.resources.staleAfterSeconds",
    ),
    retainedEnvironmentCount,
    maximumBytes: nullablePositiveInteger(
      resources.maximumBytes,
      "config.resources.maximumBytes",
    ),
    cleanupSchedule: schedule as "manual" | "daily-preview" | "weekly-preview",
  });
};

export const normalizeRequiredServices = ({
  value = [],
  target,
  serviceProfile,
}: {
  readonly value?: unknown;
  readonly target: "postgresql" | "supabase";
  readonly serviceProfile: unknown;
}): readonly ApplicationRequiredService[] => {
  if (
    !Array.isArray(value) ||
    value.some(
      (service) =>
        typeof service !== "string" ||
        !APPLICATION_REQUIRED_SERVICES.includes(
          service as ApplicationRequiredService,
        ),
    )
  ) {
    throw new Error(
      `config.application.requiredServices must contain only: ${APPLICATION_REQUIRED_SERVICES.join(", ")}.`,
    );
  }
  const services = value as ApplicationRequiredService[];
  if (new Set(services).size !== services.length) {
    throw new Error(
      "config.application.requiredServices must not contain duplicates.",
    );
  }
  const excluded = services.filter((service) =>
    target === "postgresql"
      ? service !== "database"
      : serviceProfile !== "full" && FULL_PROFILE_ONLY.has(service),
  );
  if (excluded.length) {
    throw new Error(
      `The ${target === "postgresql" ? "PostgreSQL target" : "Supabase application service profile"} excludes required application services: ${excluded.join(", ")}. Review the target/profile before starting; no services were started.`,
    );
  }
  return Object.freeze([...services]);
};
