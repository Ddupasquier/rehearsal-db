/** Create and remove an isolated fixture copy owned by one scenario. */

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const createScenarioWorkspace = async ({ prefix, fixtureSource }) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectRoot = join(root, "project");
  const packageOutput = join(root, "packed");
  if (fixtureSource) await cp(fixtureSource, projectRoot, { recursive: true });
  else await mkdir(projectRoot, { recursive: true });
  await mkdir(packageOutput, { recursive: true });
  return Object.freeze({ root, projectRoot, packageOutput });
};

export const removeScenarioWorkspace = (workspace) =>
  rm(workspace.root, { recursive: true, force: true });
