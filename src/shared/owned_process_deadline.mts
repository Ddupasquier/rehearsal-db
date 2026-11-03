/** One client deadline; expired transport never establishes backend cleanup. */
export const withOwnedProcessDeadline = async <T,>(
  {
    timeoutMilliseconds,
    signal,
  }: { timeoutMilliseconds: number; signal?: AbortSignal },
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0)
    throw new Error("Invalid owned process deadline.");
  const controller = new AbortController(),
    abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  timer.unref();
  try {
    controller.signal.throwIfAborted();
    const result = await operation(controller.signal);
    if (controller.signal.aborted)
      throw new AggregateError(
        [],
        "Owned process deadline or interruption left transport state unconfirmed; preserve recovery.",
      );
    return result;
  } finally {
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};
