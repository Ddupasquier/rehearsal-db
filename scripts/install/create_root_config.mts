#!/usr/bin/env node
/** Create safe project-root Rehearsal scaffolding during a local install. */

import { fileURLToPath } from "node:url";
import {
  createInstalledRehearsalScaffold,
  renderInstalledRehearsalScaffold,
} from "../../src/project/install_scaffold.mjs";
import { inspectHostPlatform } from "../../src/shared/host_platform.mjs";

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));

try {
  const host = await inspectHostPlatform();
  if (!host.supported) {
    console.log(
      `Rehearsal installed without creating project files. ${host.remediation}`,
    );
  } else {
    const result = await createInstalledRehearsalScaffold({ packageRoot });
    console.log(renderInstalledRehearsalScaffold(result));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `Rehearsal could not safely create project files during installation: ${message}\nNext: run npx rehearsal from the application directory.`,
  );
}
