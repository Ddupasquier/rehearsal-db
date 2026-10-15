/** Establish a local engine endpoint before resource inspection or removal. */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => SpawnSyncReturns<string>;
const run: Runner = (command, args, cwd) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: createCleanProcessEnvironment(),
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
export const isLocalDockerEndpoint = (value: unknown): boolean => {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\r\n\0]/u.test(value)
  )
    return false;
  if (/^npipe:\/{4}(?:\.|localhost)\/pipe\/[a-z0-9_.-]+$/iu.test(value))
    return true;
  try {
    const endpoint = new URL(value);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      return false;
    if (endpoint.protocol === "unix:")
      return (
        endpoint.hostname === "" &&
        endpoint.pathname.startsWith("/") &&
        endpoint.pathname.length > 1
      );
    return (
      ["tcp:", "http:", "https:"].includes(endpoint.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
      ["", "/"].includes(endpoint.pathname)
    );
  } catch {
    return false;
  }
};
export const assertLocalDockerContext = ({
  cwd = process.cwd(),
  runner = run,
  context: requestedContext,
}: { cwd?: string; runner?: Runner; context?: string } = {}): {
  context: string;
  identity: string;
  endpoint: string;
} => {
  const current =
    requestedContext === undefined
      ? runner("docker", ["context", "show"], cwd)
      : null;
  const context = requestedContext ?? current?.stdout?.trim();
  if (
    (current !== null && current.status !== 0) ||
    !context ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(context)
  )
    throw new Error(
      "A local Docker context could not be verified. Select your local engine and retry; no resources were changed.",
    );
  const result = runner(
    "docker",
    [
      "context",
      "inspect",
      "--format",
      "{{json .Endpoints.docker.Host}}",
      context,
    ],
    cwd,
  );
  let endpoint: unknown;
  try {
    endpoint = JSON.parse(result.stdout);
  } catch {
    endpoint = null;
  }
  if (result.status !== 0 || !isLocalDockerEndpoint(endpoint))
    throw new Error(
      "Rehearsal resource management requires a local Docker endpoint. Remote and unknown engine contexts are refused; select your local engine and retry.",
    );
  return {
    context,
    endpoint: endpoint as string,
    identity: createHash("sha256")
      .update(JSON.stringify({ context, endpoint }))
      .digest("hex"),
  };
};

let boundRuntimeEndpoint: string | null = null;
let boundRuntimeContext: string | null = null;

/** Bind one manager process to the reviewed local endpoint, not a mutable ambient context. */
export const bindRuntimeDockerEnvironment = ({
  cwd = process.cwd(),
  context,
  expectedIdentity,
  runner = run,
}: {
  cwd?: string;
  context?: string;
  expectedIdentity?: string;
  runner?: Runner;
} = {}) => {
  const local = assertLocalDockerContext({
    cwd,
    runner,
    ...(context === undefined ? {} : { context }),
  });
  if (expectedIdentity !== undefined && local.identity !== expectedIdentity)
    throw new Error(
      "The reviewed Docker endpoint changed. No runtime action was performed; review a fresh plan.",
    );
  if (boundRuntimeEndpoint !== null && boundRuntimeEndpoint !== local.endpoint)
    throw new Error(
      "This manager is already bound to another Docker endpoint.",
    );
  boundRuntimeEndpoint = local.endpoint;
  boundRuntimeContext = local.context;
  return local;
};

/** Internal child environment only. Never copy this mapping into application or baseline files. */
export const runtimeDockerEnvironment = (): Readonly<Record<string, string>> =>
  boundRuntimeEndpoint === null
    ? Object.freeze({})
    : Object.freeze({ DOCKER_HOST: boundRuntimeEndpoint });

export const runtimeDockerContext = (): string | null => boundRuntimeContext;
