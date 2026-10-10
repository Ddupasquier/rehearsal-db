/**
 * Purpose: Provide stable Rehearsal result, failure, redaction, and rendering
 * contracts for humans and automation. Do not run directly; this module is reusable
 * script infrastructure.
 */

import { createHash } from "node:crypto";
import packageManifest from "../../package.json" with { type: "json" };

export const REHEARSAL_RESULT_VERSION = 1;
export const REHEARSAL_VERSION = packageManifest.version;

export const REHEARSAL_EXIT_CODES = Object.freeze({
  success: 0,
  configuration_invalid: 2,
  unsafe_environment: 3,
  baseline_invalid: 4,
  baseline_checksum_mismatch: 5,
  migration_candidate_failure: 6,
  migration_verification_failure: 7,
  application_proof_failure: 8,
  runtime_dependency_failure: 9,
  internal_failure: 10,
  operation_cancelled: 130,
});

export type RehearsalErrorCategory = keyof typeof REHEARSAL_EXIT_CODES;
export type RehearsalStatus = "success" | "not_ready" | "error";

export interface RehearsalErrorOptions {
  category: RehearsalErrorCategory;
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  context?: unknown;
  refused?: string;
  suggestions?: readonly string[];
  cause?: unknown;
}

export interface RehearsalErrorOverrides {
  category?: RehearsalErrorCategory;
  code?: string;
  expected?: unknown;
  actual?: unknown;
  context?: unknown;
  refused?: string;
  suggestions?: readonly string[];
}

export interface RehearsalResultOptions<Data = unknown> {
  command: string;
  status: RehearsalStatus;
  data: Data;
  warnings?: readonly string[];
  startedAt?: Date;
  durationMs?: number;
}

export interface RehearsalResult<Data = unknown> {
  schemaVersion: number;
  rehearsalVersion: string;
  command: string;
  status: RehearsalStatus;
  startedAt: string;
  durationMs: number;
  warnings: readonly string[];
  data: Data;
}

export interface SerializedRehearsalError {
  schemaVersion: number;
  rehearsalVersion: string;
  status: "error";
  error: {
    category: RehearsalErrorCategory;
    code: string;
    message: string;
    expected: unknown;
    actual: unknown;
    context: unknown;
    refused: string | undefined;
    suggestions: readonly string[];
    diagnosticId: string;
    cause?: string;
  };
}

const SECRET_KEY_PATTERN =
  /(?:authorization|cookie|credential|database[_-]?url|jwt|key|password|secret|service[_-]?role|token)/iu;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const CONNECTION_STRING_PATTERN =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/giu;
const BEARER_PATTERN = /\bBearer\s+[^\s"']+/giu;
const SUPABASE_KEY_PATTERN = /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+\b/gu;

const redactString = (value: string): string =>
  value
    .replace(CONNECTION_STRING_PATTERN, "[REDACTED_CONNECTION_STRING]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(SUPABASE_KEY_PATTERN, "[REDACTED_KEY]");

export const redactDiagnosticValue = (value: unknown, key = ""): unknown => {
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactDiagnosticValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactDiagnosticValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
};

const diagnosticIdFor = ({
  category,
  code,
  message,
}: Pick<RehearsalErrorOptions, "category" | "code" | "message">): string =>
  createHash("sha256")
    .update(`${category}\0${code}\0${message}`)
    .digest("hex")
    .slice(0, 12);

export class RehearsalError extends Error {
  readonly category: RehearsalErrorCategory;
  readonly code: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly context: unknown;
  readonly refused: string | undefined;
  readonly suggestions: readonly string[];
  readonly diagnosticId: string;
  readonly exitCode: number;

  constructor({
    category,
    code,
    message,
    expected,
    actual,
    context,
    refused,
    suggestions = [],
    cause,
  }: RehearsalErrorOptions) {
    super(message, { cause });
    this.name = "RehearsalError";
    if (!Object.hasOwn(REHEARSAL_EXIT_CODES, category)) {
      throw new Error(`Unknown Rehearsal error category: ${category}.`);
    }
    this.category = category;
    this.code = code;
    this.expected = expected;
    this.actual = actual;
    this.context = context;
    this.refused = refused;
    this.suggestions = suggestions;
    this.diagnosticId = diagnosticIdFor({ category, code, message });
    this.exitCode = REHEARSAL_EXIT_CODES[category];
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const inferCategory = (error: unknown): RehearsalErrorCategory => {
  const message = errorMessage(error);
  if (/checksum/iu.test(message)) return "baseline_checksum_mismatch";
  if (
    /container\b.*\b(?:is not ready|starting|unhealthy)|health(?:check)?\b.*\b(?:failed|starting|unhealthy)|out of memory|\boom\b|no space left|resource temporarily unavailable/iu.test(
      message,
    )
  ) {
    return "runtime_dependency_failure";
  }
  if (/candidate|migration history diverges/iu.test(message)) {
    return "migration_candidate_failure";
  }
  if (/baseline|artifact|generation|sanitization policy/iu.test(message)) {
    return "baseline_invalid";
  }
  if (/migration|ledger|replay/iu.test(message)) {
    return "migration_verification_failure";
  }
  if (/config|unknown rehearsal|unsupported rehearsal/iu.test(message)) {
    return "configuration_invalid";
  }
  if (/loopback|hosted|unsafe|credential|outbound/iu.test(message)) {
    return "unsafe_environment";
  }
  if (
    /docker|postgres(?:ql)?|supabase|runtime|command|enoent|node\.js|ports?\b/iu.test(
      message,
    )
  ) {
    return "runtime_dependency_failure";
  }
  return "internal_failure";
};

export const normalizeRehearsalError = (
  error: unknown,
  overrides: RehearsalErrorOverrides = {},
): RehearsalError => {
  if (error instanceof RehearsalError) return error;
  const message = errorMessage(error);
  const category = overrides.category ?? inferCategory(error);
  return new RehearsalError({
    category,
    code: overrides.code ?? category.toUpperCase(),
    message,
    expected: overrides.expected,
    actual: overrides.actual,
    context: overrides.context,
    refused:
      overrides.refused ??
      "Rehearsal stopped before performing the requested operation.",
    suggestions: overrides.suggestions ?? [],
    cause: error,
  });
};

export const createRehearsalResult = ({
  command,
  status,
  data,
  warnings = [],
  startedAt = new Date(),
  durationMs = 0,
}: RehearsalResultOptions): RehearsalResult =>
  redactDiagnosticValue({
    schemaVersion: REHEARSAL_RESULT_VERSION,
    rehearsalVersion: REHEARSAL_VERSION,
    command,
    status,
    startedAt: startedAt.toISOString(),
    durationMs,
    warnings,
    data,
  }) as RehearsalResult;

export const serializeRehearsalError = (
  error: unknown,
  { debug = false }: { debug?: boolean } = {},
): SerializedRehearsalError => {
  const failure = normalizeRehearsalError(error);
  return redactDiagnosticValue({
    schemaVersion: REHEARSAL_RESULT_VERSION,
    rehearsalVersion: REHEARSAL_VERSION,
    status: "error",
    error: {
      category: failure.category,
      code: failure.code,
      message: failure.message,
      expected: failure.expected,
      actual: failure.actual,
      context: failure.context,
      refused: failure.refused,
      suggestions: failure.suggestions,
      diagnosticId: failure.diagnosticId,
      ...(debug && failure.cause ? { cause: errorMessage(failure.cause) } : {}),
    },
  }) as SerializedRehearsalError;
};

const formatValue = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));

export const renderHumanError = (
  error: unknown,
  { debug = false }: { debug?: boolean } = {},
): string => {
  const { error: failure } = serializeRehearsalError(error, { debug });
  return [
    `Rehearsal stopped: ${failure.message}`,
    failure.expected ? `Expected: ${formatValue(failure.expected)}` : null,
    failure.actual ? `Actual: ${formatValue(failure.actual)}` : null,
    failure.context ? `Context: ${formatValue(failure.context)}` : null,
    failure.refused ? `Refused: ${failure.refused}` : null,
    ...(failure.suggestions ?? []).map((value) => `Try: ${value}`),
    `Diagnostic: ${failure.diagnosticId} (${failure.category})`,
    debug && failure.cause ? `Cause: ${failure.cause}` : null,
  ]
    .filter(Boolean)
    .join("\n");
};
