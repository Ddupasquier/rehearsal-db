/** Public configuration types, format version, and stable defaults. */

export type RehearsalConfigVersion = 1;

export type RunPersistenceMode =
  "keep-until-stop" | "stop-after-run" | "discard-after-run";
export type OpenPersistenceMode =
  | "keep-until-stop"
  | "stop-on-application-exit"
  | "discard-on-application-exit";

export type ApplicationRequiredService =
  | "database"
  | "auth"
  | "storage"
  | "postgrest"
  | "gateway"
  | "mail"
  | "studio"
  | "realtime"
  | "edge-functions"
  | "analytics"
  | "image-transforms";

export interface RehearsalResourcePolicy {
  /** Optional verified local restore stream cache; never reuses an unverified target. */
  restoreCache?: {
    enabled: boolean;
    maximumBytes?: number;
    minimumFreeBytes?: number;
  };
  /** Opt-in measured memory/container headroom, rechecked under the shared lifecycle lease. */
  capacityAdmission?: {
    enabled: boolean;
    hostReserveBytes?: number;
    engineReserveBytes?: number;
    maximumRunningContainers?: number;
    targetMemoryBytes?: {
      postgresql: number;
      supabaseApplication: number;
      supabaseFull: number;
    };
  };
  /** Cooperatively serialize participating local runtime lifecycle phases. */
  workloadQueue?: { enabled: boolean; waitTimeoutSeconds?: number };
  /** Review cutoff based on container start/stop, not application or database use. */
  staleAfterSeconds?: number | null;
  /** Advisory limit; retained databases are never automatically deleted. */
  retainedEnvironmentCount?: number;
  /** Hard limit on measured owned volume bytes; unknown measurements refuse startup. */
  maximumBytes?: number | null;
  /** Offer a due preview on inspection; never installs a timer or deletes data. */
  cleanupSchedule?: "manual" | "daily-preview" | "weekly-preview";
}

export interface RehearsalConfig {
  schemaVersion: RehearsalConfigVersion;
  project: { name: string };
  supabase?: {
    workdir: string;
    migrationDirectory: string;
    rehearsalConfig: string;
    runtimeWorkdir: string;
    serviceProfile?: "application" | "full";
    authentication?: {
      enableLocalSignup: true;
      environmentFile: string;
      providers: Array<{
        name: "google" | "github";
        clientIdEnvironmentVariable: string;
        clientSecretEnvironmentVariable: string;
        skipNonceCheck?: boolean;
        emailOptional?: boolean;
      }>;
    };
    serviceEnvironmentFile?: string;
    serviceEnvironmentVariables?: string[];
  };
  postgresql?: {
    migrationDirectory: string;
    runtimeWorkdir?: string;
    image?: string;
    database?: string;
    user?: string;
  };
  baseline: {
    artifactDirectory?: string;
    sanitizationPolicy: string;
  };
  containerRuntime?: {
    autoStartColima?: boolean;
    stopOwnedColimaWhenIdle?: boolean;
    diskWarningPercent?: number;
    minimumFreeBytes?: number;
  };
  lifecycle?: {
    run?: RunPersistenceMode;
    open?: OpenPersistenceMode;
    /** Foreground open only; requires explicit application activity and a stop/discard-on-application-exit mode. */
    openIdleTimeoutSeconds?: number | null;
  };
  cleanup?: { retainBaselineGenerations?: number };
  resources?: RehearsalResourcePolicy;
  /** Reviewed subsets of configured targets; selection itself is read-only. */
  profiles?: Array<{
    name: string;
    targets: string[];
    applicationUrl?: string;
  }>;
  preparation?: {
    sourcePolicy: string;
    /** Optional reviewed sampling and fidelity policy; omission keeps full extraction. */
    shapePolicy?: string;
    privacyKey: string;
    batchRows?: number;
    maximumRows?: number;
    maximumBytes?: number;
    diskHeadroomBytes?: number;
  };
  runtimePolicy?: string;
  identityPolicy?: string;
  dependentTargets?: Array<{
    name: string;
    configPath: string;
    prepareCommand?: string;
  }>;
  application: {
    /** Declare proof dependencies so excluded services fail before startup. */
    requiredServices?: ApplicationRequiredService[];
    startCommand: string;
    proofCommand: string;
    environmentFile?: string;
    environmentVariables?: Record<string, string>;
    readiness?: {
      url: string;
      expectedStatus: number;
      timeoutSeconds?: number;
    };
    /** An application-owned schema-1 busy/sequence route on the readiness origin. */
    activity?: { url: string | null } | null;
    httpProofs?: Array<{
      name: string;
      kind: "positive" | "negative";
      url: string;
      method?: string;
      expectedStatus: number;
      json?: {
        path: string[];
        equals?: unknown;
        notEquals?: unknown;
        minimumItems?: number;
      };
    }>;
    runtimeAdapter?: string;
  };
  runtime: {
    /** Friendly label only; never changes Docker ownership or the project ID. */
    displayName?: string;
    /** Refuse reset, run, migrate, and discard until explicitly unprotected. */
    protected?: boolean;
    target?: "supabase" | "postgresql";
    applicationUrl?: string;
    /** Exact lowercase/digit/hyphen ownership ID: 2–40 Supabase, 2–63 PostgreSQL. */
    projectId?: string;
    apiPort?: number;
    databasePort: number;
    studioPort?: number;
  };
  safety?: {
    allowedHosts?: string[];
    blockedEnvironmentVariables?: string[];
    authenticationProviders?: string[];
    hostedAccess?: "disabled";
    outboundNetwork?: "deny";
  };
  verification?: { commands?: string[] };
}

export const REHEARSAL_CONFIG_VERSION = 1;

export const REHEARSAL_DEFAULTS = Object.freeze({
  baseline: Object.freeze({ artifactDirectory: ".rehearsal" }),
  containerRuntime: Object.freeze({
    autoStartColima: false,
    stopOwnedColimaWhenIdle: false,
    diskWarningPercent: 80,
    minimumFreeBytes: 2 * 1024 * 1024 * 1024,
    supabaseMinimumFreeBytes: 8 * 1024 * 1024 * 1024,
  }),
  lifecycle: Object.freeze({
    run: "stop-after-run" as RunPersistenceMode,
    open: "stop-on-application-exit" as OpenPersistenceMode,
    openIdleTimeoutSeconds: null,
  }),
  cleanup: Object.freeze({ retainBaselineGenerations: 2 }),
  resources: Object.freeze({
    staleAfterSeconds: null,
    retainedEnvironmentCount: 2,
    maximumBytes: null,
    cleanupSchedule: "manual",
  }),
  runtime: Object.freeze({
    applicationUrl: "http://localhost:5175",
    projectId: "rehearsal-local",
  }),
  safety: Object.freeze({
    allowedHosts: Object.freeze(["127.0.0.1", "::1", "localhost"]),
    blockedEnvironmentVariables: Object.freeze([
      "DATABASE_URL",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
      "PGUSER",
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_DB_PASSWORD",
      "SUPABASE_PROJECT_ID",
    ]),
    hostedAccess: "disabled",
    outboundNetwork: "deny",
  }),
});

export const defineRehearsalConfig = <const Config extends RehearsalConfig>(
  config: Config,
): Config => config;
