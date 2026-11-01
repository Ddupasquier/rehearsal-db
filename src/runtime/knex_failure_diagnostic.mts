/** Closed host-owned failure evidence; never authorization or provider diagnostics. */
export const KNEX_FAILURE_PHASES = [
  "preparation",
  "worker",
  "restore",
  "verify",
  "application",
  "application_query",
  "lifecycle",
  "unknown",
] as const;
export const KNEX_FAILURE_STAGES = [
  "role",
  "native",
  "worker",
  "admission",
  "nested-binding",
  "sql-binding-or-result",
  "identity",
  "receipt",
  "application-credential",
  "inactive-role",
  "parameter-before",
  "effective-privileges",
  "parameter-granted",
  "postcondition",
  "authentication",
  "sql",
  "input-binding",
  "input-copy",
  "toolchain",
  "worker-create",
  "worker-attach",
  "worker-protocol",
  "execution",
  "cleanup",
  "lifecycle",
  "invalid-phase",
] as const;
export const KNEX_FAILURE_REASONS = [
  "unclassified",
  "guard-refused",
  "deadline",
  "execution-unconfirmed",
  "cleanup-unconfirmed",
] as const;
export type KnexFailureStage = (typeof KNEX_FAILURE_STAGES)[number];
export type KnexFailurePoint = Readonly<{
  phase: (typeof KNEX_FAILURE_PHASES)[number];
  stage: (typeof KNEX_FAILURE_STAGES)[number];
  reason: (typeof KNEX_FAILURE_REASONS)[number];
}>;
export interface KnexFailureDiagnostic {
  readonly schemaVersion: 1;
  readonly kind: "knex-native-failure";
  readonly primary: KnexFailurePoint;
  readonly cleanup: KnexFailurePoint | null;
}
const brands = new WeakMap<object, KnexFailurePoint>();
const inherited = new WeakMap<object, KnexFailureDiagnostic>();
const point = (value: unknown): KnexFailurePoint | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join(",") !== "phase,reason,stage" ||
    !KNEX_FAILURE_PHASES.some((x) => x === r.phase) ||
    !KNEX_FAILURE_STAGES.some((x) => x === r.stage) ||
    !KNEX_FAILURE_REASONS.some((x) => x === r.reason)
  )
    return null;
  return Object.freeze({
    phase: r.phase,
    stage: r.stage,
    reason: r.reason,
  }) as KnexFailurePoint;
};
const children = (error: object): readonly unknown[] => {
  if (!(error instanceof AggregateError)) return [];
  const d = Object.getOwnPropertyDescriptor(error, "errors");
  return d && "value" in d && Array.isArray(d.value) ? d.value : [];
};
/** Original aggregate entries precede cleanup wrappers; cycles/oversized trees refuse evidence. */
const walk = (error: unknown): object[] | null => {
  const seen = new Set<object>(),
    ordered: object[] = [];
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object") return true;
    if (seen.has(value) || depth > 8 || seen.size >= 32) return false;
    seen.add(value);
    const nested = children(value);
    if (nested.length > 32) return false;
    for (const child of nested) if (!visit(child, depth + 1)) return false;
    ordered.push(value);
    return true;
  };
  try {
    return visit(error, 0) ? ordered : null;
  } catch {
    return null;
  }
};
export const readKnexFailure = (
  error: unknown,
): KnexFailureDiagnostic | undefined => {
  const nodes = walk(error);
  if (!nodes) return undefined;
  let primary: KnexFailurePoint | undefined,
    cleanup: KnexFailurePoint | null = null;
  for (const node of nodes) {
    const previous = inherited.get(node);
    const p = previous?.primary ?? brands.get(node);
    if (p) {
      if (p.reason === "cleanup-unconfirmed") cleanup ??= p;
      else primary ??= p;
    }
    cleanup ??= previous?.cleanup ?? null;
    const own = brands.get(node);
    if (own?.reason === "cleanup-unconfirmed") cleanup ??= own;
  }
  primary ??= cleanup ?? undefined;
  return primary
    ? Object.freeze({
        schemaVersion: 1,
        kind: "knex-native-failure",
        primary,
        cleanup: cleanup === primary ? null : cleanup,
      })
    : undefined;
};
/** Returns the original thrown value, preserving error/exit behavior. */
export const markKnexFailure = <T,>(
  error: T,
  evidence: KnexFailurePoint,
): T => {
  const safe = point(evidence);
  if (safe && error && typeof error === "object" && !brands.has(error))
    brands.set(error, safe);
  return error;
};
export const preserveKnexFailure = <T,>(
  original: unknown,
  replacement: T,
): T => {
  const diagnostic = readKnexFailure(original);
  if (diagnostic && replacement && typeof replacement === "object")
    inherited.set(replacement, diagnostic);
  return replacement;
};
/** Mark the first original leaf only if no inner non-cleanup origin exists. */
export const markKnexFailureBoundary = <T,>(
  error: T,
  evidence: KnexFailurePoint,
): T => {
  try {
    const nodes = walk(error),
      existing = readKnexFailure(error);
    if (
      nodes &&
      (!existing || existing.primary.reason === "cleanup-unconfirmed")
    ) {
      const original = nodes.find(
        (node) =>
          children(node).length === 0 &&
          brands.get(node)?.reason !== "cleanup-unconfirmed",
      );
      if (original) markKnexFailure(original, evidence);
    }
  } catch {
    /* Diagnostics never replace the original thrown value. */
  }
  return error;
};
/** Boundary fallback never relabels an existing inner failure. */
export const atKnexFailureBoundary = <T,>(
  evidence: KnexFailurePoint | (() => KnexFailurePoint),
  task: () => T,
): T => {
  try {
    return task();
  } catch (error) {
    throw markKnexFailureBoundary(
      error,
      typeof evidence === "function" ? evidence() : evidence,
    );
  }
};
export const withKnexFailureBoundary = async <T,>(
  evidence: KnexFailurePoint | (() => KnexFailurePoint),
  task: () => Promise<T>,
): Promise<T> => {
  try {
    return await task();
  } catch (error) {
    throw markKnexFailureBoundary(
      error,
      typeof evidence === "function" ? evidence() : evidence,
    );
  }
};
const prefix = "Rehearsal native failure: ";
const noncePattern = /^[a-f0-9]{64}$/u;
const parse = (value: unknown): KnexFailureDiagnostic | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).sort().join(",") !== "cleanup,kind,primary,schemaVersion" ||
    r.schemaVersion !== 1 ||
    r.kind !== "knex-native-failure"
  )
    return null;
  const primary = point(r.primary),
    cleanup = r.cleanup === null ? null : point(r.cleanup);
  return primary &&
    (r.cleanup === null || cleanup?.reason === "cleanup-unconfirmed")
    ? { schemaVersion: 1, kind: "knex-native-failure", primary, cleanup }
    : null;
};
export const renderKnexFailureFrame = (
  error: unknown,
  nonce: unknown,
): string | undefined => {
  const nativeFailure = readKnexFailure(error);
  return typeof nonce === "string" && noncePattern.test(nonce) && nativeFailure
    ? prefix + JSON.stringify({ nonce, nativeFailure })
    : undefined;
};
/** Remove even invalid/foreign frames from user prose; trust exactly one matching closed frame. */
export const readKnexFailureFrame = (
  output: string,
  nonce: string,
): { output: string; nativeFailure?: KnexFailureDiagnostic } => {
  let count = 0,
    nativeFailure: KnexFailureDiagnostic | undefined;
  const cleaned = output.replace(
    /^Rehearsal native failure: [^\r\n]*(?:\r?\n|$)/gmu,
    (line) => {
      count++;
      if (line.length <= 2048 && noncePattern.test(nonce))
        try {
          const r = JSON.parse(line.slice(prefix.length));
          if (
            Object.keys(r).sort().join(",") === "nativeFailure,nonce" &&
            r.nonce === nonce
          )
            nativeFailure = parse(r.nativeFailure) ?? undefined;
        } catch {
          /* Unknown frame bytes never escape. */
        }
      return "";
    },
  );
  return {
    output: cleaned,
    ...(count === 1 && nativeFailure ? { nativeFailure } : {}),
  };
};
