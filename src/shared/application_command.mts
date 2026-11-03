/** Parse configured application argv without shell expansion or backslash escapes. */

export const parseApplicationCommand = (
  source: string,
  label:
    "Application command" | "Application proof command" = "Application command",
): [string, ...string[]] => {
  if (typeof source !== "string" || !source.trim())
    throw new Error(`${label} is empty.`);
  const values: string[] = [];
  let value = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const character of source) {
    if (quote) {
      if (character === quote) quote = null;
      else value += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) values.push(value);
      value = "";
      started = false;
    } else {
      value += character;
      started = true;
    }
  }
  if (quote) throw new Error(`${label} contains an unmatched quote.`);
  if (started) values.push(value);
  const [program, ...args] = values;
  if (!program?.trim()) throw new Error(`${label} is empty.`);
  return [program, ...args];
};
