/** Fixed fixture-only bounds for one child created and retained by its caller. */
const deadline = async (exit, milliseconds) => {
  let timer;
  return Promise.race([
    exit.then((result) => ({ exited: true, result })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ exited: false }), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
};

export const terminateOwnedFixtureChild = async ({ child, exit }) => {
  // Never enumerate, signal a group, or infer ownership from an ambient PID.
  child.kill("SIGTERM");
  const terminated = await deadline(exit, 1_000);
  if (terminated.exited) return terminated.result;
  child.kill("SIGKILL");
  const killed = await deadline(exit, 1_000);
  if (killed.exited) return killed.result;
  throw new Error(
    "Owned fixture child did not acknowledge bounded termination.",
  );
};

export const awaitOwnedFixtureCancellation = async ({ child, exit }) => {
  const completed = await deadline(exit, 10_000);
  if (completed.exited) return completed.result;
  const failure = new Error(
    "The cancellable migration exceeded its 10000ms exit deadline.",
  );
  try {
    await terminateOwnedFixtureChild({ child, exit });
  } catch (cleanupError) {
    throw new AggregateError(
      [failure, cleanupError],
      "Cancellation timed out and owned child termination could not be confirmed.",
    );
  }
  throw failure;
};
