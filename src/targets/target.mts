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

export type RehearsalRuntimeTargetId = keyof typeof TARGETS;
export type RehearsalRuntimeTarget = (typeof TARGETS)[RehearsalRuntimeTargetId];

export interface RuntimeInvocation {
  readonly action: string;
  readonly configPath: string | undefined;
  readonly confirmation: string | undefined;
  readonly structuredResult: boolean;
}

export interface RuntimeManagerArguments {
  managerPath: string;
  action: string;
  configPath?: string;
  confirmation?: string;
  structuredResult?: boolean;
}

export const REHEARSAL_RUNTIME_TARGETS = Object.freeze(
  Object.keys(TARGETS) as RehearsalRuntimeTargetId[],
);

export const parseRuntimeInvocation = (
  arguments_: readonly string[] = process.argv.slice(2),
): RuntimeInvocation => {
  const action = arguments_.find((argument) => !argument.startsWith("--"));
  const valueAfter = (prefix: string): string | undefined =>
    arguments_
      .find((argument) => argument.startsWith(prefix))
      ?.slice(prefix.length);
  return Object.freeze({
    action: action ?? "status",
    configPath: valueAfter("--config="),
    confirmation: valueAfter("--confirm-candidates="),
    structuredResult: arguments_.includes("--structured-result"),
  });
};

export const buildRuntimeManagerArguments = ({
  managerPath,
  action,
  configPath,
  confirmation,
  structuredResult = false,
}: RuntimeManagerArguments): string[] => [
  managerPath,
  action,
  ...(configPath ? [`--config=${configPath}`] : []),
  ...(confirmation ? [`--confirm-candidates=${confirmation}`] : []),
  ...(structuredResult ? ["--structured-result"] : []),
];

export const resolveRuntimeTarget = (
  value: unknown = "supabase",
): RehearsalRuntimeTarget => {
  if (typeof value !== "string" || !Object.hasOwn(TARGETS, value)) {
    throw new Error(
      `Unsupported Rehearsal runtime target: ${String(value)}. Supported targets: ${REHEARSAL_RUNTIME_TARGETS.join(", ")}.`,
    );
  }
  return TARGETS[value as RehearsalRuntimeTargetId];
};
