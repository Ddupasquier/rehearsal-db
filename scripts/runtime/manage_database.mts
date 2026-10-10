#!/usr/bin/env node
/**
 * Purpose: Select the configured database runtime and forward the requested
 * lifecycle action to its isolated driver.
 */

import { loadRehearsalConfig } from "../../src/project/configuration.mjs";
import { parseRuntimeInvocation } from "../../src/targets/target.mjs";
import { runRuntimeTarget } from "../../src/targets/driver.mjs";
import { runWithOperationCancellation } from "../../src/shared/cancellation.mjs";

const run = async () => {
  const invocation = parseRuntimeInvocation();
  const { config } = await loadRehearsalConfig({
    projectRoot: process.cwd(),
    ...(invocation.configPath === undefined
      ? {}
      : { configPath: invocation.configPath }),
  });
  await runRuntimeTarget(config.runtime.target);
};

if (process.env.REHEARSAL_CANCELLABLE_OPERATION === "1") {
  await runWithOperationCancellation({ task: run });
} else {
  await run();
}
