/** Launch ordinary application commands against verified local runtime files. */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  createCleanProcessEnvironment,
  isLoopbackUrl,
} from "../shared/process_environment.mjs";

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/u;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

const parseCommand = (source) => {
  if (typeof source !== "string" || !source.trim())
    throw new Error("Application command is empty.");
  const values = [];
  let value = "";
  let quote = null;
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
  return values;
};

const readOwnedEnvironment = async (path) => {
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new Error(
      "Runtime environment file must be an owner-only regular file.",
    );
  }
  return parseEnv(await readFile(path, "utf8"));
};

const assertLocalValue = (key, value) => {
  if (/(_URL|_URI|_ENDPOINT)$/u.test(key)) {
    let parsed;
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

export const buildApplicationEnvironment = async ({ files, mappings }) => {
  if (!files?.primary)
    throw new Error("Primary runtime environment file is required.");
  const environments = {};
  for (const [name, path] of Object.entries(files)) {
    environments[name] = await readOwnedEnvironment(path);
  }
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throw new Error("Application environment mappings must be an object.");
  }
  const result = {};
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
    if (!ENV_KEY.test(source) || !environments[target]?.[source]) {
      throw new Error(
        `Application mapping ${destination} references a missing runtime value.`,
      );
    }
    assertLocalValue(source, environments[target][source]);
    result[destination] = environments[target][source];
  }
  return result;
};

const boundedAppend = (current, chunk) =>
  `${current}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);

export const summarizeProjectCommandFailure = ({
  error,
  status,
  stdout = "",
  stderr = "",
}) => {
  const stdoutBytes = Buffer.byteLength(String(stdout));
  const stderrBytes = Buffer.byteLength(String(stderr));
  if (error) {
    const code = /^[A-Z0-9_]+$/u.test(error.code ?? "")
      ? ` (${error.code})`
      : "";
    return `command could not start${code}; output withheld`;
  }
  return `exit ${Number.isInteger(status) ? status : "unknown"}; stdout ${stdoutBytes} bytes; stderr ${stderrBytes} bytes; output withheld`;
};

const waitForReadiness = async ({ readiness, fetchImplementation, child }) => {
  if (!readiness || !isLoopbackUrl(readiness.url)) {
    throw new Error("Application readiness must use a loopback URL.");
  }
  const expected = readiness.expectedStatus ?? 200;
  const deadline = Date.now() + (readiness.timeoutSeconds ?? 30) * 1_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
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

const stopOwnedChild = async (child) => {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return;
  const kill = (signal) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (!exited()) {
    kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
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
}) => {
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
  child.stdout?.on("data", (chunk) => {
    stdout = boundedAppend(stdout, chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk) => {
    stderr = boundedAppend(stderr, chunk.toString("utf8"));
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    const ready = await waitForReadiness({
      readiness,
      fetchImplementation,
      child,
    });
    return Object.freeze({
      pid: child.pid,
      ready,
      stop: () => stopOwnedChild(child),
      diagnostics: () => ({
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      }),
    });
  } catch (error) {
    await stopOwnedChild(child);
    throw error;
  }
};

const valueAtPath = (value, path) => {
  let current = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

export const runHttpProofs = async ({
  checks,
  fetchImplementation = fetch,
}) => {
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
  const results = [];
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
      let parsed;
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
