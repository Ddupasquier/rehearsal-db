/** Best-effort human-terminal advisory; never installs or writes update state. */
import { isAbsolute } from "node:path";
import { REHEARSAL_VERSION } from "../shared/diagnostics.mjs";
import {
  checkCoreUpdate,
  coreUpdateCommand,
  defaultUpdateDirectory,
  readUpdatePreference,
} from "./update_advisory.mjs";

export async function notifyStartupUpdate({
  projectRoot,
  flags,
  command,
  guided,
  installed = REHEARSAL_VERSION,
  environment = process.env,
  terminal = Boolean(
    process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY,
  ),
  fetchImplementation = fetch,
  write = (text: string) => console.error(text),
}: {
  projectRoot: string;
  flags: { json?: boolean; help?: boolean; version?: boolean };
  command: string;
  guided: boolean;
  installed?: string;
  environment?: NodeJS.ProcessEnv;
  terminal?: boolean;
  fetchImplementation?: typeof fetch;
  write?: (text: string) => void;
}): Promise<void> {
  // Help/version remain deterministic; urgent shutdown must never wait on npm.
  // The guide owns its existing explicit consent and reminder flow.
  if (
    guided ||
    flags.json ||
    flags.help ||
    flags.version ||
    !terminal ||
    environment.CI ||
    environment.CODEX_CI ||
    environment.REHEARSAL_UPDATE_CHECK === "off" ||
    ["help", "version", "engine stop", "stop", "stop-stale"].includes(command)
  )
    return;
  try {
    const directory =
      environment.REHEARSAL_UPDATE_STATE_DIR ?? defaultUpdateDirectory();
    if (
      !isAbsolute(directory) ||
      directory.length > 4096 ||
      /[\x00-\x1f\x7f]/u.test(directory)
    )
      return;
    const preference = await readUpdatePreference(directory, Date.now());
    if (preference.permission === "disabled") return;
    const release = await checkCoreUpdate({
      installed,
      fetchImplementation,
      timeoutMs: 750,
    });
    if (
      release.state !== "available" ||
      preference.skippedVersion === release.version
    )
      return;
    const command = await coreUpdateCommand(
      projectRoot,
      installed,
      release.version,
    );
    write(
      `Rehearsal update available: ${installed} → ${release.version}.\n` +
        (command
          ? `After this command finishes, update with: ${command}`
          : "Review compatibility and installation instructions: https://ddupasquier.github.io/rehearsal-db/updating.html"),
    );
  } catch {
    // Network, preference and advisory failures cannot fail the user's command.
  }
}
