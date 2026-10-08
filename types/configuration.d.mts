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
  containerRuntime?: {
    autoStartColima?: boolean;
  };
  cleanup?: {
    retainBaselineGenerations?: number;
  };
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

export declare const REHEARSAL_CONFIG_VERSION: 1;
export declare const defineRehearsalConfig: <
  const Config extends RehearsalConfig,
>(
  config: Config,
) => Config;
export declare const loadRehearsalConfig: (options?: {
  projectRoot?: string;
  configPath?: string;
}) => Promise<unknown>;
export declare const inspectDetectedProject: (options?: {
  projectRoot?: string;
}) => Promise<unknown>;
export declare const renderDetectedConfig: (
  detected: unknown,
  options?: {
    applicationUrl?: string;
    ports?: { api: number; database: number; studio: number };
  },
) => string;
export declare const renderDetectedPostgresqlConfig: (
  detected: unknown,
  options?: {
    applicationUrl?: string;
    databasePort?: number;
  },
) => string;
export declare const SANITIZATION_ACTIONS: Readonly<{
  KEEP: "KEEP";
  PSEUDONYMIZE: "PSEUDONYMIZE";
  REPLACE: "REPLACE";
  EXCLUDE: "EXCLUDE";
  DERIVE: "DERIVE";
}>;
export declare const EXCLUDED_VALUE: unique symbol;
export declare const normalizeSanitizationAction: (
  action: string,
) => "KEEP" | "PSEUDONYMIZE" | "REPLACE" | "EXCLUDE" | "DERIVE";
export declare const validateSanitizationCoverage: (options: {
  policy: { policyVersion?: unknown; tables: Array<Record<string, unknown>> };
  schemaTables: Array<{
    name: string;
    columns: Array<string | { name: string }>;
  }>;
}) => Readonly<{
  policyVersion: unknown;
  tableCount: number;
  columnCount: number;
  tables: ReadonlyArray<Record<string, unknown>>;
}>;
export declare const validateRuntimeSanitizationPolicy: (
  policy: unknown,
) => unknown;
export declare const readBoundRuntimeSanitizationPolicy: (options: {
  bytes: Uint8Array | string;
  expectedSha256: string;
}) => unknown;
export declare const applySanitizationAction: (options: {
  action: string;
  value: unknown;
  replace?: (value: unknown, context: Record<string, unknown>) => unknown;
  pseudonymize?: (value: unknown, context: Record<string, unknown>) => unknown;
  derive?: (value: unknown, context: Record<string, unknown>) => unknown;
  context?: Record<string, unknown>;
}) => unknown | typeof EXCLUDED_VALUE;
