/**
 * Purpose: Define the small, closed set of database runtimes Rehearsal can select.
 * Runtime implementations stay behind this boundary so the shared CLI does not
 * need target-specific branches.
 */

const TARGETS = Object.freeze({
  supabase: Object.freeze({
    id: "supabase",
    label: "Supabase",
  }),
});

export const REHEARSAL_RUNTIME_TARGETS = Object.freeze(Object.keys(TARGETS));

export const resolveRuntimeTarget = (value = "supabase") => {
  if (typeof value !== "string" || !Object.hasOwn(TARGETS, value)) {
    throw new Error(
      `Unsupported Rehearsal runtime target: ${String(value)}. Supported targets: ${REHEARSAL_RUNTIME_TARGETS.join(", ")}.`,
    );
  }
  return TARGETS[value];
};

export const runRuntimeTarget = async (target) => {
  const resolved = resolveRuntimeTarget(target);
  switch (resolved.id) {
    case "supabase":
      await import("./supabase_runtime.mjs");
      return;
    default:
      throw new Error(`No runtime driver is installed for ${resolved.id}.`);
  }
};
