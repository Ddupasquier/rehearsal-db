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
  postgresql: Object.freeze({
    id: "postgresql",
    label: "PostgreSQL",
  }),
});

export const REHEARSAL_RUNTIME_TARGETS = Object.freeze(Object.keys(TARGETS));

export const parseRuntimeInvocation = (arguments_ = process.argv.slice(2)) => {
  const action = arguments_.find((argument) => !argument.startsWith("--"));
  const valueAfter = (prefix) =>
    arguments_
      .find((argument) => argument.startsWith(prefix))
      ?.slice(prefix.length);
  return Object.freeze({
    action: action ?? "status",
    configPath: valueAfter("--config="),
    confirmation: valueAfter("--confirm-candidates="),
  });
};

export const buildRuntimeManagerArguments = ({
  managerPath,
  action,
  configPath,
  confirmation,
}) => [
  managerPath,
  action,
  ...(configPath ? [`--config=${configPath}`] : []),
  ...(confirmation ? [`--confirm-candidates=${confirmation}`] : []),
];

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
      await import("./supabase.mjs");
      return;
    case "postgresql":
      await import("./postgresql.mjs");
      return;
    default:
      throw new Error(`No runtime driver is installed for ${resolved.id}.`);
  }
};
