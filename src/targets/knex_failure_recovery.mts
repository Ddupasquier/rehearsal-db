/** Attempt both recovery recording and exact owned stop; never delete retained data. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeMigrationBinding } from "../runtime/native_migration_contract.mjs";
import { withOperationCancellationShield } from "../shared/cancellation.mjs";
import { runtimeDockerEnvironment } from "../runtime/local_docker_context.mjs";
import { assertDockerResourceLabels } from "./docker_resource_ownership.mjs";
import type { BaselineManifest } from "../baseline/artifact.mjs";
const containerRows = (text: string) => {
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("Owned container metadata is unavailable.");
  const rows = text.trim().split("\n").filter(Boolean);
  if (rows.length > 10000)
    throw new Error("Owned container metadata is unbounded.");
  return rows.map((row) => {
    const parts = row.split("\t");
    if (
      parts.length !== 2 ||
      !/^[a-f0-9]{64}$/u.test(parts[0]!) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/u.test(parts[1]!)
    )
      throw new Error("Owned container metadata is invalid.");
    return { id: parts[0]!, name: parts[1]! };
  });
};
export const stopKnexPostgresqlShell = ({
  containerName,
  projectId,
  endpoint,
  run,
}: {
  containerName: string;
  projectId: string;
  endpoint: string | undefined;
  run: (args: readonly string[]) => string;
}) => {
  try {
    if (!endpoint) throw new Error();
    const selected = containerRows(
      run([
        "--host",
        endpoint,
        "ps",
        "--all",
        "--no-trunc",
        "--format",
        "{{.ID}}\t{{.Names}}",
      ]).trim(),
    ).filter((row) => row.name === containerName);
    if (selected.length > 1) throw new Error();
    if (!selected.length) return;
    const id = selected[0]!.id,
      labelsText = run([
        "--host",
        endpoint,
        "container",
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        id,
      ]);
    if (Buffer.byteLength(labelsText) > 65536) throw new Error();
    assertDockerResourceLabels({
      labels: JSON.parse(labelsText),
      expectedLabel: "com.rehearsal-db.project",
      projectId,
    });
    run(["--host", endpoint, "stop", "--time", "10", id]);
  } catch {
    throw new Error(
      "Exact owned PostgreSQL shutdown could not be established; data and worker evidence were retained.",
    );
  }
};
/** Missing recovery metadata is never evidence that an existing Knex volume is disposable. */
export const assertKnexFirstStartResourcesAbsent = ({
  containerName,
  volumeName,
  endpoint,
  run,
}: {
  containerName: string;
  volumeName: string;
  endpoint: string | undefined;
  run: (args: readonly string[]) => string;
}) => {
  const refused = () =>
    new Error(
      "Knex runtime metadata is missing and retained resources are present or unknown. Data was preserved; review recovery before explicitly resetting this disposable target.",
    );
  try {
    if (typeof endpoint !== "string" || !endpoint) throw refused();
    const containers = run([
        "--host",
        endpoint,
        "ps",
        "--all",
        "--no-trunc",
        "--format",
        "{{.ID}}\t{{.Names}}",
      ]),
      volumes = run([
        "--host",
        endpoint,
        "volume",
        "ls",
        "--format",
        "{{.Name}}",
      ]);
    if (
      Buffer.byteLength(containers) > 1024 * 1024 ||
      Buffer.byteLength(volumes) > 1024 * 1024
    )
      throw refused();
    const names = volumes.trim().split("\n").filter(Boolean);
    if (names.length > 10000) throw refused();
    const containersParsed = containerRows(containers).map((row) => row.name);
    if (
      names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/u.test(name)) ||
      containersParsed.includes(containerName) ||
      names.includes(volumeName)
    )
      throw refused();
  } catch {
    throw refused();
  }
};
export const retainKnexResetFailure = async ({
  runtimeWorkdir,
  baselineGenerationId,
  migrationTool,
  stopOwnedContainer,
}: {
  runtimeWorkdir: string;
  baselineGenerationId: string;
  migrationTool: NativeMigrationBinding | undefined;
  stopOwnedContainer: () => Promise<void> | void;
}) =>
  withOperationCancellationShield(async () => {
    const failures: Error[] = [];
    try {
      await writeFile(
        join(runtimeWorkdir, "native-migration-failure.json"),
        JSON.stringify({
          schemaVersion: 1,
          state: "failed_or_interrupted",
          baselineGenerationId,
          migrationTool,
          recovery: "retained-volume-review-required",
        }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    } catch {
      failures.push(
        new Error(
          "Native Knex failure receipt could not be written; retained data must not be automatically resumed.",
        ),
      );
    }
    try {
      await stopOwnedContainer();
    } catch {
      failures.push(
        new Error(
          "Owned PostgreSQL shell shutdown is unconfirmed; its data and worker evidence remain retained.",
        ),
      );
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Knex failure recovery recording or owned shutdown is unconfirmed; no volume or worker evidence was removed.",
      );
  });

export const createKnexFailureRecovery = ({
  runtimeWorkdir,
  containerName,
  volumeName,
  projectId,
  run,
}: {
  runtimeWorkdir: string;
  containerName: string;
  volumeName: string;
  projectId: string;
  run: (args: readonly string[]) => string;
}) => ({
  assertFirstStartAbsent: () =>
    assertKnexFirstStartResourcesAbsent({
      containerName,
      volumeName,
      endpoint: runtimeDockerEnvironment().DOCKER_HOST,
      run,
    }),
  retain: (baseline: BaselineManifest) =>
    retainKnexResetFailure({
      runtimeWorkdir,
      baselineGenerationId: baseline.generationId,
      migrationTool: baseline.nativeMigrations,
      stopOwnedContainer: () =>
        stopKnexPostgresqlShell({
          containerName,
          projectId,
          endpoint: runtimeDockerEnvironment().DOCKER_HOST,
          run,
        }),
    }),
});
