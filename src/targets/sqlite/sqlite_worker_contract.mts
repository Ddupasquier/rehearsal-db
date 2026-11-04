/** Private bounded messages for native SQLite jobs. */
export interface SQLitePrivacyPolicy {
  readonly policyVersion: 1;
  readonly engine: "sqlite";
  readonly tables: readonly {
    readonly name: string;
    readonly columns: readonly {
      readonly name: string;
      readonly action: "KEEP" | "REPLACE";
      readonly value?: null | string | number;
    }[];
  }[];
}
export interface SqliteHistoryEntry {
  readonly filename: string;
  readonly sha256: string;
}
export interface SqliteJournalIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly birthtimeNs: string;
}
export type SqliteWorkerJob =
  | { readonly operation: "probe"; readonly maximumBytes: number }
  | {
      readonly operation: "snapshot";
      readonly sourceDatabase: string;
      readonly destinationDatabase: string;
      readonly policy: SQLitePrivacyPolicy;
      readonly history: readonly SqliteHistoryEntry[];
      readonly maximumBytes: number;
    }
  | {
      readonly operation: "migrate";
      readonly expectedJournal: SqliteJournalIdentity;
      readonly databasePath: string;
      readonly expectedHistory: readonly SqliteHistoryEntry[];
      readonly migrations: readonly {
        readonly filename: string;
        readonly sql: string;
        readonly sha256: string;
      }[];
      readonly maximumBytes: number;
    }
  | {
      readonly operation: "verify";
      readonly exclusive?: boolean;
      readonly expectedHistory: readonly SqliteHistoryEntry[];
      readonly databasePath: string;
      readonly maximumBytes: number;
    };
export interface SqliteWorkerResult {
  readonly sqliteVersion: "3.53.4";
  readonly tableCount: number;
  readonly rowCount: number;
  readonly schemaSha256: string;
  readonly history: readonly SqliteHistoryEntry[];
}
export const SQLITE_WORKER_MAXIMUM_INPUT_BYTES = 8 * 1024 * 1024;
export const SQLITE_WORKER_MAXIMUM_ROWS = 100_000;
export const SQLITE_WORKER_MAXIMUM_TABLES = 256;
