/** Establish a local engine endpoint before resource inspection or removal. */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createCleanProcessEnvironment } from "../../shared/process_environment.mjs";
export type DockerSelectionEnvironment = Readonly<
  Record<string, string | undefined>
>;
export type DockerContextRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) => SpawnSyncReturns<string>;
export const DOCKER_CONTEXT_TLS_FORMAT =
  "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}";
const selectionError = () =>
  new Error(
    "Docker engine selection is unsupported or ambiguous. Explicit selectors were not ignored and no alternate engine was contacted.",
  );
/** Scope Docker client configuration only; ambient engine/TLS/credential overrides never leak to children. */
export const scopedDockerEnvironment = ({
  inheritedEnvironment = process.env,
  endpoint,
}: {
  inheritedEnvironment?: DockerSelectionEnvironment;
  endpoint?: string;
} = {}): Record<string, string> => {
  for (const key of ["DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"])
    if (
      inheritedEnvironment[key] !== undefined &&
      inheritedEnvironment[key] !== ""
    )
      throw selectionError();
  const env = createCleanProcessEnvironment({
      inheritedEnvironment: { ...inheritedEnvironment },
    }),
    pointer = inheritedEnvironment.DOCKER_CONFIG;
  if (pointer !== undefined && pointer !== "") {
    if (
      typeof pointer !== "string" ||
      pointer.length > 4096 ||
      /[\r\n\0]/u.test(pointer) ||
      !isAbsolute(pointer)
    )
      throw selectionError();
    try {
      const canonical = realpathSync(pointer);
      if (!statSync(canonical).isDirectory()) throw selectionError();
      env.DOCKER_CONFIG = canonical;
    } catch {
      throw selectionError();
    }
  }
  if (endpoint !== undefined) {
    if (!isLocalDockerEndpoint(endpoint) || endpoint.startsWith("https:"))
      throw selectionError();
    env.DOCKER_HOST = endpoint;
  }
  return env;
};
const run: DockerContextRunner = (command, args, cwd, environment) =>
  spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment ?? createCleanProcessEnvironment(),
    maxBuffer: 1024 * 1024,
    timeout: 2000,
    stdio: ["ignore", "pipe", "pipe"],
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
  inheritedEnvironment = process.env,
}: {
  cwd?: string;
  runner?: DockerContextRunner;
  context?: string;
  inheritedEnvironment?: DockerSelectionEnvironment;
} = {}): {
  context: string;
  identity: string;
  endpoint: string;
  dockerConfig?: string;
  selectionSource:
    | "reviewed-context"
    | "explicit-context"
    | "explicit-host"
    | "default-context";
} => {
  const environment = scopedDockerEnvironment({ inheritedEnvironment }),
    deadline = Date.now() + 10000;
  const query = (args: readonly string[]) => {
    if (Date.now() > deadline) throw selectionError();
    const result = runner("docker", args, cwd, environment);
    if (
      result.status !== 0 ||
      result.error ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > 65536 ||
      Date.now() > deadline
    )
      throw selectionError();
    return result.stdout.trim();
  };
  const validName = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value);
  const selectedContext = inheritedEnvironment.DOCKER_CONTEXT || undefined,
    selectedHost = inheritedEnvironment.DOCKER_HOST || undefined;
  if (
    (selectedContext !== undefined && !validName(selectedContext)) ||
    (requestedContext !== undefined && !validName(requestedContext)) ||
    (requestedContext &&
      selectedContext &&
      requestedContext !== selectedContext)
  )
    throw selectionError();
  const inspectEndpoint = (name: string) => {
    let value: unknown;
    try {
      value = JSON.parse(
        query([
          "context",
          "inspect",
          "--format",
          "{{json .Endpoints.docker.Host}}",
          name,
        ]),
      );
    } catch {
      throw selectionError();
    }
    return value;
  };
  let context = requestedContext ?? selectedContext,
    source:
      | "reviewed-context"
      | "explicit-context"
      | "explicit-host"
      | "default-context" = requestedContext
      ? "reviewed-context"
      : selectedContext
        ? "explicit-context"
        : "default-context";
  if (context === undefined && selectedHost !== undefined) {
    if (
      !isLocalDockerEndpoint(selectedHost) ||
      selectedHost.startsWith("https:")
    )
      throw new Error(
        "Remote, malformed or TLS Docker hosts are refused before daemon contact; no alternate engine was selected.",
      );
    const names = query(["context", "ls", "--format", "{{.Name}}"])
      .split("\n")
      .filter(Boolean);
    if (
      !names.length ||
      names.length > 32 ||
      new Set(names).size !== names.length ||
      names.some((n) => !validName(n))
    )
      throw selectionError();
    const matches = names.filter(
      (name) => inspectEndpoint(name) === selectedHost,
    );
    if (matches.length !== 1) throw selectionError();
    context = matches[0]!;
    source = "explicit-host";
  }
  if (context === undefined) context = query(["context", "show"]);
  if (!validName(context)) throw selectionError();
  const endpoint = inspectEndpoint(context);
  if (
    !isLocalDockerEndpoint(endpoint) ||
    typeof endpoint !== "string" ||
    endpoint.startsWith("https:")
  )
    throw new Error(
      "Rehearsal resource management requires a local Docker endpoint without TLS. Remote and unknown engine contexts are refused; no alternate engine was selected.",
    );
  if (
    requestedContext &&
    !selectedContext &&
    selectedHost !== undefined &&
    selectedHost !== endpoint
  )
    throw selectionError();
  const tls = query([
    "context",
    "inspect",
    "--format",
    DOCKER_CONTEXT_TLS_FORMAT,
    context,
  ]);
  if (tls !== "false")
    throw new Error(
      "TLS-backed or unknown Docker contexts are unsupported; no daemon was contacted.",
    );
  return {
    context,
    endpoint,
    identity: createHash("sha256")
      .update(JSON.stringify({ context, endpoint }))
      .digest("hex"),
    selectionSource: source,
    ...(environment.DOCKER_CONFIG
      ? { dockerConfig: environment.DOCKER_CONFIG }
      : {}),
  };
};

let boundRuntimeEndpoint: string | null = null;
let boundRuntimeContext: string | null = null;
let boundRuntimeDockerConfig: string | undefined;

/** Bind one manager process to the reviewed local endpoint, not a mutable ambient context. */
export const bindRuntimeDockerEnvironment = ({
  cwd = process.cwd(),
  context,
  expectedIdentity,
  expectedDaemonId,
  runner = run,
  inheritedEnvironment = process.env,
}: {
  cwd?: string;
  context?: string;
  expectedIdentity?: string;
  expectedDaemonId?: string;
  runner?: DockerContextRunner;
  inheritedEnvironment?: DockerSelectionEnvironment;
} = {}) => {
  // Helpers retain the reviewed selection rather than consulting a later
  // ambient default. Metadata and binding drift are still checked on each call.
  const selectedContext = context ?? boundRuntimeContext ?? undefined;
  const local = assertLocalDockerContext({
    cwd,
    runner,
    inheritedEnvironment,
    ...(selectedContext === undefined ? {} : { context: selectedContext }),
  });
  if (expectedIdentity !== undefined && local.identity !== expectedIdentity)
    throw new Error(
      "The reviewed Docker endpoint changed. No runtime action was performed; review a fresh plan.",
    );
  // Cooperative parent/child admission binding, not a boundary against a malicious local owner.
  if (expectedDaemonId !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(expectedDaemonId))
      throw new Error(
        "The admitted Docker daemon identity is invalid; no runtime action was performed.",
      );
    const result = runner(
      "docker",
      ["--host", local.endpoint, "info", "--format", "{{json .ID}}"],
      cwd,
      scopedDockerEnvironment({ inheritedEnvironment }),
    );
    let actual: unknown;
    try {
      actual = JSON.parse(result.stdout);
    } catch {
      actual = null;
    }
    if (result.status !== 0 || actual !== expectedDaemonId)
      throw new Error(
        "The capacity-admitted Docker daemon changed or could not be verified; no runtime action was performed. Review a fresh capacity attempt.",
      );
  }
  if (
    boundRuntimeEndpoint !== null &&
    (boundRuntimeEndpoint !== local.endpoint ||
      boundRuntimeContext !== local.context ||
      boundRuntimeDockerConfig !== local.dockerConfig)
  )
    throw new Error(
      "This manager is already bound to another Docker endpoint.",
    );
  boundRuntimeEndpoint = local.endpoint;
  boundRuntimeContext = local.context;
  boundRuntimeDockerConfig = local.dockerConfig;
  return local;
};

/** Internal child environment only. Never copy this mapping into application or baseline files. */
export const runtimeDockerEnvironment = (): Readonly<Record<string, string>> =>
  boundRuntimeEndpoint === null
    ? Object.freeze({})
    : Object.freeze({
        DOCKER_HOST: boundRuntimeEndpoint,
        ...(boundRuntimeDockerConfig
          ? { DOCKER_CONFIG: boundRuntimeDockerConfig }
          : {}),
      });

export const runtimeDockerContext = (): string | null => boundRuntimeContext;
