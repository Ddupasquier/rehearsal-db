import { lexMigrationSql, type SqlToken } from "./migration_sql_lexer.mjs";

export interface MigrationImpactRelation {
  readonly schema: string;
  readonly name: string;
}

export type MigrationImpactUnknownReason =
  "unsupported_sql" | "malformed_sql" | "input_limit";

interface MigrationImpactTaskSource {
  readonly relation: MigrationImpactRelation;
  readonly line: number;
  readonly column: number;
}

/** Private measurement inputs, never a public SQL/identifier payload. */
export type MigrationImpactTask = MigrationImpactTaskSource &
  (
    | {
        readonly metric: "rows";
        readonly operation: "drop_table" | "truncate" | "broad_delete";
      }
    | {
        readonly metric: "populated";
        readonly operation: "drop_column";
        readonly columns: readonly [string];
      }
    | {
        readonly metric: "nulls";
        readonly operation: "not_null";
        readonly columns: readonly [string];
      }
    | {
        readonly metric: "duplicate_rows";
        readonly operation: "new_constraint";
        readonly columns: readonly string[];
      }
    | {
        readonly metric: "orphan_rows";
        readonly operation: "new_constraint";
        readonly columns: readonly string[];
        readonly referencedRelation: MigrationImpactRelation;
        readonly referencedColumns: readonly string[];
      }
  );

export interface MigrationImpactSqlPlan {
  /** Coverage of the narrow recognizer, never SQL validity or a safe verdict. */
  readonly complete: boolean;
  readonly tasks: readonly MigrationImpactTask[];
  readonly unknownReasons: readonly MigrationImpactUnknownReason[];
}

const maximumTasks = 100;
// More columns are outside the supported grammar, not a whole-input limit.
const maximumColumns = 8;
const maximumIdentifierBytes = 63;

/**
 * The shared lexer folds words to uppercase. Check the original ASCII span as
 * well: Unicode uppercase expansions must not become supported identifiers or
 * keywords. This walk is linear and uses the lexer's UTF-16/CRLF coordinates.
 */
const asciiWords = (
  source: string,
  tokens: readonly SqlToken[],
): ReadonlyMap<SqlToken, string> => {
  const result = new Map<SqlToken, string>();
  let offset = 0;
  let line = 1;
  let column = 1;
  const advance = (): void => {
    const character = source[offset++]!;
    if (character === "\r") {
      if (source[offset] === "\n") offset += 1;
      line += 1;
      column = 1;
    } else if (character === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
  };
  for (const token of tokens) {
    while (
      offset < source.length &&
      (line < token.line || (line === token.line && column < token.column))
    )
      advance();
    if (token.kind !== "word") continue;
    const start = offset;
    if (!/[A-Za-z_]/u.test(source[offset] ?? "")) continue;
    while (/[A-Za-z0-9_$]/u.test(source[offset] ?? "")) advance();
    const raw = source.slice(start, offset);
    if (raw.toUpperCase() === token.value) result.set(token, raw.toLowerCase());
  }
  return result;
};

/** Exact token-shape matching, not a general PostgreSQL grammar/parser. */
class StatementReader {
  private index = 0;

  constructor(
    private readonly tokens: readonly SqlToken[],
    private readonly words: ReadonlyMap<SqlToken, string>,
  ) {}

  get current(): SqlToken | undefined {
    return this.tokens[this.index];
  }

  get done(): boolean {
    return this.index === this.tokens.length;
  }

  word(value: string): boolean {
    const token = this.current;
    if (!token || this.words.get(token) !== value.toLowerCase()) return false;
    this.index += 1;
    return true;
  }

  symbol(value: string): boolean {
    const token = this.current;
    if (token?.kind !== "symbol" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  identifier(): string | undefined {
    const token = this.current;
    const value = token && this.words.get(token);
    if (!value || value.length > maximumIdentifierBytes) return undefined;
    this.index += 1;
    return value;
  }

  relation(): MigrationImpactRelation | undefined {
    const schema = this.identifier();
    if (!schema || !this.symbol(".")) return undefined;
    const name = this.identifier();
    return name ? { schema, name } : undefined;
  }

  columns(): string[] | undefined {
    if (!this.symbol("(")) return undefined;
    const columns: string[] = [];
    do {
      const column = this.identifier();
      if (
        !column ||
        columns.length >= maximumColumns ||
        columns.includes(column)
      )
        return undefined;
      columns.push(column);
    } while (this.symbol(","));
    return this.symbol(")") ? columns : undefined;
  }
}

const recognizeStatement = (
  tokens: readonly SqlToken[],
  words: ReadonlyMap<SqlToken, string>,
): MigrationImpactTask | undefined => {
  const reader = new StatementReader(tokens, words);
  const first = reader.current;
  if (!first) return undefined;
  const position = { line: first.line, column: first.column };
  if (reader.word("DROP")) {
    if (!reader.word("TABLE")) return undefined;
    if (reader.word("IF") && !reader.word("EXISTS")) return undefined;
    const relation = reader.relation();
    reader.word("RESTRICT");
    return relation && reader.done
      ? { ...position, relation, metric: "rows", operation: "drop_table" }
      : undefined;
  }
  if (reader.word("TRUNCATE")) {
    reader.word("TABLE");
    reader.word("ONLY");
    const relation = reader.relation();
    if (
      (reader.word("RESTART") || reader.word("CONTINUE")) &&
      !reader.word("IDENTITY")
    )
      return undefined;
    reader.word("RESTRICT");
    return relation && reader.done
      ? { ...position, relation, metric: "rows", operation: "truncate" }
      : undefined;
  }
  if (reader.word("DELETE")) {
    if (!reader.word("FROM")) return undefined;
    reader.word("ONLY");
    const relation = reader.relation();
    return relation && reader.done
      ? { ...position, relation, metric: "rows", operation: "broad_delete" }
      : undefined;
  }
  if (!reader.word("ALTER") || !reader.word("TABLE")) return undefined;
  reader.word("ONLY");
  const relation = reader.relation();
  if (!relation) return undefined;
  const action = reader.current;
  if (!action) return undefined;
  if (reader.word("DROP")) {
    reader.word("COLUMN");
    if (reader.word("IF") && !reader.word("EXISTS")) return undefined;
    const column = reader.identifier();
    reader.word("RESTRICT");
    return column && reader.done
      ? {
          relation,
          line: action.line,
          column: action.column,
          operation: "drop_column",
          metric: "populated",
          columns: [column],
        }
      : undefined;
  }
  if (reader.word("ALTER")) {
    reader.word("COLUMN");
    const column = reader.identifier();
    if (!column || !reader.word("SET")) return undefined;
    const not = reader.current;
    if (!not || !reader.word("NOT") || !reader.word("NULL") || !reader.done)
      return undefined;
    return {
      relation,
      line: not.line,
      column: not.column,
      operation: "not_null",
      metric: "nulls",
      columns: [column],
    };
  }
  if (!reader.word("ADD")) return undefined;
  if (reader.word("CONSTRAINT") && !reader.identifier()) return undefined;
  const constraintPosition = { line: action.line, column: action.column };
  if (reader.word("UNIQUE")) {
    const columns = reader.columns();
    return columns && reader.done
      ? {
          ...constraintPosition,
          relation,
          operation: "new_constraint",
          metric: "duplicate_rows",
          columns,
        }
      : undefined;
  }
  if (!reader.word("FOREIGN") || !reader.word("KEY")) return undefined;
  const columns = reader.columns();
  if (!columns || !reader.word("REFERENCES")) return undefined;
  const referencedRelation = reader.relation();
  const referencedColumns = reader.columns();
  if (reader.word("MATCH") && !reader.word("SIMPLE")) return undefined;
  return referencedRelation &&
    referencedColumns &&
    columns.length === referencedColumns.length &&
    reader.done
    ? {
        ...constraintPosition,
        relation,
        operation: "new_constraint",
        metric: "orphan_rows",
        columns,
        referencedRelation,
        referencedColumns,
      }
    : undefined;
};

/**
 * Plan narrow, current pre-migration snapshot measurements. No statement is
 * executed; tasks do not predict earlier/later migration effects. The caller
 * must validate the owned target, ordinary non-inherited/non-RLS tables and
 * supported built-in column/operator semantics before using these private specs.
 */
export const planMigrationImpactSql = (
  source: string,
): MigrationImpactSqlPlan => {
  const lexical = lexMigrationSql(source);
  const reasons = new Set<MigrationImpactUnknownReason>(lexical.unknownReasons);
  const refusal = (): MigrationImpactSqlPlan => ({
    complete: false,
    tasks: [],
    unknownReasons: [...reasons].sort(),
  });
  // Lexical ambiguity, malformed input and limits invalidate all boundaries.
  if (reasons.size > 0 || lexical.ambiguousQuotes) return refusal();
  const words = asciiWords(source, lexical.tokens);
  const statements: SqlToken[][] = [];
  let statement: SqlToken[] = [];
  for (const token of lexical.tokens) {
    if (token.kind === "symbol" && token.value === ";" && token.depth === 0) {
      if (statement.length > 0) statements.push(statement);
      statement = [];
    } else statement.push(token);
  }
  if (statement.length > 0) statements.push(statement);

  // SQL-standard routine bodies and explicit transactions need a real parser /
  // transactional model. Never reinterpret their inner statements as top-level.
  const transactionCommands = new Set([
    "begin",
    "start",
    "commit",
    "end",
    "rollback",
    "abort",
    "savepoint",
    "release",
    "prepare",
  ]);
  if (
    lexical.tokens.some(
      (token, index) =>
        words.get(token) === "begin" &&
        words.get(lexical.tokens[index + 1]!) === "atomic",
    ) ||
    statements.some((tokens) =>
      transactionCommands.has(words.get(tokens[0]!) ?? ""),
    )
  ) {
    reasons.add("unsupported_sql");
    return refusal();
  }

  const tasks: MigrationImpactTask[] = [];
  for (const tokens of statements) {
    const task = recognizeStatement(tokens, words);
    if (!task) reasons.add("unsupported_sql");
    else {
      if (tasks.length >= maximumTasks) {
        reasons.add("input_limit");
        return refusal();
      }
      tasks.push(task);
    }
  }
  return {
    complete: reasons.size === 0,
    tasks,
    unknownReasons: [...reasons].sort(),
  };
};
