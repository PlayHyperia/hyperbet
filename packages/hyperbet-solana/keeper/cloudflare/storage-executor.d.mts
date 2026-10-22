import type { KeeperSqlStorage } from "./durable-sql.mjs";
import type { StorageExecute } from "./storage-request.mjs";

export class StorageAdmissionError extends Error {
  readonly code: string;
  constructor(code: string);
}
export function createStorageExecutor(storage: KeeperSqlStorage, operations: object): StorageExecute;
