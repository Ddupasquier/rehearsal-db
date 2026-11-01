/** Bounded PostgreSQL lexical input, not a SQL parser or validator. */
export type ScanUnknownReason =
  "unsupported_sql" | "malformed_sql" | "input_limit";

export interface SqlToken {
  kind: "word" | "identifier" | "literal" | "symbol";
  value: string;
  line: number;
  column: number;
  depth: number;
}

const maxBytes = 2 * 1024 * 1024;
const maxTokens = 20_000;
const maxDepth = 128;
const wordStart = (character: string): boolean =>
  /[A-Za-z_]/u.test(character) || character.charCodeAt(0) >= 128;
const wordPart = (character: string): boolean =>
  wordStart(character) || /[0-9$]/u.test(character);

export const lexMigrationSql = (
  source: string,
): {
  tokens: SqlToken[];
  unknownReasons: ScanUnknownReason[];
  ambiguousQuotes: boolean;
} => {
  const tokens: SqlToken[] = [];
  const reasons = new Set<ScanUnknownReason>();
  if (Buffer.byteLength(source, "utf8") > maxBytes)
    return { tokens, unknownReasons: ["input_limit"], ambiguousQuotes: false };
  if (source.includes("\0")) reasons.add("malformed_sql");
  let ambiguousQuotes = false;
  let offset = 0;
  let line = 1;
  let column = 1;
  const groups: string[] = [];
  const advance = (end: number): void => {
    while (offset < end) {
      const character = source[offset++]!;
      if (character === "\r") {
        if (source[offset] === "\n" && offset < end) offset += 1;
        line += 1;
        column = 1;
      } else if (character === "\n") {
        line += 1;
        column = 1;
      } else column += 1;
    }
  };
  const emit = (
    kind: SqlToken["kind"],
    value: string,
    end: number,
    depth = groups.length,
  ): boolean => {
    if (tokens.length >= maxTokens) {
      reasons.add("input_limit");
      return false;
    }
    tokens.push({ kind, value, line, column, depth });
    advance(end);
    return true;
  };
  const quoted = (start: number, quote: string, escapes: boolean): number => {
    let cursor = start + 1;
    while (cursor < source.length) {
      if (source[cursor] === "\0") reasons.add("malformed_sql");
      if (source[cursor] === "\\") {
        // Plain strings depend on standard_conforming_strings, which is not read.
        if (quote === "'" && !escapes) {
          reasons.add("unsupported_sql");
          ambiguousQuotes = true;
        }
        if (escapes) {
          cursor += 2;
          continue;
        }
      }
      if (source[cursor] === quote) {
        if (source[cursor + 1] === quote) cursor += 2;
        else return cursor + 1;
      } else cursor += 1;
    }
    reasons.add("malformed_sql");
    return source.length;
  };

  while (offset < source.length) {
    const character = source[offset]!;
    if (/[ \t\n\r\f\v]/u.test(character)) {
      // Consume CRLF together so editor positions count a single newline.
      advance(
        offset + (character === "\r" && source[offset + 1] === "\n" ? 2 : 1),
      );
      continue;
    }
    if (source.startsWith("--", offset)) {
      let end = offset + 2;
      while (end < source.length && !/[\r\n]/u.test(source[end]!)) end += 1;
      advance(end);
      continue;
    }
    if (source.startsWith("/*", offset)) {
      let nested = 1;
      let cursor = offset + 2;
      while (cursor < source.length && nested > 0) {
        if (source.startsWith("/*", cursor)) {
          nested += 1;
          cursor += 2;
          if (nested > maxDepth) break;
        } else if (source.startsWith("*/", cursor)) {
          nested -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      if (nested > maxDepth) {
        reasons.add("input_limit");
        break;
      }
      if (nested > 0) reasons.add("malformed_sql");
      advance(cursor);
      continue;
    }
    if (source.startsWith("*/", offset) || character === "\0") {
      reasons.add("malformed_sql");
      break;
    }
    if (
      (character === "E" || character === "e") &&
      source[offset + 1] === "'"
    ) {
      if (!emit("literal", "", quoted(offset + 1, "'", true))) break;
      continue;
    }
    if (character === "'" || character === '"') {
      const end = quoted(offset, character, false);
      if (character === '"' && end === offset + 2) reasons.add("malformed_sql");
      if (!emit(character === "'" ? "literal" : "identifier", "", end)) break;
      continue;
    }
    if (character === "$") {
      let tagEnd = offset + 1;
      if (wordStart(source[tagEnd] ?? "")) {
        tagEnd += 1;
        while (
          tagEnd < source.length &&
          (wordStart(source[tagEnd]!) || /[0-9]/u.test(source[tagEnd]!))
        )
          tagEnd += 1;
      }
      if (source[tagEnd] === "$") {
        const delimiter = source.slice(offset, tagEnd + 1);
        const close = source.indexOf(delimiter, tagEnd + 1);
        if (close < 0) reasons.add("malformed_sql");
        if (
          !emit(
            "literal",
            "",
            close < 0 ? source.length : close + delimiter.length,
          )
        )
          break;
        continue;
      }
      let parameterEnd = offset + 1;
      while (/[0-9]/u.test(source[parameterEnd] ?? "")) parameterEnd += 1;
      if (parameterEnd > offset + 1) {
        if (!emit("literal", "", parameterEnd)) break;
        continue;
      }
      reasons.add("unsupported_sql");
    }
    if (wordStart(character)) {
      let end = offset + 1;
      while (end < source.length && wordPart(source[end]!)) end += 1;
      if (!emit("word", source.slice(offset, end).toUpperCase(), end)) break;
      continue;
    }
    if (/[0-9]/u.test(character)) {
      let end = offset + 1;
      while (end < source.length && /[0-9A-Za-z_.]/u.test(source[end]!))
        end += 1;
      if (!emit("literal", "", end)) break;
      continue;
    }
    if (character === "(" || character === "[") {
      if (groups.length >= maxDepth) {
        reasons.add("input_limit");
        break;
      }
      if (!emit("symbol", character, offset + 1)) break;
      groups.push(character);
    } else if (character === ")" || character === "]") {
      if (groups.pop() !== (character === ")" ? "(" : "[")) {
        reasons.add("malformed_sql");
        break;
      }
      if (!emit("symbol", character, offset + 1)) break;
    } else {
      if (character === ";" && groups.length > 0) reasons.add("malformed_sql");
      if (
        character === "\\" ||
        character === "`" ||
        character.charCodeAt(0) < 32
      )
        reasons.add("unsupported_sql");
      if (!emit("symbol", character, offset + 1)) break;
    }
  }
  if (groups.length > 0) reasons.add("malformed_sql");
  return { tokens, unknownReasons: [...reasons], ambiguousQuotes };
};
