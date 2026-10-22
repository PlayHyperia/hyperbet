import type { KeeperSqlStorage } from "./durable-sql.mjs";

export interface PreparedStorageImport {
  readonly snapshot: unknown;
  readonly digest: string;
}
export function prepareStorageImport(input: unknown, expectedManifestSha256: string): Promise<PreparedStorageImport>;
export function importPreparedStorage(storage: KeeperSqlStorage, prepared: PreparedStorageImport): {
  digest: string;
  counts: Record<string, number>;
  phase: "imported";
};
