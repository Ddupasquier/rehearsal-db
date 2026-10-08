/** Load exactly one supported database driver for the selected runtime target. */

import { resolveRuntimeTarget } from "./target.mjs";

export const runRuntimeTarget = async (target: unknown): Promise<void> => {
  const resolved = resolveRuntimeTarget(target);
  switch (resolved.id) {
    case "supabase":
      await import("./supabase.mjs");
      return;
    case "postgresql":
      await import("./postgresql.mjs");
      return;
  }
};
