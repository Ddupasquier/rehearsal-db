#!/usr/bin/env node
/**
 * Purpose: Select the configured database runtime and forward the requested
 * lifecycle action to its isolated driver.
 */

import { loadRehearsalConfig } from "../../src/project/configuration.mjs";
import { parseRuntimeInvocation } from "../../src/targets/target.mjs";
import { runRuntimeTarget } from "../../src/targets/driver.mjs";
import { runWithOperationCancellation } from "../../src/shared/cancellation.mjs";
import { withRuntimeStartupCleanup } from "../../src/runtime/runtime_startup_ownership.mjs";
import { guardRuntimeManagerAction } from "../../src/runtime/runtime_manager_guards.mjs";

const run = async () => {
  const invocation = parseRuntimeInvocation();
  const loaded = await loadRehearsalConfig({
    projectRoot: process.cwd(),
    ...(invocation.configPath === undefined
      ? {}
      : { configPath: invocation.configPath }),
  });
  await guardRuntimeManagerAction(loaded, invocation.action);
  await withRuntimeStartupCleanup({
    projectRoot: loaded.projectRoot,
    configPath: loaded.configPath,
    config: loaded.config,
    action: invocation.action,
    ownerOperationId: process.env.REHEARSAL_OWNER_OPERATION_ID,
    task: () => runRuntimeTarget(loaded.config.runtime.target),
  });
};

if (process.env.REHEARSAL_CANCELLABLE_OPERATION === "1") {
  await runWithOperationCancellation({ task: run });
} else {
  await run();
}
