/** Public configuration types, format version, and stable defaults. */

export type RehearsalConfigVersion = 1;

export interface RehearsalConfig {
  schemaVersion: RehearsalConfigVersion;
  project: { name: string };
  supabase?: {
    workdir: string;
    migrationDirectory: string;
    rehearsalConfig: string;
    runtimeWorkdir: string;
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
  containerRuntime?: { autoStartColima?: boolean };
  cleanup?: { retainBaselineGenerations?: number };
  preparation?: {
    sourcePolicy: string;
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
    startCommand: string;
    proofCommand: string;
    environmentFile?: string;
    environmentVariables?: Record<string, string>;
    readiness?: {
      url: string;
      expectedStatus: number;
      timeoutSeconds?: number;
    };
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
    target?: "supabase" | "postgresql";
    applicationUrl?: string;
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
  containerRuntime: Object.freeze({ autoStartColima: false }),
  cleanup: Object.freeze({ retainBaselineGenerations: 2 }),
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
