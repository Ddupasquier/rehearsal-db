/** Terminal presentation and prompt primitives shared by guided CLI workflows. */

import { createInterface } from "node:readline/promises";
import * as prompts from "@clack/prompts";

const useColor = (flags) =>
  !flags.plain &&
  process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

export const terminalStyle = (flags, code, value) =>
  useColor(flags) ? `\u001B[${code}m${value}\u001B[0m` : value;

export const isHumanTerminal = (flags) =>
  !flags.json && process.stdin.isTTY && process.stdout.isTTY;

export const useStyledPrompts = (flags) =>
  isHumanTerminal(flags) && useColor(flags);

export const formatDuration = (durationMs) =>
  durationMs < 1_000
    ? `${Math.round(durationMs)}ms`
    : `${(durationMs / 1_000).toFixed(1)}s`;

export const promptForChoice = async ({
  message,
  options,
  flags = {},
  optionsAlreadyShown = false,
}) => {
  if (useStyledPrompts(flags)) {
    const selected = await prompts.select({
      message,
      maxItems: options.length,
      options: options.map((option) => ({
        value: option,
        label: option.label,
        hint: option.hint,
      })),
    });
    return prompts.isCancel(selected)
      ? options.find((option) => option.command === "exit")
      : selected;
  }
  if (!optionsAlreadyShown) {
    console.log(
      [
        "",
        ...options.map(
          (option, index) =>
            `  ${index === 0 ? "›" : " "} ${index + 1}. ${option.label}${option.hint ? ` — ${option.hint}` : ""}`,
        ),
        "",
      ].join("\n"),
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const answer = (await prompt.question(`${message} [1]: `)).trim();
      const selected = answer === "" ? 1 : Number(answer);
      if (
        Number.isInteger(selected) &&
        selected >= 1 &&
        selected <= options.length
      ) {
        return options[selected - 1];
      }
      console.log(`Choose a number from 1 to ${options.length}.`);
    }
  } finally {
    prompt.close();
  }
};

export const promptForConfirmation = async (
  message,
  flags = {},
  { cancelValue = false } = {},
) => {
  if (useStyledPrompts(flags)) {
    const accepted = await prompts.confirm({ message, initialValue: false });
    return prompts.isCancel(accepted) ? cancelValue : accepted;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await prompt.question(`${message} (y/N) `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
};

export const promptForPath = async ({
  message,
  defaultValue,
  optional = false,
  flags = {},
  validate,
}) => {
  if (useStyledPrompts(flags)) {
    const answer = await prompts.text({
      message,
      placeholder: defaultValue ?? (optional ? "Leave blank for none" : ""),
      defaultValue,
      validate: (value) => {
        const resolved = String(value || defaultValue || "").trim();
        if (!optional && !resolved) return "Enter a value.";
        return resolved && validate ? validate(resolved) : undefined;
      },
    });
    if (prompts.isCancel(answer)) return undefined;
    return String(answer || defaultValue || "").trim() || undefined;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const suffix = defaultValue
        ? ` [${defaultValue}]`
        : optional
          ? ""
          : " (required)";
      const answer = (await prompt.question(`${message}${suffix}: `)).trim();
      const value = answer || defaultValue || "";
      const invalid = value && validate ? validate(value) : undefined;
      if (invalid) {
        console.log(invalid);
        continue;
      }
      if (value || optional) return value || undefined;
      console.log("Enter a project-relative path.");
    }
  } finally {
    prompt.close();
  }
};

export const promptForSelection = async ({ message, options, flags }) => {
  const selected = await promptForChoice({ message, options, flags });
  return selected?.value;
};

export const promptForDiscoveredPath = async ({
  message,
  candidates,
  optional = false,
  flags,
}) => {
  if (candidates.length === 0)
    return promptForPath({ message, optional, flags });
  const noneValue = "\0none";
  const manualValue = "\0manual";
  const selected = await promptForSelection({
    message,
    flags,
    options: [
      ...(optional
        ? [
            {
              label: "No storage assets",
              hint: "Continue without an asset manifest",
              value: noneValue,
            },
          ]
        : []),
      ...candidates.map((path) => ({ label: path, value: path })),
      { label: "Enter another path", value: manualValue },
    ],
  });
  if (!selected || selected === noneValue) return undefined;
  if (selected !== manualValue) return selected;
  return promptForPath({ message, optional, flags });
};

export const promptForMultipleChoice = async ({
  message,
  options,
  initialValues = [],
  flags,
}) => {
  if (useStyledPrompts(flags)) {
    const selected = await prompts.multiselect({
      message,
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
        hint: option.hint,
      })),
      initialValues,
      required: false,
    });
    return prompts.isCancel(selected) ? undefined : selected;
  }
  const initial = new Set(initialValues);
  console.log("");
  console.log(message);
  for (const [index, option] of options.entries()) {
    console.log(
      `  ${index + 1}. ${option.label}${initial.has(option.value) ? " (suggested)" : ""}`,
    );
  }
  const defaultNumbers = options
    .map((option, index) => (initial.has(option.value) ? index + 1 : undefined))
    .filter(Boolean)
    .join(",");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const suffix = defaultNumbers ? ` [${defaultNumbers}]` : " [none]";
      const answer = (
        await prompt.question(
          `Choose comma-separated numbers, all, or none${suffix}: `,
        )
      )
        .trim()
        .toLowerCase();
      if (!answer) return [...initialValues];
      if (answer === "none") return [];
      if (answer === "all") return options.map((option) => option.value);
      const indexes = answer.split(",").map((value) => Number(value.trim()));
      if (
        indexes.length > 0 &&
        indexes.every(
          (index) =>
            Number.isInteger(index) && index >= 1 && index <= options.length,
        )
      ) {
        return [...new Set(indexes)].map((index) => options[index - 1].value);
      }
      console.log(`Choose numbers from 1 to ${options.length}, all, or none.`);
    }
  } finally {
    prompt.close();
  }
};

export const installGuidedExitShortcut = (flags, { beforeExit } = {}) => {
  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    if (process.stdin.isTTY && process.stdin.isRaw)
      process.stdin.setRawMode(false);
    beforeExit?.();
    process.stdout.write("\u001B[?25h");
    if (useStyledPrompts(flags)) prompts.outro("Rehearsal exited.");
    else console.log("\nRehearsal exited.");
    process.exit(0);
  };
  const onInput = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.includes(0x1a)) exit();
  };
  process.stdin.prependListener("data", onInput);
  process.prependListener("SIGTSTP", exit);
  return () => {
    process.stdin.removeListener("data", onInput);
    process.removeListener("SIGTSTP", exit);
  };
};
