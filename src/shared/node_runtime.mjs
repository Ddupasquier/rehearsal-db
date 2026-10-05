/**
 * Supported Node.js release lines. Keep this aligned with package.json and the
 * verification matrix.
 */

export const REHEARSAL_NODE_MAJORS = Object.freeze([22, 24, 26]);
export const REHEARSAL_NODE_LABEL = "Node.js 22, 24, or 26";
export const REHEARSAL_RECOMMENDED_NODE_MAJOR = 24;

export const inspectRehearsalNodeRuntime = (
  version = process.versions.node,
) => {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  return {
    version: String(version),
    major,
    supported: REHEARSAL_NODE_MAJORS.includes(major),
  };
};

export const assertSupportedRehearsalNodeRuntime = (
  version = process.versions.node,
) => {
  const runtime = inspectRehearsalNodeRuntime(version);
  if (!runtime.supported) {
    throw new Error(
      `Rehearsal requires ${REHEARSAL_NODE_LABEL}; this shell is using Node.js ${runtime.version}. Switch to a supported release, then rerun setup. With nvm: nvm install --lts && nvm use --lts.`,
    );
  }
  return runtime;
};
