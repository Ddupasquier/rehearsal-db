/** Launch ordinary application commands against verified local runtime files. */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  createCleanProcessEnvironment,
  isLoopbackUrl,
} from "../shared/process_environment.mjs";

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/u;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const SESSION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"];
type SessionSignal = (typeof SESSION_SIGNALS)[number];

export type ApplicationSessionSignal = SessionSignal;

export interface ApplicationReadiness {
  readonly url: string;
  readonly expectedStatus?: number;
  readonly timeoutSeconds?: number;
}

export interface ApplicationSession {
  readonly pid: number | undefined;
  readonly ready: Readonly<{ url: string; status: number }>;
  readonly stop: () => Promise<void>;
  readonly wait: () => Promise<ChildExit>;
  readonly diagnostics: () => ApplicationDiagnostics;
}

export interface ApplicationDiagnostics {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

interface ChildExit {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface SessionInput {
  readonly isTTY?: boolean;
  prependListener(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
  removeListener(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): unknown;
}

interface EnvironmentInput {
  readonly files: Readonly<Record<string, string>> & {
    readonly primary: string;
  };
  readonly mappings: Readonly<Record<string, string>>;
}

interface HttpJsonAssertion {
  readonly path: readonly string[];
  readonly equals?: unknown;
  readonly notEquals?: unknown;
  readonly minimumItems?: number;
}

export interface HttpProofCheck {
  readonly name: string;
  readonly kind: "positive" | "negative";
  readonly url: string;
  readonly method?: string;
  readonly expectedStatus: number;
  readonly timeoutMs?: number;
  readonly json?: HttpJsonAssertion | null;
}

type SignalTarget = Pick<EventEmitter, "prependListener" | "removeListener">;

const parseCommand = (source: string): [string, ...string[]] => {
  if (typeof source !== "string" || !source.trim())
    throw new Error("Application command is empty.");
  const values: string[] = [];
  let value = "";
  let quote: '"' | "'" | null = null;
  for (const character of source) {
    if (quote) {
      if (character === quote) quote = null;
      else value += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/u.test(character)) {
      if (value) values.push(value);
      value = "";
    } else value += character;
  }
  if (quote)
    throw new Error("Application command contains an unmatched quote.");
  if (value) values.push(value);
  const [program, ...args] = values;
  if (!program) throw new Error("Application command is empty.");
  return [program, ...args];
};

const readOwnedEnvironment = async (
  path: string,
): Promise<Record<string, string>> => {
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new Error(
      "Runtime environment file must be an owner-only regular file.",
    );
  }
  const parsed = parseEnv(await readFile(path, "utf8"));
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
};

const assertLocalValue = (key: string, value: string): void => {
  if (/(_URL|_URI|_ENDPOINT)$/u.test(key)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Mapped runtime variable ${key} is not a URL.`);
    }
    if (
      !isLoopbackUrl(value) &&
      !["postgres:", "postgresql:"].includes(parsed.protocol)
    ) {
      throw new Error(`Mapped runtime variable ${key} is not local.`);
    }
    if (
      ["postgres:", "postgresql:"].includes(parsed.protocol) &&
      !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)
    ) {
      throw new Error(`Mapped runtime variable ${key} is not local.`);
    }
  }
};

export const buildApplicationEnvironment = async ({
  files,
  mappings,
}: EnvironmentInput): Promise<Record<string, string>> => {
  if (!files?.primary)
    throw new Error("Primary runtime environment file is required.");
  const environments: Record<string, Record<string, string>> = {};
  for (const [name, path] of Object.entries(files)) {
    environments[name] = await readOwnedEnvironment(path);
  }
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throw new Error("Application environment mappings must be an object.");
  }
  const result: Record<string, string> = {};
  for (const [destination, reference] of Object.entries(mappings)) {
    if (!ENV_KEY.test(destination) || typeof reference !== "string") {
      throw new Error("Application environment mapping is invalid.");
    }
    const separator = reference.indexOf(":");
    if (separator < 1)
      throw new Error(
        `Application mapping ${destination} has an invalid reference.`,
      );
    const target = reference.slice(0, separator);
    const source = reference.slice(separator + 1);
    const sourceValue = environments[target]?.[source];
    if (!ENV_KEY.test(source) || !sourceValue) {
      throw new Error(
        `Application mapping ${destination} references a missing runtime value.`,
      );
    }
    assertLocalValue(source, sourceValue);
    result[destination] = sourceValue;
  }
  return result;
};

const boundedAppend = (current: string, chunk: string): string =>
  `${current}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);

const childHasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const waitForChildExit = (child: ChildProcess): Promise<ChildExit> => {
  if (childHasExited(child)) {
    return Promise.resolve({
      status: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise<ChildExit>((resolve) => {
    child.once("exit", (status, signal) => resolve({ status, signal }));
  });
};

export const summarizeProjectCommandFailure = ({
  error,
  status,
  signal,
  stdout = "",
  stderr = "",
  stdoutByteCount,
  stderrByteCount,
}: {
  error?: NodeJS.ErrnoException;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  stdoutByteCount?: number;
  stderrByteCount?: number;
}): string => {
  const stdoutBytes = stdoutByteCount ?? Buffer.byteLength(String(stdout));
  const stderrBytes = stderrByteCount ?? Buffer.byteLength(String(stderr));
  if (error) {
    const code = /^[A-Z0-9_]+$/u.test(error.code ?? "")
      ? ` (${error.code})`
      : "";
    return `command could not start${code}; output withheld`;
  }
  const outcome = signal
    ? `signal ${signal}`
    : `exit ${Number.isInteger(status) ? status : "unknown"}`;
  return `${outcome}; stdout ${stdoutBytes} bytes; stderr ${stderrBytes} bytes; output withheld`;
};

const waitForReadiness = async ({
  readiness,
  fetchImplementation,
  child,
}: {
  readiness: ApplicationReadiness;
  fetchImplementation: typeof fetch;
  child: ChildProcess;
}): Promise<Readonly<{ url: string; status: number }>> => {
  if (!readiness || !isLoopbackUrl(readiness.url)) {
    throw new Error("Application readiness must use a loopback URL.");
  }
  const expected = readiness.expectedStatus ?? 200;
  const deadline = Date.now() + (readiness.timeoutSeconds ?? 30) * 1_000;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    if (childHasExited(child))
      throw new Error("Application exited before becoming ready.");
    try {
      const response = await fetchImplementation(readiness.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      lastStatus = response.status;
      if (response.status === expected)
        return { url: readiness.url, status: response.status };
    } catch {
      // A bounded retry is expected while the local process starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Application readiness timed out${lastStatus === null ? "" : ` after HTTP ${lastStatus}`}.`,
  );
};

const stopOwnedChild = async (child: ChildProcess): Promise<void> => {
  if (childHasExited(child)) return;
  const exit = waitForChildExit(child);
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else {
        if (child.pid === undefined) {
          throw new Error(
            "Application child process has no process identifier.",
          );
        }
        process.kill(-child.pid, signal);
      }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ESRCH"
      )
        throw error;
    }
  };
  kill("SIGTERM");
  await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (!childHasExited(child)) {
    kill("SIGKILL");
    await exit;
  }
};

export const startApplicationSession = async ({
  command,
  cwd,
  files,
  mappings,
  readiness,
  inheritedEnvironment = process.env,
  spawnImplementation = spawn,
  fetchImplementation = fetch,
  signalTarget = process,
}: EnvironmentInput & {
  command: string;
  cwd: string;
  readiness: ApplicationReadiness;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  spawnImplementation?: typeof spawn;
  fetchImplementation?: typeof fetch;
  signalTarget?: SignalTarget;
}): Promise<ApplicationSession> => {
  const mapped = await buildApplicationEnvironment({ files, mappings });
  const [program, ...args] = parseCommand(command);
  const child = spawnImplementation(program, args, {
    cwd,
    env: createCleanProcessEnvironment({
      inheritedEnvironment,
      overrides: mapped,
    }),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout = boundedAppend(stdout, chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = boundedAppend(stderr, chunk.toString("utf8"));
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  let interruptStartup: (signal: SessionSignal) => void = () => undefined;
  const interruption = new Promise<never>((_, reject) => {
    interruptStartup = (signal: SessionSignal) =>
      reject(new Error(`Application startup was interrupted by ${signal}.`));
  });
  const startupHandlers = new Map(
    SESSION_SIGNALS.map((signal) => [signal, () => interruptStartup(signal)]),
  );
  for (const [signal, handler] of startupHandlers) {
    signalTarget.prependListener(signal, handler);
  }
  try {
    const ready = await Promise.race([
      waitForReadiness({
        readiness,
        fetchImplementation,
        child,
      }),
      interruption,
    ]);
    return Object.freeze({
      pid: child.pid,
      ready,
      stop: () => stopOwnedChild(child),
      wait: () => waitForChildExit(child),
      diagnostics: () => ({
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      }),
    });
  } catch (error) {
    await stopOwnedChild(child);
    throw error;
  } finally {
    for (const [signal, handler] of startupHandlers) {
      signalTarget.removeListener(signal, handler);
    }
  }
};

/**
 * Keep a ready application session attached until the user interrupts it.
 * The child process group is always stopped before this function returns.
 */
export const holdApplicationSession = async ({
  session,
  signalTarget = process,
  input = process.stdin,
  onReady = () => undefined,
}: {
  session: ApplicationSession;
  signalTarget?: SignalTarget;
  input?: SessionInput;
  onReady?: (ready: ApplicationSession["ready"]) => void;
}): Promise<
  Readonly<{ signal: SessionSignal; diagnostics: ApplicationDiagnostics }>
> => {
  if (
    !session ||
    typeof session.wait !== "function" ||
    typeof session.stop !== "function"
  ) {
    throw new Error("A started application session is required.");
  }
  type Interruption = { kind: "interrupted"; signal: SessionSignal };
  let finishInterruption: (result: Interruption) => void = () => undefined;
  const interruption = new Promise<Interruption>((resolve) => {
    finishInterruption = resolve;
  });
  const handlers = new Map(
    SESSION_SIGNALS.map((signal) => [
      signal,
      () => finishInterruption({ kind: "interrupted", signal }),
    ]),
  );
  for (const [signal, handler] of handlers) {
    signalTarget.prependListener(signal, handler);
  }
  const onInput = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.includes(0x03)) {
      finishInterruption({ kind: "interrupted", signal: "SIGINT" });
    } else if (bytes.includes(0x1a)) {
      finishInterruption({ kind: "interrupted", signal: "SIGTSTP" });
    }
  };
  if (input?.isTTY) input.prependListener("data", onInput);
  try {
    onReady(session.ready);
    const outcome: Interruption | ({ kind: "exited" } & ChildExit) =
      await Promise.race([
        interruption,
        session.wait().then((exit) => ({ kind: "exited" as const, ...exit })),
      ]);
    if (outcome.kind === "exited") {
      const diagnostics = session.diagnostics?.() ?? {};
      throw new Error(
        `Application exited before the sandbox was closed (${summarizeProjectCommandFailure(
          {
            status: outcome.status,
            signal: outcome.signal,
            stdoutByteCount: diagnostics.stdoutBytes ?? 0,
            stderrByteCount: diagnostics.stderrBytes ?? 0,
          },
        )}).`,
      );
    }
    return Object.freeze({
      signal: outcome.signal,
      diagnostics: session.diagnostics?.() ?? {
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    });
  } finally {
    try {
      // npm can forward the terminal's SIGINT after the CLI receives it.
      // Keep our handlers installed until the owned process group is fully
      // stopped so a duplicate signal cannot terminate Rehearsal mid-cleanup.
      await session.stop();
    } finally {
      for (const [signal, handler] of handlers) {
        signalTarget.removeListener(signal, handler);
      }
      if (input?.isTTY) input.removeListener("data", onInput);
    }
  }
};

const valueAtPath = (value: unknown, path: readonly string[]): unknown => {
  let current: unknown = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const runHttpProofs = async ({
  checks,
  fetchImplementation = fetch,
}: {
  checks: readonly HttpProofCheck[];
  fetchImplementation?: typeof fetch;
}): Promise<
  readonly Readonly<{
    name: string;
    kind: "positive" | "negative";
    status: number;
  }>[]
> => {
  if (!Array.isArray(checks) || checks.length < 2) {
    throw new Error(
      "HTTP proof requires explicit positive and negative checks.",
    );
  }
  if (
    !checks.some((check) => check.kind === "positive") ||
    !checks.some((check) => check.kind === "negative")
  ) {
    throw new Error(
      "HTTP proof requires at least one positive and one negative check.",
    );
  }
  const results: Array<{
    name: string;
    kind: "positive" | "negative";
    status: number;
  }> = [];
  for (const check of checks) {
    if (!isLoopbackUrl(check.url))
      throw new Error(`HTTP proof ${check.name} is not local.`);
    const response = await fetchImplementation(check.url, {
      method: check.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(check.timeoutMs ?? 5_000),
    });
    if (response.status !== check.expectedStatus) {
      throw new Error(
        `HTTP proof ${check.name} expected status ${check.expectedStatus} but received ${response.status}.`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 1024 * 1024)
      throw new Error(`HTTP proof ${check.name} returned too much data.`);
    if (check.json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error(`HTTP proof ${check.name} did not return JSON.`);
      }
      const actual = valueAtPath(parsed, check.json.path);
      if (
        Object.hasOwn(check.json, "equals") &&
        !Object.is(actual, check.json.equals)
      ) {
        throw new Error(
          `HTTP proof ${check.name} did not return its required value.`,
        );
      }
      if (
        Object.hasOwn(check.json, "notEquals") &&
        Object.is(actual, check.json.notEquals)
      ) {
        throw new Error(`HTTP proof ${check.name} returned a forbidden value.`);
      }
      if (
        check.json.minimumItems !== undefined &&
        (!Array.isArray(actual) || actual.length < check.json.minimumItems)
      ) {
        throw new Error(
          `HTTP proof ${check.name} returned too few matching items.`,
        );
      }
    }
    results.push({
      name: check.name,
      kind: check.kind,
      status: response.status,
    });
  }
  return Object.freeze(results);
};
