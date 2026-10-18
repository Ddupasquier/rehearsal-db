/** Consent and reminders belong to the interactive guide, never machine commands. */
import type { TerminalFlags } from "./terminal.mjs";
import { isAbsolute } from "node:path";
import { promptForChoice } from "./terminal.mjs";
import { REHEARSAL_VERSION } from "../shared/diagnostics.mjs";
import {
  UPDATE_DAY,
  checkCoreUpdate,
  coreUpdateCommand,
  defaultUpdateDirectory,
  readUpdatePreference,
  saveUpdatePreference,
} from "./update_advisory.mjs";

export function createGuidedUpdates({
  projectRoot,
  installed = REHEARSAL_VERSION,
  directory: configuredDirectory,
  fetchImplementation = fetch,
  now = Date.now,
  environment = process.env,
  terminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  choose = promptForChoice,
  write = (text: string) => console.log(text),
}: {
  projectRoot: string;
  installed?: string;
  directory?: string;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  environment?: NodeJS.ProcessEnv;
  terminal?: () => boolean;
  choose?: typeof promptForChoice;
  write?: (text: string) => void;
}) {
  let opened = false;
  const directory =
    configuredDirectory ??
    environment.REHEARSAL_UPDATE_STATE_DIR ??
    defaultUpdateDirectory();
  const select = async (input: Parameters<typeof promptForChoice>[0]) => {
    try {
      return await choose(input);
    } catch (error) {
      // Node's plain readline prompt rejects on a terminal Ctrl+C. Treat only
      // that observed cancellation as an exit; unexpected prompt faults remain errors.
      if (
        error instanceof Error &&
        error.name === "AbortError" &&
        "code" in error &&
        error.code === "ABORT_ERR" &&
        error.message === "Aborted with Ctrl+C"
      )
        return undefined;
      throw error;
    }
  };
  return async (flags: TerminalFlags, manual = false): Promise<boolean> => {
    if (flags.json || !terminal() || environment.CI || environment.CODEX_CI) {
      return false;
    }
    if (environment.REHEARSAL_UPDATE_CHECK === "off") {
      if (manual)
        write(
          "Update checks are disabled in this session. No network request was made.",
        );
      return false;
    }
    if (!manual && opened) return false;
    opened = true;
    if (
      !isAbsolute(directory) ||
      directory.length > 4096 ||
      /[\x00-\x1f\x7f]/u.test(directory)
    ) {
      write(
        "Update preference location is invalid. No update check was made; local work can continue.",
      );
      return false;
    }
    const time = now();
    const preference = await readUpdatePreference(directory, time);
    let expectedPreference = { ...preference };
    let explicitConsent = false;
    const persist = async () => {
      const saved = await saveUpdatePreference(
        directory,
        preference,
        expectedPreference,
      );
      if (!saved)
        write(
          "Update preferences changed or could not be saved. Automatic checks stop here; use Check for updates for an explicit check.",
        );
      else expectedPreference = { ...preference };
      return saved;
    };
    if (
      !manual &&
      (preference.permission === "disabled" ||
        (preference.lastCheckAt !== null &&
          time - preference.lastCheckAt < UPDATE_DAY) ||
        (preference.lastPromptAt !== null &&
          time - preference.lastPromptAt < UPDATE_DAY))
    )
      return false;
    if (manual || preference.permission !== "enabled") {
      const consent = await select({
        message: "Check npm for Rehearsal updates?",
        flags,
        options: [
          { label: "Not now", command: "later" },
          {
            label: "Check once",
            command: "once",
            hint: "Contacts registry.npmjs.org; no project data or credentials are sent",
          },
          {
            label: "Check and remind me daily",
            command: "enable",
            hint: "Only when opening this interactive guide",
          },
          { label: "Disable reminders", command: "disable" },
        ],
      });
      preference.lastPromptAt = time;
      if (!consent) return true;
      if (consent.command === "later") {
        await persist();
        return false;
      }
      if (consent.command === "disable") {
        preference.permission = "disabled";
        await persist();
        return false;
      }
      if (!["once", "enable"].includes(consent.command ?? "")) return false;
      explicitConsent = true;
      if (consent.command === "enable") preference.permission = "enabled";
    }
    preference.lastCheckAt = time;
    if (!(await persist()) && !explicitConsent) return false;
    write("Checking the published Rehearsal release…");
    const release = await checkCoreUpdate({ installed, fetchImplementation });
    if (release.state === "unavailable") {
      write(
        "Update information is unavailable. Continue normally; Check for updates can retry later.",
      );
      return false;
    }
    if (release.state !== "available") {
      if (manual)
        write(
          `Installed core ${installed}; published ${release.channel} release ${release.version}. ${release.state === "ahead" ? "Your installation is newer; it will not be downgraded." : "No newer release is available on this channel."}`,
        );
      return false;
    }
    if (!manual && preference.skippedVersion === release.version) return false;
    const command = await coreUpdateCommand(
      projectRoot,
      installed,
      release.version,
    );
    if (!command) {
      write(
        `Published ${release.channel} release: ${release.version}. This update requires manual compatibility or installation-origin review; preserve reviewed artifacts and follow your project's update instructions.`,
      );
      return false;
    }
    const decision = await select({
      message: `Core update available: ${installed} → ${release.version} (${release.channel})`,
      flags,
      options: [
        { label: "Not now", command: "later" },
        {
          label: "Show update command and exit",
          command: "update",
          hint: "Review compatibility; nothing installs automatically",
        },
        { label: "Skip this release", command: "skip" },
        { label: "Disable reminders", command: "disable" },
      ],
    });
    if (!decision) return true;
    preference.lastPromptAt = time;
    if (decision?.command === "skip")
      preference.skippedVersion = release.version;
    if (decision?.command === "disable") preference.permission = "disabled";
    await persist();
    if (decision?.command !== "update") return false;
    write(
      `\nCore ${installed} → ${release.version} (${release.channel})\nReview release compatibility: https://github.com/Ddupasquier/rehearsal-db/releases/tag/v${release.version}\nAfter this guide exits, run:\n  ${command}\nThis pins the reviewed version and changes the project manifest, lockfile and dependencies. Rehearsal has not installed anything. Review the dependency diff afterward.\n`,
    );
    return true;
  };
}
