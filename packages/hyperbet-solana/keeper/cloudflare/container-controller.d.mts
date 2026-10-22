import type { KeeperSqlStorage } from "./durable-sql.mjs";

export interface KeeperContainer {
  readonly running: boolean;
  start(options: { enableInternet: boolean; env: Record<string, string>; labels: Record<string, string> }): void;
  inspect(): Promise<{ labels: Record<string, string> } | null>;
  monitor(): Promise<void>;
  destroy(): Promise<void>;
  setInactivityTimeout(milliseconds: number): Promise<void>;
}
export interface KeeperController {
  status(): Record<string, unknown> & { running: boolean };
  recover(): Promise<void>;
  activate(snapshotDigest: string, env: Record<string, string>): Promise<{ ownerId: string; state: string }>;
  stop(): Promise<{ state: unknown; running: boolean }>;
  reconcile(ownerId: string, evidenceDigest: string): Promise<{ state: string; ownerId: string; reconciliationSha256: string }>;
  canProxy(): boolean;
}
export function createContainerController(options: {
  storage: KeeperSqlStorage;
  container: KeeperContainer;
  waitUntil(task: Promise<void>): void;
}): KeeperController;
