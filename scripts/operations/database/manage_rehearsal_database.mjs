#!/usr/bin/env node
/**
 * Purpose: Select the configured database runtime and forward the requested
 * lifecycle action to its isolated driver.
 */

import { loadRehearsalConfig } from "../../lib/rehearsal/configuration.mjs";
import { runRuntimeTarget } from "../../lib/runtime/runtime_target.mjs";

const { config } = await loadRehearsalConfig({ projectRoot: process.cwd() });
await runRuntimeTarget(config.runtime.target);
