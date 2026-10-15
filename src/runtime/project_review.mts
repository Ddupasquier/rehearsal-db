/** Public, value-free summaries for editor baseline/privacy and authentication review. */

import type { BaselineManifest } from "../baseline/artifact.mjs";
import {
  normalizeSanitizationAction,
  type RuntimeSanitizationPolicy,
} from "../baseline/sanitization_policy.mjs";

export const buildBaselineScopeReview = ({
  baseline,
  policy,
  provider,
  sourcePreparationConfigured,
  identityPolicyConfigured,
}: {
  baseline: BaselineManifest;
  policy: RuntimeSanitizationPolicy;
  provider: "postgresql" | "supabase";
  sourcePreparationConfigured: boolean;
  identityPolicyConfigured: boolean;
}) => {
  if (policy.tables.length > 10_000)
    throw new Error("Baseline review exceeds its bounded table limit.");
  const tables = policy.tables.map((table) => {
    const schema = table.schema ?? "public";
    const key = schema === "public" ? table.name : `${schema}.${table.name}`;
    const transformations = {
      KEEP: 0,
      PSEUDONYMIZE: 0,
      REPLACE: 0,
      EXCLUDE: 0,
      DERIVE: 0,
    };
    let relationshipCount = 0;
    let identityColumnCount = 0;
    for (const column of table.columns) {
      transformations[normalizeSanitizationAction(column.action)] += 1;
      if (column.foreignKey) relationshipCount += 1;
      if (column.identity === "YES") identityColumnCount += 1;
    }
    return {
      schema,
      name: table.name,
      included: table.sourceRows !== "EXCLUDE",
      rowCount: baseline.tableCounts[key] ?? 0,
      columnCount: table.columns.length,
      relationshipCount,
      identityColumnCount,
      transformations,
    };
  });
  const excludedKeys = new Set(
    tables
      .filter((table) => !table.included)
      .map((table) => `${table.schema}.${table.name}`),
  );
  let excludedReferenceCount = 0;
  for (const table of policy.tables) {
    if (table.sourceRows === "EXCLUDE") continue;
    for (const column of table.columns) {
      const reference = column.foreignKey;
      if (
        reference &&
        excludedKeys.has(`${reference.schema}.${reference.table}`)
      )
        excludedReferenceCount += 1;
    }
  }
  const bucketMap = new Map<
    string,
    { name: string; assetCount: number; bytes: number }
  >();
  for (const asset of Object.values(baseline.storageAssets)) {
    const bucket = bucketMap.get(asset.bucket) ?? {
      name: asset.bucket,
      assetCount: 0,
      bytes: 0,
    };
    bucket.assetCount += 1;
    bucket.bytes += asset.bytes;
    bucketMap.set(asset.bucket, bucket);
  }
  const buckets = [...bucketMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  );
  return {
    schemaVersion: 1 as const,
    provider,
    policy: {
      version: policy.policyVersion,
      sha256: baseline.sanitizationPolicySha256,
      state: "baseline-bound" as const,
    },
    tables,
    relationships: {
      declaredCount: tables.reduce(
        (total, table) => total + table.relationshipCount,
        0,
      ),
      excludedReferenceCount,
      verification: "declared-not-runtime-verified" as const,
    },
    storage: {
      assetCount: buckets.reduce(
        (total, bucket) => total + bucket.assetCount,
        0,
      ),
      bytes: buckets.reduce((total, bucket) => total + bucket.bytes, 0),
      buckets,
    },
    decisions: {
      sourcePermission: sourcePreparationConfigured
        ? ("configured-not-contacted" as const)
        : ("local-inputs-only" as const),
      identityHandling: identityPolicyConfigured
        ? ("reviewed-policy-configured" as const)
        : ("no-association-policy" as const),
      replacement: "separate-core-confirmation" as const,
    },
    privacy: {
      rowValuesIncluded: false as const,
      credentialsIncluded: false as const,
      sourceContacted: false as const,
    },
  };
};

/** Read only public boolean declarations; never return credential or arbitrary TOML values. */
export const publicAuthenticationBooleans = (source: string | null) => {
  const result = new Map<string, boolean | null>();
  if (source === null || Buffer.byteLength(source) > 512 * 1024) return result;
  let section = "";
  let multiline: "'''" | '\"\"\"' | null = null;
  const sections = new Set<string>();
  for (const line of source.split("\n")) {
    if (multiline) {
      if (line.includes(multiline)) multiline = null;
      continue;
    }
    const block = line.match(/(?:=|^)\s*('''|""")/u);
    if (block) {
      const delimiter = block[1] as "'''" | '\"\"\"';
      if (!line.slice((block.index ?? 0) + block[0].length).includes(delimiter))
        multiline = delimiter;
      continue;
    }
    const heading = /^\s*\[([a-z][a-z0-9_.-]*)\]\s*(?:#.*)?$/u.exec(line);
    if (heading) {
      section = heading[1]!;
      if (sections.has(section)) {
        for (const key of result.keys())
          if (key.startsWith(`${section}.`)) result.set(key, null);
        section = "";
      } else sections.add(section);
      continue;
    }
    if (
      section !== "auth.email" &&
      section !== "auth.mfa.totp" &&
      !/^auth\.external\.[a-z][a-z0-9_-]{0,62}$/u.test(section)
    )
      continue;
    const assignment = /^\s*(enabled|enroll_enabled|verify_enabled)\s*=/u.exec(
      line,
    );
    if (!assignment) continue;
    const key = `${section}.${assignment[1]}`;
    const setting =
      /^\s*(?:enabled|enroll_enabled|verify_enabled)\s*=\s*(true|false)\s*(?:#.*)?$/u.exec(
        line,
      );
    result.set(key, result.has(key) || !setting ? null : setting[1] === "true");
  }
  return result;
};

export const buildAuthenticationReview = ({
  provider,
  configuredProviders,
  declarativeProviders,
  callback,
  template,
  identityPolicyConfigured,
}: {
  provider: "postgresql" | "supabase";
  configuredProviders: readonly string[];
  declarativeProviders: readonly string[];
  callback: string | null;
  template: string | null;
  identityPolicyConfigured: boolean;
}) => {
  const booleans = publicAuthenticationBooleans(template);
  const discovered = [...booleans.keys()].flatMap((key) => {
    const match = /^auth\.external\.([a-z][a-z0-9_-]{0,62})\.enabled$/u.exec(
      key,
    );
    return match ? [match[1]!] : [];
  });
  const names = [
    ...new Set([
      "email",
      "google",
      "github",
      ...configuredProviders,
      ...discovered,
    ]),
  ]
    .filter((name) => /^[a-z][a-z0-9_-]{0,62}$/u.test(name))
    .sort();
  return {
    schemaVersion: 1 as const,
    target: provider,
    providers:
      provider === "postgresql"
        ? []
        : names.map((name) => {
            const declared = declarativeProviders.includes(name);
            const enabled = declared
              ? true
              : (booleans.get(
                  name === "email"
                    ? "auth.email.enabled"
                    : `auth.external.${name}.enabled`,
                ) ?? null);
            return {
              name,
              enabled,
              source: declared
                ? ("declarative" as const)
                : enabled === null
                  ? ("unavailable" as const)
                  : ("template" as const),
              supported: ["email", "google", "github"].includes(name),
            };
          }),
    callback,
    identityAssociation: identityPolicyConfigured
      ? ("reviewed-policy-configured" as const)
      : ("not-configured" as const),
    mfa: {
      totpEnrollment: booleans.get("auth.mfa.totp.enroll_enabled") ?? null,
      totpVerification: booleans.get("auth.mfa.totp.verify_enabled") ?? null,
      enforcement: "application-owned-not-verified" as const,
    },
    verification: "configuration-only" as const,
    privacy: {
      credentialsIncluded: false as const,
      environmentFilesRead: false as const,
      authenticationAttempted: false as const,
    },
  };
};
