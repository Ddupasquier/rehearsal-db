/** Terminal presentation and prompt primitives shared by guided CLI workflows. */

import { createInterface } from "node:readline/promises";
import * as prompts from "@clack/prompts";

export interface TerminalFlags {
  readonly plain?: boolean;
  readonly json?: boolean;
}

export interface ChoiceOption<Value = unknown> {
  readonly label: string;
  readonly hint?: string;
  readonly command?: string;
  readonly value?: Value;
}

interface ValueChoiceOption<Value> extends ChoiceOption<Value> {
  readonly value: Value;
}

type PathValidator = (value: string) => string | undefined;

const useColor = (flags: TerminalFlags): boolean =>
  !flags.plain &&
  process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

export const terminalStyle = (
  flags: TerminalFlags,
  code: string,
  value: string,
): string => (useColor(flags) ? `\u001B[${code}m${value}\u001B[0m` : value);

export const isHumanTerminal = (flags: TerminalFlags): boolean =>
  !flags.json && process.stdin.isTTY && process.stdout.isTTY;

export const useStyledPrompts = (flags: TerminalFlags): boolean =>
  isHumanTerminal(flags) && useColor(flags);

export const formatDuration = (durationMs: number): string =>
  durationMs < 1_000
    ? `${Math.round(durationMs)}ms`
    : `${(durationMs / 1_000).toFixed(1)}s`;

export const promptForChoice = async <Option extends ChoiceOption>({
  message,
  options,
  flags = {},
  optionsAlreadyShown = false,
}: {
  message: string;
  options: readonly Option[];
  flags?: TerminalFlags;
  optionsAlreadyShown?: boolean;
}): Promise<Option | undefined> => {
  if (useStyledPrompts(flags)) {
    const selected = await prompts.select<number>({
      message,
      maxItems: options.length,
      options: options.map((option, index) => ({
        value: index,
        label: option.label,
        ...(option.hint === undefined ? {} : { hint: option.hint }),
      })),
    });
    return prompts.isCancel(selected)
      ? options.find((option) => option.command === "exit")
      : options[selected];
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

export function promptForConfirmation(
  message: string,
  flags: TerminalFlags,
  options: { cancelValue: null },
): Promise<boolean | null>;
export function promptForConfirmation(
  message: string,
  flags?: TerminalFlags,
  options?: { cancelValue?: boolean },
): Promise<boolean>;
export async function promptForConfirmation(
  message: string,
  flags: TerminalFlags = {},
  { cancelValue = false }: { cancelValue?: boolean | null } = {},
): Promise<boolean | null> {
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
}

export const promptForPath = async ({
  message,
  defaultValue,
  optional = false,
  flags = {},
  validate,
}: {
  message: string;
  defaultValue?: string;
  optional?: boolean;
  flags?: TerminalFlags;
  validate?: PathValidator;
}): Promise<string | undefined> => {
  if (useStyledPrompts(flags)) {
    const answer = await prompts.text({
      message,
      placeholder: defaultValue ?? (optional ? "Leave blank for none" : ""),
      ...(defaultValue === undefined ? {} : { defaultValue }),
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

export const promptForSelection = async <Value,>({
  message,
  options,
  flags = {},
}: {
  message: string;
  options: readonly ValueChoiceOption<Value>[];
  flags?: TerminalFlags;
}): Promise<Value | undefined> => {
  const selected = await promptForChoice({ message, options, flags });
  return selected?.value;
};

export const promptForDiscoveredPath = async ({
  message,
  candidates,
  optional = false,
  flags = {},
}: {
  message: string;
  candidates: readonly string[];
  optional?: boolean;
  flags?: TerminalFlags;
}): Promise<string | undefined> => {
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
  flags = {},
}: {
  message: string;
  options: readonly ValueChoiceOption<string>[];
  initialValues?: readonly string[];
  flags?: TerminalFlags;
}): Promise<string[] | undefined> => {
  if (useStyledPrompts(flags)) {
    const selected = await prompts.multiselect({
      message,
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.hint === undefined ? {} : { hint: option.hint }),
      })),
      initialValues: [...initialValues],
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
        return [...new Set(indexes)].map((index) => options[index - 1]!.value);
      }
      console.log(`Choose numbers from 1 to ${options.length}, all, or none.`);
    }
  } finally {
    prompt.close();
  }
};

export const installGuidedExitShortcut = (
  flags: TerminalFlags,
  { beforeExit }: { beforeExit?: () => void } = {},
): (() => void) => {
  let exiting = false;
  const exit = (): void => {
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
  const onInput = (chunk: string | Buffer | Uint8Array): void => {
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
