#!/usr/bin/env node
/** Create safe project-root Rehearsal scaffolding during a local install. */

import { fileURLToPath } from "node:url";
import { createInstalledRehearsalScaffold } from "../../src/project/install_scaffold.mjs";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

try {
  const result = await createInstalledRehearsalScaffold({ packageRoot });
  if (result.status === "ready") {
    const changed = result.files.filter((file) => file.action !== "unchanged");
    console.log(
      [
        "Rehearsal is ready in this project.",
        ...(changed.length
          ? [
              ...changed.map(
                (file) =>
                  `  ${file.action === "create" ? "+" : "~"} ${file.path}`,
              ),
            ]
          : ["  Existing Rehearsal configuration preserved."]),
        "Next: review rehearsal.config.mjs, then run npx rehearsal.",
      ].join("\n"),
    );
  } else {
    console.log(
      `Rehearsal did not create project files: ${result.reason}.\nNext: run npx rehearsal from the application directory.`,
    );
  }
} catch (error) {
  console.warn(
    `Rehearsal could not safely create project files during installation: ${String(error?.message ?? error)}\nNext: run npx rehearsal from the application directory.`,
  );
}
