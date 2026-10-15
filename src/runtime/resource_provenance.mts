/** Bounded, non-secret projections of target-local runtime receipts. No runtime is contacted. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { REHEARSAL_VERSION } from "../shared/diagnostics.mjs";

export interface EnvironmentProvenance {
  readonly schemaVersion: 1;
  readonly inspectorVersion: string;
  readonly verification: "recorded-not-reverified";
  readonly configuredPorts: readonly {
    readonly service: "application" | "api" | "database" | "studio";
    readonly host: "localhost" | "127.0.0.1" | "[::1]";
    readonly port: number;
  }[];
  readonly runtime: {
    readonly rehearsalVersion: string | null;
    readonly versionReason: "not-recorded" | null;
    readonly baselineGenerationId: string;
    readonly baselineDataSha256: string;
    readonly candidateSha256: string | null;
    readonly migrationReason:
      "receipt-unavailable" | "receipt-does-not-match-baseline" | null;
  } | null;
  readonly runtimeReason: "receipt-unavailable" | "receipt-invalid" | null;
}

const MAXIMUM_RECEIPT_BYTES = 64 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const GENERATION = /^\d{8}T\d{6}Z-[a-f0-9]{12}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** Refuse escaping/symlinked receipts and unbounded JSON; never return raw input. */
const readReceipt = async (
  projectRoot: string,
  path: string,
): Promise<unknown> => {
  const lexicalRoot = resolve(projectRoot);
  const lexicalParent = resolve(dirname(path));
  if (!inside(lexicalRoot, lexicalParent))
    throw new Error("Runtime receipt path escapes its project.");
  const root = await realpath(projectRoot);
  const parent = await realpath(dirname(path));
  if (
    !inside(root, parent) ||
    parent !== resolve(root, relative(lexicalRoot, lexicalParent))
  )
    throw new Error("Runtime receipt path is not an owned local directory.");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAXIMUM_RECEIPT_BYTES)
      throw new Error("Runtime receipt is not a bounded regular file.");
    const bytes = Buffer.alloc(MAXIMUM_RECEIPT_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAXIMUM_RECEIPT_BYTES)
      throw new Error("Runtime receipt exceeds its bound.");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
};

export const inspectEnvironmentProvenanceEvidence = async ({
  projectRoot,
  runtimeWorkdir,
  provider,
  ports,
  applicationUrl,
}: {
  readonly projectRoot: string;
  readonly runtimeWorkdir: string;
  readonly provider: "supabase" | "postgresql";
  readonly ports: Readonly<Record<string, number | undefined>>;
  readonly applicationUrl: string;
}): Promise<{
  readonly provenance: EnvironmentProvenance;
  readonly providerRecorded: boolean;
}> => {
  // These endpoints come from validated configuration, not Docker environment data.
  const configuredPorts: EnvironmentProvenance["configuredPorts"][number][] =
    [];
  for (const service of ["api", "database", "studio"] as const) {
    const port = ports[service];
    if (Number.isSafeInteger(port) && port! >= 1024 && port! <= 65535)
      configuredPorts.push({ service, host: "127.0.0.1", port: port! });
  }
  try {
    const url = new URL(applicationUrl);
    const port = Number(url.port);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      Number.isSafeInteger(port) &&
      port >= 1024 &&
      port <= 65535
    )
      configuredPorts.push({
        service: "application",
        host: url.hostname as "localhost" | "127.0.0.1" | "[::1]",
        port,
      });
  } catch {
    // A caller outside normalized configuration cannot introduce an unsafe endpoint.
  }
  const base = {
    schemaVersion: 1 as const,
    inspectorVersion: REHEARSAL_VERSION,
    verification: "recorded-not-reverified" as const,
    configuredPorts,
  };
  let marker: unknown;
  try {
    marker = await readReceipt(
      projectRoot,
      join(runtimeWorkdir, "baseline.json"),
    );
  } catch {
    return {
      provenance: {
        ...base,
        runtime: null,
        runtimeReason: "receipt-unavailable",
      },
      providerRecorded: false,
    };
  }
  if (
    !record(marker) ||
    (marker.formatVersion !== 1 && marker.formatVersion !== 2) ||
    typeof marker.generationId !== "string" ||
    !GENERATION.test(marker.generationId) ||
    typeof marker.dataSha256 !== "string" ||
    !DIGEST.test(marker.dataSha256) ||
    (marker.target !== undefined && marker.target !== provider) ||
    (marker.rehearsalVersion !== undefined &&
      (typeof marker.rehearsalVersion !== "string" ||
        marker.rehearsalVersion.length > 100 ||
        !VERSION.test(marker.rehearsalVersion)))
  )
    return {
      provenance: { ...base, runtime: null, runtimeReason: "receipt-invalid" },
      providerRecorded: false,
    };
  let candidateSha256: string | null = null;
  let migrationReason:
    "receipt-unavailable" | "receipt-does-not-match-baseline" | null =
    "receipt-unavailable";
  try {
    const candidate = await readReceipt(
      projectRoot,
      join(runtimeWorkdir, "candidate-receipt.json"),
    );
    if (
      record(candidate) &&
      candidate.formatVersion === 1 &&
      candidate.target === provider &&
      candidate.baselineGenerationId === marker.generationId &&
      typeof candidate.candidateSha256 === "string" &&
      DIGEST.test(candidate.candidateSha256)
    ) {
      candidateSha256 = candidate.candidateSha256;
      migrationReason = null;
    } else migrationReason = "receipt-does-not-match-baseline";
  } catch {
    // Missing, unsafe, and unreadable metadata have the same bounded unavailable outcome.
  }
  return {
    provenance: {
      ...base,
      runtime: {
        rehearsalVersion:
          typeof marker.rehearsalVersion === "string"
            ? marker.rehearsalVersion
            : null,
        versionReason:
          marker.rehearsalVersion === undefined ? "not-recorded" : null,
        baselineGenerationId: marker.generationId,
        baselineDataSha256: marker.dataSha256,
        candidateSha256,
        migrationReason,
      },
      runtimeReason: null,
    },
    providerRecorded: marker.target === provider,
  };
};

/** Public inventory projection stays unchanged; provider evidence is private to classification. */
export const inspectEnvironmentProvenance = async (
  options: Parameters<typeof inspectEnvironmentProvenanceEvidence>[0],
): Promise<EnvironmentProvenance> =>
  (await inspectEnvironmentProvenanceEvidence(options)).provenance;
