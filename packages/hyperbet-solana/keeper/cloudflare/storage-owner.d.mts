import type { KeeperSqlStorage } from "./durable-sql.mjs";

export function activateStorageOwner(storage: KeeperSqlStorage, snapshotDigest: string, ownerId: string): {
  ownerId: string;
  phase: "active";
};
export function freezeStorageOwner(storage: KeeperSqlStorage, ownerId: string): {
  ownerId: string;
  phase: "frozen";
};
