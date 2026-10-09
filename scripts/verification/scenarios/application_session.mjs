/** Persistent application-session checks shared by installed-consumer scenarios. */

import { spawn as spawnProcess } from "node:child_process";
import { join } from "node:path";
import { spawn as spawnTerminal } from "@lydell/node-pty";
import { createCleanProcessEnvironment } from "../../../dist/src/shared/process_environment.mjs";

const waitForReady = async ({ childExited, output, url }) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (childExited?.()) break;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && output().includes("SANDBOX READY")) return;
    } catch {
      // The runtime and application are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Persistent application did not become ready: ${output() || "no output"}`,
  );
};

const assertClosed = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    throw new Error(
      "Persistent application child remained reachable after exit.",
    );
  } catch (error) {
    if (
      error?.message ===
      "Persistent application child remained reachable after exit."
    ) {
      throw error;
    }
  }
};

const assertShutdownReceipt = (output) => {
  if (
    !output.includes("Application stopped after SIGINT.") ||
    !output.includes("database and Storage changes were preserved")
  ) {
    throw new Error(
      `Persistent application shutdown receipt is invalid: ${output}`,
    );
  }
};

export const openApplicationSession = async ({ cwd, url, whileReady }) => {
  const child = spawnProcess(
    join(cwd, "node_modules/.bin/rehearsal"),
    ["open", "--plain"],
    {
      cwd,
      env: createCleanProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve) =>
    child.once("exit", (status, signal) => resolve({ status, signal })),
  );
  try {
    await waitForReady({
      childExited: () => child.exitCode !== null,
      output: () => stdout || stderr,
      url,
    });
    await whileReady?.();
  } catch (error) {
    child.kill("SIGTERM");
    await exit;
    throw error;
  } finally {
    if (child.exitCode === null) child.kill("SIGINT");
  }
  const ended = await exit;
  if (ended.status !== 0) {
    throw new Error(
      `Persistent application session failed: ${stdout || stderr || `exit ${ended.status ?? ended.signal}`}`,
    );
  }
  if (!stdout.includes(`Application: ${url}`)) {
    throw new Error(`Persistent application URL receipt is invalid: ${stdout}`);
  }
  assertShutdownReceipt(stdout);
  await assertClosed(url);
  return stdout;
};

export const openApplicationTerminalSession = async ({ cwd, url }) => {
  const terminal = spawnTerminal(
    "npx",
    ["--no-install", "rehearsal", "open", "--plain"],
    {
      name: "xterm-256color",
      cols: 100,
      rows: 40,
      cwd,
      env: createCleanProcessEnvironment(),
    },
  );
  let output = "";
  terminal.onData((chunk) => {
    output += chunk;
  });
  const exit = new Promise((resolve) => terminal.onExit(resolve));
  try {
    await waitForReady({ output: () => output, url });
  } catch (error) {
    terminal.kill();
    await exit;
    throw error;
  }
  terminal.write("\u0003");
  let exitTimeout;
  const ended = await Promise.race([
    exit,
    new Promise((_, reject) => {
      exitTimeout = setTimeout(
        () => reject(new Error(`Terminal Ctrl+C timed out: ${output}`)),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(exitTimeout));
  if (ended.exitCode !== 0) {
    throw new Error(
      `Terminal Ctrl+C exited ${ended.exitCode}: ${output || "no output"}`,
    );
  }
  assertShutdownReceipt(output);
  await assertClosed(url);
  return output;
};

const waitForTerminalText = async ({
  output,
  childExited,
  text,
  timeoutMs = 30_000,
}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes(text)) return;
    if (childExited()) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Interactive identity connection did not reach ${text}: ${output() || "no output"}`,
  );
};

export const connectIdentityTerminalSession = async ({
  cwd,
  url,
  environment,
  alreadyConnected = false,
  confirm = true,
}) => {
  const terminal = spawnTerminal(
    "npx",
    [
      "--no-install",
      "rehearsal",
      "identity",
      "connect",
      "--identity=approved-owner",
      "--plain",
    ],
    {
      name: "xterm-256color",
      cols: 110,
      rows: 40,
      cwd,
      env: createCleanProcessEnvironment({ overrides: environment }),
    },
  );
  let output = "";
  let exited = false;
  terminal.onData((chunk) => {
    output += chunk;
  });
  const exit = new Promise((resolve) =>
    terminal.onExit((result) => {
      exited = true;
      resolve(result);
    }),
  );
  try {
    if (alreadyConnected) {
      await waitForTerminalText({
        output: () => output,
        childExited: () => exited,
        text: "COPIED ACCOUNT — ALREADY CONNECTED",
        timeoutMs: 60_000,
      });
    } else {
      await waitForTerminalText({
        output: () => output,
        childExited: () => exited,
        text: "Connect my copied account using exactly this plan? (y/N)",
        timeoutMs: 60_000,
      });
      terminal.write(confirm ? "y\r" : "n\r");
      await waitForTerminalText({
        output: () => output,
        childExited: () => exited,
        text: confirm
          ? "COPIED ACCOUNT — CONNECTED"
          : "COPIED ACCOUNT — CANCELLED",
        timeoutMs: 90_000,
      });
    }
    if (!confirm) {
      const ended = await exit;
      if (ended.exitCode !== 0 || !output.includes("Nothing was changed")) {
        throw new Error(
          `Declined identity connection was unsafe: ${output || `exit ${ended.exitCode}`}`,
        );
      }
      await assertClosed(url);
      return output;
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (response.status !== 200) {
      throw new Error(
        `Connected application returned HTTP ${response.status}.`,
      );
    }
  } catch (error) {
    terminal.kill();
    await exit;
    throw error;
  }
  terminal.write("\u0003");
  let exitTimeout;
  const ended = await Promise.race([
    exit,
    new Promise((_, reject) => {
      exitTimeout = setTimeout(
        () =>
          reject(new Error(`Identity connection Ctrl+C timed out: ${output}`)),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(exitTimeout));
  if (ended.exitCode !== 0) {
    throw new Error(
      `Interactive identity connection exited ${ended.exitCode}: ${output || "no output"}`,
    );
  }
  await assertClosed(url);
  return output;
};

export const cancelIdentityTerminalSession = async ({
  cwd,
  url,
  environment,
  control = "z",
}) => {
  const terminal = spawnTerminal(
    "npx",
    [
      "--no-install",
      "rehearsal",
      "identity",
      "connect",
      "--identity=approved-owner",
      "--plain",
    ],
    {
      name: "xterm-256color",
      cols: 110,
      rows: 40,
      cwd,
      env: createCleanProcessEnvironment({ overrides: environment }),
    },
  );
  let output = "";
  let exited = false;
  terminal.onData((chunk) => {
    output += chunk;
  });
  const exit = new Promise((resolve) =>
    terminal.onExit((result) => {
      exited = true;
      resolve(result);
    }),
  );
  try {
    await waitForTerminalText({
      output: () => output,
      childExited: () => exited,
      text: "SIGN IN TO THE SANDBOX",
      timeoutMs: 60_000,
    });
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (response.status !== 200) {
      throw new Error(
        `Identity connection application returned HTTP ${response.status}.`,
      );
    }
  } catch (error) {
    terminal.kill();
    await exit;
    throw error;
  }
  terminal.write(control === "c" ? "\u0003" : "\u001a");
  let exitTimeout;
  const ended = await Promise.race([
    exit,
    new Promise((_, reject) => {
      exitTimeout = setTimeout(
        () =>
          reject(
            new Error(`Identity connection cancellation timed out: ${output}`),
          ),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(exitTimeout));
  if (
    ended.exitCode !== 0 ||
    !output.includes("COPIED ACCOUNT CONNECTION CANCELLED") ||
    !output.includes("Nothing was changed")
  ) {
    throw new Error(
      `Interactive identity cancellation was unsafe: ${output || `exit ${ended.exitCode}`}`,
    );
  }
  await assertClosed(url);
  return output;
};
