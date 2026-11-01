/**
 * Versioned public contract and constructors for read-only project discovery.
 * Keep this module free of file-system and process access.
 */

export const PROJECT_DISCOVERY_SCHEMA_VERSION = 1 as const;

export type DiscoveryConfidence = "high" | "medium" | "low";
export type DiscoveryValue = string | number | boolean | readonly string[];

export interface DiscoveryEvidence {
  readonly kind: "file" | "manifest" | "script" | "runtime_probe";
  readonly source: string;
  readonly detail: string;
}

interface DiscoveryItemBase {
  readonly id: string;
  readonly label: string;
  readonly value: DiscoveryValue;
  readonly evidence: readonly DiscoveryEvidence[];
}

export interface DetectedDiscoveryItem extends DiscoveryItemBase {
  readonly category: "detected";
}

export interface SuggestedDiscoveryItem extends DiscoveryItemBase {
  readonly category: "suggested";
  readonly confidence: DiscoveryConfidence;
  readonly configPath?: string;
  readonly review: string;
}

export interface DecisionDiscoveryItem extends DiscoveryItemBase {
  readonly category: "decision";
  readonly configPath?: string;
  readonly question: string;
  readonly reason: string;
}

export interface DiscoveredConfigurationField {
  readonly path: string;
  readonly status:
    "present_unvalidated" | "suggested" | "decision_required" | "not_detected";
  readonly value?: DiscoveryValue;
  readonly sourceItemIds: readonly string[];
}

export interface ProjectDiscoveryResult {
  readonly schemaVersion: typeof PROJECT_DISCOVERY_SCHEMA_VERSION;
  readonly containerEngines?: import("../runtime/engines/engine_discovery.mjs").ContainerEngineDiscovery;
  readonly project: {
    readonly name: string;
    readonly packageManifest: "present" | "missing";
  };
  readonly detected: readonly DetectedDiscoveryItem[];
  readonly suggested: readonly SuggestedDiscoveryItem[];
  readonly decisions: readonly DecisionDiscoveryItem[];
  readonly configuration: {
    readonly state: "missing" | "present_unvalidated" | "ambiguous";
    readonly activePath: string | null;
    readonly discoveredPaths: readonly string[];
    readonly fields: readonly DiscoveredConfigurationField[];
  };
  readonly safety: {
    readonly projectCodeExecuted: false;
    readonly environmentFilesRead: false;
    readonly databaseContacted: false;
    readonly containerEngineStarted: false;
  };
}

export type ContainerEngineProbe = () => Promise<
  "running" | "stopped" | "unavailable"
>;

export interface PackageManifest {
  readonly name?: unknown;
  readonly packageManager?: unknown;
  readonly engines?: unknown;
  readonly scripts?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const recordStrings = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

export const detected = (
  id: string,
  label: string,
  value: DiscoveryValue,
  evidence: readonly DiscoveryEvidence[],
): DetectedDiscoveryItem => ({
  category: "detected",
  id,
  label,
  value,
  evidence,
});

export const suggested = (
  id: string,
  label: string,
  value: DiscoveryValue,
  confidence: DiscoveryConfidence,
  review: string,
  evidence: readonly DiscoveryEvidence[],
  configPath?: string,
): SuggestedDiscoveryItem => ({
  category: "suggested",
  id,
  label,
  value,
  confidence,
  review,
  evidence,
  ...(configPath ? { configPath } : {}),
});

export const decision = (
  id: string,
  label: string,
  value: DiscoveryValue,
  question: string,
  reason: string,
  evidence: readonly DiscoveryEvidence[] = [],
  configPath?: string,
): DecisionDiscoveryItem => ({
  category: "decision",
  id,
  label,
  value,
  question,
  reason,
  evidence,
  ...(configPath ? { configPath } : {}),
});

export const packageManagerFromManifest = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = /^(npm|pnpm|yarn)(?:@|$)/u.exec(value.trim());
  return match?.[1] ?? null;
};

export const packageManagerInvocation = (
  manager: string,
  script: string,
): string =>
  manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
