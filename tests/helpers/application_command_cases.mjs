/** Shared argv expectations exercised through both application-command consumers. */

export const applicationArgumentCases = [
  {
    name: "empty first argument",
    source: '"" before after',
    args: ["", "before", "after"],
  },
  {
    name: "empty middle argument",
    source: "before '' after",
    args: ["before", "", "after"],
  },
  {
    name: "empty last argument",
    source: 'before after ""',
    args: ["before", "after", ""],
  },
  { name: "multiple quoted empties", source: "'' \"\" ''", args: ["", "", ""] },
  { name: "adjacent empty quote fragments", source: "\"\"''", args: [""] },
  {
    name: "adjacent quoted fragments",
    source: "pre\"\"'mid'\"end\"post ''x x''",
    args: ["premidendpost", "x", "x"],
  },
  {
    name: "opposite quote characters",
    source: "\"a'b\" 'c\"d'",
    args: ["a'b", 'c"d'],
  },
  {
    name: "literal backslashes",
    source: String.raw`"C:\temp\project" C:\work\file back\slash`,
    args: [
      String.raw`C:\temp\project`,
      String.raw`C:\work\file`,
      String.raw`back\slash`,
    ],
  },
  {
    name: "backslashes before whitespace",
    source: String.raw`left\ right\\`,
    args: ["left\\", "right\\\\"],
  },
  {
    name: "backslash before a closing quote",
    source: String.raw`"before\" after`,
    args: ["before\\", "after"],
  },
  {
    name: "literal shell metacharacters",
    source: "'$HOME' '*' '|' ';' '&&' '$(echo unsafe)'",
    args: ["$HOME", "*", "|", ";", "&&", "$(echo unsafe)"],
  },
  { name: "quoted whitespace", source: "\" \" 'a b'", args: [" ", "a b"] },
  {
    name: "whitespace separators",
    source: " \tfirst\u2003second  ",
    args: ["first", "second"],
  },
];

export const invalidApplicationCommandCases = [
  { name: "empty command", source: "", error: "empty" },
  { name: "whitespace-only command", source: "   \t ", error: "empty" },
  { name: "double-quoted empty executable", source: '""', error: "empty" },
  { name: "single-quoted empty executable", source: "''", error: "empty" },
  {
    name: "empty executable before another token",
    source: '"" node',
    error: "empty",
  },
  {
    name: "adjacent empty executable fragments",
    source: "''\"\" node",
    error: "empty",
  },
  { name: "quoted whitespace executable", source: '" " node', error: "empty" },
  {
    name: "unmatched double quote",
    source: 'node "unterminated',
    error: "unmatched quote",
  },
  {
    name: "unmatched single quote",
    source: "node 'unterminated",
    error: "unmatched quote",
  },
];
