declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement<Result = unknown> {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): Result | undefined;
    all(...params: unknown[]): Result[];
  }

  export interface DatabaseConnection {
    prepare<Result = unknown>(sql: string): Statement<Result>;
    exec(sql: string): this;
    pragma(source: string): unknown;
    close(): this;
  }

  interface DatabaseConstructor {
    new (filename?: string, options?: Record<string, unknown>): DatabaseConnection;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
