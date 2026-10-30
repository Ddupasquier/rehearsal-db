/** Stream verified baseline rows only through the selected target credential. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Writable } from "node:stream";
import type { ActiveRuntimeInput } from "../runtime/lifecycle_engine.mjs";
import { restoreCopyChunks } from "../runtime/restore_cache.mjs";
import {
  buildRestoreSqlPrefix,
  buildRestoreSqlSuffix,
  summarizeRestoreError,
} from "../runtime/restore.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import { runtimeDockerEnvironment } from "../runtime/local_docker_context.mjs";
import { getOperationCancellationSignal } from "../shared/cancellation.mjs";
import {
  bindOwnedProcessCancellation,
  signalOwnedProcessGroup,
} from "../shared/owned_process.mjs";
import type { knexRestrictedSqlInvocation } from "./knex_restricted_sql.mjs";
const writeChunk = async (
  stream: Writable,
  chunk: string,
  completion: Promise<unknown>,
  assertBudget?: () => number,
): Promise<void> => {
  assertBudget?.();
  if (stream.destroyed || stream.writableEnded) {
    throw new Error("The Rehearsal restore connection closed early.");
  }
  if (!stream.write(chunk)) {
    await Promise.race([once(stream, "drain"), completion]);
  }
};

export const restorePostgresqlRows = async ({
  input: { baseline, paths, manifest },
  cwd,
  artifactRoot,
  containerName,
  databaseUser,
  database,
  restoreCache,
  restricted,
  phaseSignal,
  assertPhaseBudget,
}: {
  input: ActiveRuntimeInput;
  cwd: string;
  artifactRoot: string;
  containerName: string;
  databaseUser: string;
  database: string;
  restoreCache?: Parameters<typeof restoreCopyChunks>[0]["policy"];
  restricted: ReturnType<typeof knexRestrictedSqlInvocation> | null;
  phaseSignal?: AbortSignal;
  assertPhaseBudget?: () => number;
}): Promise<void> => {
  if (restricted) {
    if (!assertPhaseBudget)
      throw new Error("Restricted restore phase budget is unavailable.");
    assertPhaseBudget();
  }
  const child = spawn(
    restricted?.command ?? "docker",
    restricted?.args ?? [
      "exec",
      "--interactive",
      containerName,
      "psql",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      databaseUser,
      "--dbname",
      database,
    ],
    {
      cwd: cwd,
      detached: process.platform !== "win32",
      env:
        restricted?.environment ??
        createCleanProcessEnvironment({
          overrides: runtimeDockerEnvironment(),
        }),
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const completion = new Promise<number | null>((complete, reject) => {
    child.once("error", reject);
    child.once("close", complete);
  });
  const parentCancellation = getOperationCancellationSignal();
  const cancellationSignal = restricted
    ? AbortSignal.any([
        phaseSignal ?? AbortSignal.timeout(120000),
        ...(parentCancellation ? [parentCancellation] : []),
      ])
    : parentCancellation;
  const unbindCancellation = bindOwnedProcessCancellation({
    child,
    ...(cancellationSignal ? { signal: cancellationSignal } : {}),
    ...(restricted ? { cancellationGraceMs: 5000 } : {}),
  });
  child.stdin.on("error", () => undefined);
  try {
    await writeChunk(
      child.stdin,
      buildRestoreSqlPrefix(),
      completion,
      restricted ? assertPhaseBudget : undefined,
    );
    const copy = await restoreCopyChunks({
      artifactRoot,
      dataPath: paths.dataPath,
      generationId: baseline.generationId,
      sourceSha256: baseline.files["sanitized-data.ndjson"]!.sha256,
      sanitizationPolicySha256: baseline.sanitizationPolicySha256,
      target: "postgresql",
      ...(restoreCache ? { policy: restoreCache } : {}),
      ...(cancellationSignal ? { signal: cancellationSignal } : {}),
    });
    for await (const chunk of copy.chunks)
      await writeChunk(
        child.stdin,
        chunk,
        completion,
        restricted ? assertPhaseBudget : undefined,
      );
    console.log(`COPY encoding cache: ${copy.state}.`);
    await writeChunk(
      child.stdin,
      buildRestoreSqlSuffix({
        manifest,
        tableCounts: baseline.tableCounts,
        restoreSupabaseAuth: false,
        ...(restricted ? { identityMode: "continue" as const } : {}),
      }),
      completion,
      restricted ? assertPhaseBudget : undefined,
    );
    child.stdin.end();
    const exitCode = await completion;
    if (exitCode !== 0 || cancellationSignal?.aborted) {
      throw new Error(
        restricted
          ? "Restricted Knex restore failed, timed out or was cancelled; private SQL and provider output are withheld."
          : `The local Rehearsal restore failed. ${summarizeRestoreError(stderr)}`,
      );
    }
  } catch (error) {
    if (child.exitCode === null) signalOwnedProcessGroup(child, "SIGTERM");
    await completion.catch(() => undefined);
    throw error;
  } finally {
    unbindCancellation();
  }
};
