/** Closed attempted-input provenance. No statement/source-position inference. */
export interface MigrationFailureSource {
  readonly schemaVersion: 1;
  readonly kind: "baseline" | "candidate";
  readonly filename: string;
  readonly sha256: string;
  readonly workspaceRelativePath: string | null;
  readonly line: null;
  readonly column: null;
  readonly evidence: "owned_execution_input";
}
const controls =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
export const isMigrationWorkspacePath = (value: unknown): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value) <= 1024 &&
  value.length > 0 &&
  !/[\\:%?#]/u.test(value) &&
  !controls.test(value) &&
  value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");

export const parseMigrationFailureSource = (
  value: unknown,
): MigrationFailureSource => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid migration input provenance.");
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).sort().join(",") !==
      "column,evidence,filename,kind,line,schemaVersion,sha256,workspaceRelativePath" ||
    source.schemaVersion !== 1 ||
    !["baseline", "candidate"].includes(String(source.kind)) ||
    typeof source.kind !== "string" ||
    typeof source.filename !== "string" ||
    Buffer.byteLength(source.filename) > 255 ||
    !/^\d{14}_[a-z0-9_]+\.sql$/u.test(source.filename) ||
    typeof source.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.sha256) ||
    (source.workspaceRelativePath !== null &&
      (!isMigrationWorkspacePath(source.workspaceRelativePath) ||
        source.workspaceRelativePath.split("/").at(-1) !== source.filename)) ||
    source.line !== null ||
    source.column !== null ||
    source.evidence !== "owned_execution_input"
  )
    throw new Error("Invalid migration input provenance.");
  return {
    schemaVersion: 1,
    kind: source.kind as MigrationFailureSource["kind"],
    filename: source.filename,
    sha256: source.sha256,
    workspaceRelativePath: source.workspaceRelativePath as string | null,
    line: null,
    column: null,
    evidence: "owned_execution_input",
  };
};

const framePrefix = "Rehearsal migration input v1: ";
export const renderMigrationSourceFrame = (
  source: MigrationFailureSource,
): string =>
  framePrefix +
  Buffer.from(JSON.stringify(parseMigrationFailureSource(source))).toString(
    "base64url",
  );

/** Only a single complete, adjacent core frame can contribute provenance. */
export const readMigrationSourceFrame = (
  output: string,
  adjacentLine: string | undefined,
): MigrationFailureSource | undefined => {
  try {
    const frames = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(framePrefix));
    if (frames.length !== 1 || adjacentLine?.trim() !== frames[0])
      return undefined;
    const encoded = frames[0]!.slice(framePrefix.length);
    if (encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(encoded))
      return undefined;
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length > 2048 || bytes.toString("base64url") !== encoded)
      return undefined;
    const source = parseMigrationFailureSource(
      JSON.parse(bytes.toString("utf8")),
    );
    return renderMigrationSourceFrame(source) === frames[0]
      ? source
      : undefined;
  } catch {
    return undefined;
  }
};
