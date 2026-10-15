/** Resource limits and proof dependencies, validated before any runtime starts. */

import type { ApplicationRequiredService } from "./configuration_contract.mjs";
import {
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
