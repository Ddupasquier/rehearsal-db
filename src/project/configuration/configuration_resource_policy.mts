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
  let capacityAdmission:
    | Readonly<{ enabled: false }>
    | Readonly<{
        enabled: true;
        hostReserveBytes: number;
        engineReserveBytes: number;
        maximumRunningContainers: number;
        targetMemoryBytes: Readonly<{
          postgresql: number;
          supabaseApplication: number;
          supabaseFull: number;
        }>;
      }>
    | undefined;
  if (resources.capacityAdmission !== undefined) {
    const path = "config.resources.capacityAdmission";
    const value = assertPlainObject(resources.capacityAdmission, path);
    assertKnownKeys(
      value,
      [
        "enabled",
        "hostReserveBytes",
        "engineReserveBytes",
        "maximumRunningContainers",
        "targetMemoryBytes",
      ],
      path,
    );
    if (typeof value.enabled !== "boolean")
      throw new Error(`${path}.enabled must be a boolean.`);
    const budget = (input: unknown, label: string) => {
      const result = assertPositiveInteger(input, label);
      if (!Number.isSafeInteger(result))
        throw new Error(`${label} must be a safe integer.`);
      return result;
    };
    if (!value.enabled) {
      if (Object.keys(value).some((key) => key !== "enabled"))
        throw new Error(`${path}: remove budgets when disabling admission.`);
      capacityAdmission = Object.freeze({ enabled: false });
    } else {
      if (!workloadQueue?.enabled)
        throw new Error(
          `${path} requires the shared workloadQueue to be enabled.`,
        );
      const memory = assertPlainObject(
        value.targetMemoryBytes,
        `${path}.targetMemoryBytes`,
      );
      assertKnownKeys(
        memory,
        ["postgresql", "supabaseApplication", "supabaseFull"],
        `${path}.targetMemoryBytes`,
      );
      const maximumRunningContainers = budget(
        value.maximumRunningContainers,
        `${path}.maximumRunningContainers`,
      );
      if (maximumRunningContainers > 1024)
        throw new Error(
          `${path}.maximumRunningContainers must be at most 1024.`,
        );
      capacityAdmission = Object.freeze({
        enabled: true,
        hostReserveBytes: budget(
          value.hostReserveBytes,
          `${path}.hostReserveBytes`,
        ),
        engineReserveBytes: budget(
          value.engineReserveBytes,
          `${path}.engineReserveBytes`,
        ),
        maximumRunningContainers,
        targetMemoryBytes: Object.freeze({
          postgresql: budget(
            memory.postgresql,
            `${path}.targetMemoryBytes.postgresql`,
          ),
          supabaseApplication: budget(
            memory.supabaseApplication,
            `${path}.targetMemoryBytes.supabaseApplication`,
          ),
          supabaseFull: budget(
            memory.supabaseFull,
            `${path}.targetMemoryBytes.supabaseFull`,
          ),
        }),
      });
    }
  }
  const schedule = resources.cleanupSchedule ?? "manual";
  let restoreCache:
    | Readonly<{ enabled: false }>
    | Readonly<{
        enabled: true;
        maximumBytes: number;
        minimumFreeBytes: number;
      }>
    | undefined;
  if (resources.restoreCache !== undefined) {
    const path = "config.resources.restoreCache";
    const value = assertPlainObject(resources.restoreCache, path);
    assertKnownKeys(
      value,
      ["enabled", "maximumBytes", "minimumFreeBytes"],
      path,
    );
    if (typeof value.enabled !== "boolean")
      throw new Error(`${path}.enabled must be a boolean.`);
    if (!value.enabled) {
      if (Object.keys(value).some((key) => key !== "enabled"))
        throw new Error(`${path}: remove budgets when disabling the cache.`);
      restoreCache = Object.freeze({ enabled: false });
    } else {
      const maximumBytes = assertPositiveInteger(
        value.maximumBytes,
        `${path}.maximumBytes`,
      );
      const minimumFreeBytes = assertPositiveInteger(
        value.minimumFreeBytes,
        `${path}.minimumFreeBytes`,
      );
      if (
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes > 536870912 ||
        !Number.isSafeInteger(minimumFreeBytes)
      )
        throw new Error(
          `${path} requires safe-integer budgets and maximumBytes of at most 536870912.`,
        );
      restoreCache = Object.freeze({
        enabled: true,
        maximumBytes,
        minimumFreeBytes,
      });
    }
  }
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
    ...(capacityAdmission === undefined ? {} : { capacityAdmission }),
    ...(restoreCache === undefined ? {} : { restoreCache }),
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
