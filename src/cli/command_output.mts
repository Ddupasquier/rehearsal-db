/** Emit the stable JSON envelope or human result for a typed command result. */

import { performance } from "node:perf_hooks";
import { createRehearsalResult } from "../shared/diagnostics.mjs";
import type { RehearsalCliFlags } from "./arguments.mjs";
import type { CommandResult } from "./command_contract.mjs";

export const createCommandEmitter =
  ({
    startedAt,
    startedMs,
    write = console.log,
  }: {
    startedAt: Date;
    startedMs: number;
    write?: (output: string) => void;
  }) =>
  ({
    command,
    flags,
    result,
  }: {
    command: string;
    flags: RehearsalCliFlags;
    result: CommandResult;
  }): number | undefined => {
    if (result.kind === "text") write(result.output);
    if (result.kind === "rendered") {
      const envelope = createRehearsalResult({
        command,
        status: result.status,
        data: result.data,
        startedAt,
        durationMs: Math.round((performance.now() - startedMs) * 100) / 100,
      });
      write(
        flags.json
          ? JSON.stringify(envelope, null, 2)
          : result.render(flags.verbosity),
      );
    }
    return result.exitCode;
  };
