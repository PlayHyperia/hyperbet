type Binding = string | number | null;
type Row = Record<string, unknown>;

export interface KeeperSqlStorage {
  sql: {
    exec(sql: string, ...bindings: Binding[]): {
      readonly columnNames: string[];
      toArray(): Row[];
      one(): Row;
    };
  };
  transactionSync<T>(callback: () => T): T;
}

export function createDurableSqlDatabase(storage: KeeperSqlStorage): {
  run(sql: string): void;
  prepare(sql: string): {
    all(...args: Binding[]): Row[];
    run(named: Record<string, Binding>): { lastInsertRowid: unknown };
  };
  transaction<Args extends unknown[], Result>(
    callback: (...args: Args) => Result
  ): (...args: Args) => Result;
};
