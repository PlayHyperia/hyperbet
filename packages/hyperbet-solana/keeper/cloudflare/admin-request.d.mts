import type { KeeperSqlStorage } from "./durable-sql.mjs";
import type { KeeperController } from "./container-controller.mjs";

export function handleAdminRequest(request: Request, options: {
  adminToken: string;
  storageToken: string;
  controller: KeeperController;
  storage: KeeperSqlStorage;
  manifestSha256: string;
  enabled: string;
  runtimeEnv(): Record<string, string>;
}): Promise<Response>;
