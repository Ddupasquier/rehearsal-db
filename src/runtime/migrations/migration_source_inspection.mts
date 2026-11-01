import {
  parseKnexMigrationIdentity,
  readKnexMigrationInventory,
  type KnexMigrationIdentity,
} from "./knex_history.mjs";
/** Read-only source references name reviewed input, never an attempted SDK statement. */
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { RehearsalConfigPathOptions } from "../../project/configuration.mjs";
import { RehearsalError } from "../../shared/diagnostics.mjs";
import {
  parseDrizzleMigrationIdentity,
  sameMigrationCutoff,
  type DrizzleMigrationIdentity,
} from "./migration_identity.mjs";
import { readDrizzleMigrationInventory } from "./drizzle_history.mjs";
import { inspectRehearsalMigrations } from "../lifecycle/plan.mjs";
import { inspectRuntimeTopologyCandidates } from "../lifecycle/topology.mjs";
import { isMigrationWorkspacePath } from "./migration_failure_source.mjs";
export interface ReviewedNativeSourceReference {
  readonly schemaVersion: 2;
  readonly evidence: "reviewed_source_input";
  readonly target: string;
  readonly candidateSha256: string;
  readonly nativeIdentity: DrizzleMigrationIdentity | KnexMigrationIdentity;
  readonly filename: string;
  readonly sha256: string;
  readonly workspaceRelativePath: string;
  readonly line: null;
  readonly column: null;
}
const invalid = () =>
  new RehearsalError({
    category: "configuration_invalid",
    code: "CONFIGURATION_INVALID",
    message:
      "The reviewed native source identity, file checksum or complete candidate digest is missing, stale or invalid.",
    refused:
      "No source-navigation reference was returned. No SQL was executed and no engine or database contacted.",
    suggestions: [
      "Refresh inspect plan and select an exact current native migration row.",
    ],
  });
export const inspectMigrationSource = async (
  options: RehearsalConfigPathOptions,
  request: {
    target?: string | undefined;
    nativeIdentity?: string | undefined;
    sourceSha256?: string | undefined;
    candidateSha256?: string | undefined;
  },
): Promise<ReviewedNativeSourceReference> => {
  if (
    typeof request.target !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/u.test(request.target) ||
    typeof request.nativeIdentity !== "string" ||
    request.nativeIdentity.length > 1024 ||
    typeof request.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(request.sourceSha256) ||
    typeof request.candidateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(request.candidateSha256)
  )
    throw invalid();
  let identity: DrizzleMigrationIdentity | KnexMigrationIdentity;
  try {
    const value = JSON.parse(request.nativeIdentity);
    identity =
      value?.kind === "knex"
        ? parseKnexMigrationIdentity(value)
        : parseDrizzleMigrationIdentity(value);
  } catch {
    throw invalid();
  }
  const inspections = new Map<
    string,
    Awaited<ReturnType<typeof inspectRehearsalMigrations>>
  >();
  const reviewed = await inspectRuntimeTopologyCandidates(
    options,
    inspectRehearsalMigrations,
    (target, inspection) => {
      inspections.set(target.name, inspection);
    },
  );
  if (reviewed.candidateSha256 !== request.candidateSha256) throw invalid();
  const target = reviewed.targets.find(
      (target) => target.name === request.target,
    ),
    inspection = inspections.get(request.target);
  if (
    !target ||
    !inspection ||
    target.config.postgresql?.migrationTool?.kind !== identity.kind ||
    inspection.migrationTool?.kind !== identity.kind
  )
    throw invalid();
  const entry = inspection.migrations.find(
    (entry) =>
      "nativeIdentity" in entry &&
      sameMigrationCutoff(entry.nativeIdentity, identity),
  );
  if (!entry || entry.sha256 !== request.sourceSha256) throw invalid();
  // The full closure observation can outlast the initial file inventory. Re-read
  // its bounded native source after that observation; never return a stale path
  // solely because the first inventory once contained the requested checksum.
  if (inspection.migrationTool?.kind === "knex") {
    const fresh = await readKnexMigrationInventory(
      pathToFileURL(`${target.paths.migrationDirectory}/`),
    );
    if (
      fresh.bundleSha256 !== inspection.migrationTool.bundleSha256 ||
      fresh.entries.length !== inspection.migrations.length ||
      fresh.entries.some((file, index) => {
        const old = inspection.migrations[index]!;
        return (
          !("nativeIdentity" in old) ||
          old.nativeIdentity.kind !== "knex" ||
          old.nativeIdentity.name !== file.nativeIdentity.name ||
          old.filename !== file.filename ||
          old.sha256 !== file.fileSha256
        );
      })
    )
      throw invalid();
  } else if (inspection.migrationTool?.kind === "drizzle") {
    const fresh = await readDrizzleMigrationInventory(
      pathToFileURL(`${target.paths.migrationDirectory}/`),
    );
    if (
      fresh.binding.journalSha256 !== inspection.migrationTool.journalSha256 ||
      fresh.entries.length !== inspection.migrations.length ||
      fresh.entries.some((file, index) => {
        const old = inspection.migrations[index]!;
        return (
          !("nativeIdentity" in old) ||
          old.nativeIdentity.kind !== "drizzle" ||
          file.idx !== old.nativeIdentity.idx ||
          file.when !== old.nativeIdentity.when ||
          file.tag !== old.nativeIdentity.tag ||
          file.filename !== old.filename ||
          file.hash !== old.sha256
        );
      })
    )
      throw invalid();
  } else throw invalid();
  const path = relative(
    reviewed.topology.projectRoot,
    join(target.paths.migrationDirectory, entry.filename),
  )
    .split(sep)
    .join("/");
  if (
    !(identity.kind === "knex"
      ? path.length <= 3072 &&
        path
          .split("/")
          .every(
            (p) =>
              /^[A-Za-z0-9][A-Za-z0-9_.-]{0,190}$/u.test(p) &&
              !["notes", "node_modules"].includes(p),
          )
      : isMigrationWorkspacePath(path)) ||
    path.split("/").at(-1) !== entry.filename
  )
    throw invalid();
  return Object.freeze({
    schemaVersion: 2,
    evidence: "reviewed_source_input",
    target: target.name,
    candidateSha256: reviewed.candidateSha256,
    nativeIdentity: identity,
    filename: entry.filename,
    sha256: entry.sha256,
    workspaceRelativePath: path,
    line: null,
    column: null,
  });
};
