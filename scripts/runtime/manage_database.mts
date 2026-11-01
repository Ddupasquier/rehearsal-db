#!/usr/bin/env node
/**
 * Purpose: Select the configured database runtime and forward the requested
 * lifecycle action to its isolated driver.
 */

import {
  markKnexFailureBoundary,
  renderKnexFailureFrame,
} from "../../src/runtime/migrations/knex_failure_diagnostic.mjs";
import { loadRehearsalConfig } from "../../src/project/configuration.mjs";
import { parseRuntimeInvocation } from "../../src/targets/target.mjs";
import { runRuntimeTarget } from "../../src/targets/driver.mjs";
import { runWithOperationCancellation } from "../../src/shared/cancellation.mjs";
import { withRuntimeStartupCleanup } from "../../src/runtime/lifecycle/runtime_startup_ownership.mjs";
import { guardRuntimeManagerAction } from "../../src/runtime/lifecycle/runtime_manager_guards.mjs";

const nativeFailureNonce = process.env.REHEARSAL_NATIVE_FAILURE_NONCE;
delete process.env.REHEARSAL_NATIVE_FAILURE_NONCE;
let nativeFailureEnabled = false;
let nativeFailureStage: "admission" | "lifecycle" = "admission";
const run = async () => {
  const invocation = parseRuntimeInvocation();
  const loaded = await loadRehearsalConfig({
    projectRoot: process.cwd(),
    ...(invocation.configPath === undefined
      ? {}
      : { configPath: invocation.configPath }),
  });
  nativeFailureEnabled =
    loaded.config.postgresql?.migrationTool?.kind === "knex";
  await guardRuntimeManagerAction(loaded, invocation.action);
  await withRuntimeStartupCleanup({
    projectRoot: loaded.projectRoot,
    configPath: loaded.configPath,
    config: loaded.config,
    action: invocation.action,
    ownerOperationId: process.env.REHEARSAL_OWNER_OPERATION_ID,
    task: () => {
      nativeFailureStage = "lifecycle";
      return runRuntimeTarget(loaded.config.runtime.target);
    },
  });
};

try {
  if (process.env.REHEARSAL_CANCELLABLE_OPERATION === "1") {
    await runWithOperationCancellation({ task: run });
  } else {
    await run();
  }
} catch (error) {
  try {
    if (nativeFailureEnabled) {
      const failure = markKnexFailureBoundary(error, {
        phase: "lifecycle",
        stage: nativeFailureStage,
        reason: "unclassified",
      });
      const frame = renderKnexFailureFrame(failure, nativeFailureNonce);
      if (frame) process.stderr.write(frame + "\n");
    }
  } catch {
    /* Diagnostic emission cannot replace the original failure. */
  }
  throw error;
}
