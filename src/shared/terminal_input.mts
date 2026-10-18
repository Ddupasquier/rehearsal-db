/** Own terminal control bytes without suspending the invoking shell's npm job. */

export interface TerminalInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing?: boolean | null;
  setRawMode?(enabled: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  prependListener(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
  removeListener(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
}

interface InputOwner {
  readonly interrupt: (signal: "SIGINT" | "SIGTSTP") => void;
}

interface InputLease {
  readonly owners: InputOwner[];
  readonly interactive: boolean;
  readonly wasRaw: boolean;
  readonly wasFlowing: boolean;
  readonly changedRaw: boolean;
  readonly dispatch: (chunk: Buffer | string) => void;
}

export interface TerminalInputLease {
  (): void;
  isCurrentOwner(): boolean;
}

const leases = new WeakMap<TerminalInput, InputLease>();

export const hasTerminalInputLease = (
  input: TerminalInput | null | undefined,
): boolean => !!input && leases.has(input);

/** Prompt libraries may restore cooked mode; resume only a still-owned lease. */
export const reassertTerminalInputLease = (
  input: TerminalInput | null | undefined,
): void => {
  if (!input || !leases.get(input)?.interactive) return;
  if (input.isRaw !== true) input.setRawMode?.(true);
  input.resume?.();
};

const restoreInput = (input: TerminalInput, lease: InputLease): void => {
  if (!lease.interactive) return;
  const errors: unknown[] = [];
  try {
    if (lease.changedRaw) input.setRawMode?.(lease.wasRaw);
  } catch (error) {
    errors.push(error);
  }
  try {
    // A previously untouched (null) stream must return to non-consuming mode,
    // just like a previously paused stream; do not leave stdin keeping Node alive.
    if (lease.wasFlowing) input.resume?.();
    else input.pause?.();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Terminal input restoration failed.");
};

/**
 * Raw input turns Ctrl+C/Ctrl+Z into bytes instead of kernel signals to the
 * entire foreground npm/shell job. Signal handlers remain responsible for
 * externally delivered signals. The final overlapping lease restores only the
 * mode/flow state this owner acquired; a pre-existing raw terminal stays raw.
 */
export const acquireTerminalInput = (
  input: TerminalInput | null | undefined,
  onInterrupt: (signal: "SIGINT" | "SIGTSTP") => void,
): TerminalInputLease => {
  if (!input)
    return Object.assign(() => undefined, { isCurrentOwner: () => true });
  const owner = { interrupt: onInterrupt };
  let lease = leases.get(input);
  const first = !lease;
  if (!lease) {
    const owners: InputOwner[] = [];
    lease = {
      owners,
      interactive: input.isTTY === true,
      wasRaw: input.isRaw === true,
      wasFlowing: input.readableFlowing === true,
      changedRaw:
        input.isTTY === true &&
        input.isRaw !== true &&
        typeof input.setRawMode === "function",
      dispatch: (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const signal = bytes.includes(0x03)
          ? "SIGINT"
          : bytes.includes(0x1a)
            ? "SIGTSTP"
            : null;
        // Capture one owner before dispatch: synchronous release must not deliver
        // the same byte again to an outer operation.
        const current = owners.at(-1);
        if (signal) current?.interrupt(signal);
      },
    };
    leases.set(input, lease);
  }
  lease.owners.push(owner);
  try {
    if (first && lease.changedRaw) input.setRawMode!(true);
    if (first && lease.interactive)
      input.prependListener("data", lease.dispatch);
    if (lease.interactive) input.resume?.();
  } catch (error) {
    const errors: unknown[] = [error];
    lease.owners.splice(lease.owners.indexOf(owner), 1);
    try {
      if (first && lease.interactive)
        input.removeListener("data", lease.dispatch);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (first) {
      leases.delete(input);
      try {
        restoreInput(input, lease);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    if (errors.length > 1)
      throw new AggregateError(
        errors,
        "Terminal input could not be acquired or restored.",
      );
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.owners.splice(lease.owners.indexOf(owner), 1);
    if (lease.owners.length === 0) {
      leases.delete(input);
      try {
        if (lease.interactive) input.removeListener("data", lease.dispatch);
      } finally {
        restoreInput(input, lease);
      }
    }
  };
  return Object.assign(release, {
    isCurrentOwner: () => !released && lease.owners.at(-1) === owner,
  });
};
