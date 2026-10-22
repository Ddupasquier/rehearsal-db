import {
  lexMigrationSql,
  type ScanUnknownReason,
  type SqlToken,
} from "./migration_sql_lexer.mjs";

export type MigrationSqlRule =
  | "drop_table"
  | "drop_column"
  | "truncate"
  | "broad_update"
  | "broad_delete"
  | "not_null"
  | "new_constraint"
  | "cascade";
export interface MigrationSqlFinding {
  rule: MigrationSqlRule;
  severity: "warning" | "danger";
  line: number;
  column: number;
}
export interface MigrationSqlScan {
  /** Complete bounded lexical/rule coverage, never SQL validity or a safe verdict. */
  complete: boolean;
  findings: MigrationSqlFinding[];
  unknownReasons: ScanUnknownReason[];
}

const word = (token: SqlToken | undefined, value: string): boolean =>
  token?.kind === "word" && token.value === value;
const name = (token: SqlToken | undefined): boolean =>
  token?.kind === "word" || token?.kind === "identifier";
const qualifiedNameEnd = (tokens: SqlToken[], start: number): number => {
  if (!name(tokens[start])) return start;
  let end = start + 1;
  while (tokens[end]?.value === "." && name(tokens[end + 1])) end += 2;
  return end;
};
const topTokens = (tokens: SqlToken[], depth: number): SqlToken[] =>
  tokens.filter((token) => token.depth === depth);

/** Static, local-only review hints. Never executes SQL or returns input text. */
export const scanMigrationSql = (source: string): MigrationSqlScan => {
  const lexical = lexMigrationSql(source);
  const reasons = new Set<ScanUnknownReason>(lexical.unknownReasons);
  // Runtime-dependent plain-string escape settings can change statement boundaries.
  if (lexical.ambiguousQuotes)
    return {
      complete: false,
      findings: [],
      unknownReasons: [...reasons].sort(),
    };
  const findings: MigrationSqlFinding[] = [];
  const findingKeys = new Set<string>();
  const add = (rule: MigrationSqlRule, token: SqlToken): void => {
    const key = `${rule}:${token.line}:${token.column}`;
    if (findingKeys.has(key)) return;
    if (findings.length >= 1000) {
      reasons.add("input_limit");
      return;
    }
    findingKeys.add(key);
    findings.push({
      rule,
      severity: ["not_null", "new_constraint"].includes(rule)
        ? "warning"
        : "danger",
      line: token.line,
      column: token.column,
    });
  };
  const unsupported = (): void => {
    reasons.add("unsupported_sql");
  };
  const malformed = (): void => {
    reasons.add("malformed_sql");
  };
  const cascade = (tokens: SqlToken[], trailing = true): void => {
    const last = tokens.at(-1);
    if (trailing && word(last, "CASCADE")) add("cascade", last!);
    for (let index = 2; index < tokens.length; index += 1)
      if (
        word(tokens[index], "CASCADE") &&
        (word(tokens[index - 1], "DELETE") ||
          word(tokens[index - 1], "UPDATE")) &&
        word(tokens[index - 2], "ON")
      )
        add("cascade", tokens[index]!);
  };
  const relationList = (tokens: SqlToken[], start: number): boolean => {
    if (start >= tokens.length) return false;
    let index = start;
    while (index < tokens.length) {
      if (word(tokens[index], "ONLY")) index += 1;
      const end = qualifiedNameEnd(tokens, index);
      if (end === index) return false;
      index = end;
      if (tokens[index]?.value === "*") index += 1;
      if (tokens[index]?.value !== ",") break;
      index += 1;
      if (index === tokens.length) return false;
    }
    if (
      (word(tokens[index], "RESTART") || word(tokens[index], "CONTINUE")) &&
      word(tokens[index + 1], "IDENTITY")
    )
      index += 2;
    if (word(tokens[index], "CASCADE") || word(tokens[index], "RESTRICT"))
      index += 1;
    return index === tokens.length;
  };

  const analyze = (tokens: SqlToken[], depth: number): void => {
    if (tokens.length === 0) return;
    const top = topTokens(tokens, depth);
    const first = top[0];
    if (!first || first.kind !== "word") {
      unsupported();
      return;
    }
    if (word(first, "WITH")) {
      let index = 1;
      if (word(tokens[index], "RECURSIVE")) index += 1;
      const afterGroup = (start: number): number => {
        const opening = tokens[start];
        if (opening?.value !== "(") return start;
        const close = tokens.findIndex(
          (token, candidate) =>
            candidate > start &&
            token.value === ")" &&
            token.depth === opening.depth,
        );
        return close < 0 ? start : close + 1;
      };
      while (index < tokens.length) {
        if (!name(tokens[index])) {
          unsupported();
          return;
        }
        index += 1;
        if (tokens[index]?.value === "(") {
          const next = afterGroup(index);
          if (next === index) {
            malformed();
            return;
          }
          index = next;
        }
        if (!word(tokens[index], "AS")) {
          unsupported();
          return;
        }
        index += 1;
        if (word(tokens[index], "NOT")) {
          index += 1;
          if (!word(tokens[index], "MATERIALIZED")) {
            unsupported();
            return;
          }
        }
        if (word(tokens[index], "MATERIALIZED")) index += 1;
        const end = afterGroup(index);
        if (end === index) {
          unsupported();
          return;
        }
        if (end === index + 2) {
          malformed();
          return;
        }
        analyze(tokens.slice(index + 1, end - 1), depth + 1);
        index = end;
        if (tokens[index]?.value !== ",") break;
        index += 1;
      }
      if (index >= tokens.length) {
        malformed();
        return;
      }
      analyze(tokens.slice(index), depth);
      return;
    }
    if (word(first, "DROP") && word(top[1], "TABLE")) {
      let start = 2;
      if (word(top[start], "IF") && word(top[start + 1], "EXISTS")) start += 2;
      if (!relationList(top, start)) {
        malformed();
        return;
      }
      add("drop_table", first);
      cascade(top);
      return;
    }
    if (word(first, "TRUNCATE")) {
      const start = word(top[1], "TABLE") ? 2 : 1;
      if (!relationList(top, start)) {
        malformed();
        return;
      }
      add("truncate", first);
      cascade(top);
      return;
    }
    if (word(first, "UPDATE") || word(first, "DELETE")) {
      const update = word(first, "UPDATE");
      let start = update ? 1 : 2;
      if (!update && !word(top[1], "FROM")) {
        malformed();
        return;
      }
      if (word(top[start], "ONLY")) start += 1;
      const end = qualifiedNameEnd(top, start);
      if (end === start) {
        malformed();
        return;
      }
      const where = top.findIndex(
        (token, index) => index >= end && word(token, "WHERE"),
      );
      const returning = top.findIndex(
        (token, index) => index >= end && word(token, "RETURNING"),
      );
      const set = top.findIndex(
        (token, index) => index >= end && word(token, "SET"),
      );
      const boundary = Math.min(
        ...[where, returning, top.length].filter((position) => position >= 0),
      );
      const assignment = top.slice(set + 1, boundary);
      const equals = assignment.findIndex((token) => token.value === "=");
      if (
        update &&
        (set < 0 ||
          equals <= 0 ||
          equals === assignment.length - 1 ||
          assignment.at(-1)?.value === ",")
      ) {
        malformed();
        return;
      }
      if (
        where >= 0 &&
        (where === top.length - 1 || (returning >= 0 && returning <= where + 1))
      ) {
        malformed();
        return;
      }
      if (where < 0 || (returning >= 0 && returning < where))
        add(update ? "broad_update" : "broad_delete", first);
      return;
    }
    if (word(first, "ALTER") && word(top[1], "TABLE")) {
      let index = 2;
      if (word(top[index], "IF") && word(top[index + 1], "EXISTS")) index += 2;
      if (word(top[index], "ONLY")) index += 1;
      const end = qualifiedNameEnd(top, index);
      if (end === index) {
        malformed();
        return;
      }
      index = end + (top[end]?.value === "*" ? 1 : 0);
      if (index >= top.length) {
        malformed();
        return;
      }
      while (index < top.length) {
        const comma = top.findIndex(
          (token, candidate) => candidate >= index && token.value === ",",
        );
        const clause = top.slice(index, comma < 0 ? undefined : comma);
        if (clause.length === 0) {
          malformed();
          return;
        }
        if (word(clause[0], "DROP")) {
          let column = 1;
          if (word(clause[column], "COLUMN")) column += 1;
          if (word(clause[column], "IF") && word(clause[column + 1], "EXISTS"))
            column += 2;
          if (word(clause[1], "CONSTRAINT")) unsupported();
          else if (
            name(clause[column]) &&
            (column + 1 === clause.length ||
              ((word(clause[column + 1], "CASCADE") ||
                word(clause[column + 1], "RESTRICT")) &&
                column + 2 === clause.length))
          )
            add("drop_column", clause[0]!);
          else malformed();
          cascade(clause);
        } else if (word(clause[0], "ALTER")) {
          const column = word(clause[1], "COLUMN") ? 2 : 1;
          if (
            name(clause[column]) &&
            word(clause[column + 1], "SET") &&
            word(clause[column + 2], "NOT") &&
            word(clause[column + 3], "NULL") &&
            column + 4 === clause.length
          )
            add("not_null", clause[column + 2]!);
          else unsupported();
        } else if (word(clause[0], "ADD")) {
          let caseDepth = 0;
          let constraint = false;
          for (let cursor = 1; cursor < clause.length; cursor += 1) {
            const token = clause[cursor]!;
            if (word(token, "CASE")) caseDepth += 1;
            if (word(token, "END")) caseDepth = Math.max(0, caseDepth - 1);
            if (caseDepth > 0) continue;
            if (
              word(token, "NOT") &&
              word(clause[cursor + 1], "NULL") &&
              !word(clause[cursor - 1], "IS")
            )
              add("not_null", token);
            if (
              ["CONSTRAINT", "CHECK", "UNIQUE", "REFERENCES", "EXCLUDE"].some(
                (keyword) => word(token, keyword),
              ) ||
              (word(token, "PRIMARY") && word(clause[cursor + 1], "KEY")) ||
              (word(token, "FOREIGN") && word(clause[cursor + 1], "KEY"))
            )
              constraint = true;
          }
          if (constraint) add("new_constraint", clause[0]!);
          // Column definitions/types/expressions are deliberately not parsed.
          unsupported();
          cascade(clause, false);
        } else unsupported();
        if (comma < 0) break;
        index = comma + 1;
        if (index >= top.length) malformed();
      }
      return;
    }
    // Other DDL can contain a meaningful trailing CASCADE, but remains unknown.
    if (word(first, "DROP")) {
      let target = 2;
      if (
        (word(top[1], "MATERIALIZED") && word(top[2], "VIEW")) ||
        (word(top[1], "FOREIGN") && word(top[2], "TABLE"))
      )
        target += 1;
      if (word(top[target], "IF") && word(top[target + 1], "EXISTS"))
        target += 2;
      const end = qualifiedNameEnd(top, target);
      if (end > target && end === top.length - 1 && word(top[end], "CASCADE"))
        cascade(top);
    }
    if (word(first, "CREATE") && word(top[1], "TABLE")) cascade(tokens, false);
    unsupported();
  };

  let start = 0;
  let atomicDepth = 0;
  let opaqueBody = false;
  for (let index = 0; index <= lexical.tokens.length; index += 1) {
    const token = lexical.tokens[index];
    let routine = start + 1;
    if (
      word(lexical.tokens[routine], "OR") &&
      word(lexical.tokens[routine + 1], "REPLACE")
    )
      routine += 2;
    const routineStatement =
      word(lexical.tokens[start], "CREATE") &&
      (word(lexical.tokens[routine], "FUNCTION") ||
        word(lexical.tokens[routine], "PROCEDURE"));
    if (
      routineStatement &&
      token?.depth === 0 &&
      word(token, "BEGIN") &&
      word(lexical.tokens[index + 1], "ATOMIC")
    ) {
      opaqueBody = true;
      atomicDepth += 1;
    } else if (
      opaqueBody &&
      token?.depth === 0 &&
      (word(token, "BEGIN") || word(token, "CASE"))
    )
      atomicDepth += 1;
    else if (opaqueBody && token?.depth === 0 && word(token, "END"))
      atomicDepth -= 1;
    if (
      index === lexical.tokens.length ||
      (token?.value === ";" && token.depth === 0 && atomicDepth === 0)
    ) {
      const statement = lexical.tokens.slice(start, index);
      if (opaqueBody) unsupported();
      else if (
        index !== lexical.tokens.length ||
        !lexical.unknownReasons.some(
          (reason) => reason === "input_limit" || reason === "malformed_sql",
        )
      )
        analyze(statement, 0);
      start = index + 1;
      opaqueBody = false;
    }
  }
  if (atomicDepth > 0) malformed();
  findings.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.rule.localeCompare(right.rule),
  );
  return {
    complete: reasons.size === 0,
    findings,
    unknownReasons: [...reasons].sort(),
  };
};
