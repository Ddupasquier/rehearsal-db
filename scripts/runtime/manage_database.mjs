#!/usr/bin/env node
/**
 * Purpose: Select the configured database runtime and forward the requested
 * lifecycle action to its isolated driver.
 */

import { loadRehearsalConfig } from "../../src/project/configuration.mjs";
import {
  parseRuntimeInvocation,
  runRuntimeTarget,
} from "../../src/targets/target.mjs";

const invocation = parseRuntimeInvocation();
const { config } = await loadRehearsalConfig({
  projectRoot: process.cwd(),
  configPath: invocation.configPath,
});
await runRuntimeTarget(config.runtime.target);
