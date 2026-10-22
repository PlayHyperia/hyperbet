import { DurableObject } from "cloudflare:workers";
import { createOperations, runtimeManifestSha256 } from "./.runtime/operations.ts";
import { createDurableSqlDatabase } from "./durable-sql.mjs";
import { createStorageExecutor } from "./storage-executor.mjs";
import { handleStorageRequest } from "./storage-request.mjs";
import { createContainerController } from "./container-controller.mjs";
import { handleAdminRequest } from "./admin-request.mjs";
import { buildRuntimeEnv } from "./runtime-config.mjs";
import type { KeeperController } from "./container-controller.mjs";
import type { StorageExecute } from "./storage-request.mjs";

interface KeeperEnv {
  KEEPER: DurableObjectNamespace<KeeperContainer>;
  KEEPER_ENABLED: string;
  KEEPER_ADMIN_TOKEN: string;
  KEEPER_STORAGE_TOKEN: string;
  KEEPER_PUBLIC_ORIGIN: string;
  KEEPER_RUNTIME_CONFIG: string;
}

async function discardUnreadBody(request?: Request) {
  if (!request?.body || request.bodyUsed) return;
  // Drain without buffering before returning through the DO fetch boundary.
  // Cancelling here can leave the upstream request pump reading after response.
  await request.body.pipeTo(new WritableStream({ write() {} }));
}
const unavailable = async (request?: Request) => {
  await discardUnreadBody(request);
  return new Response("Keeper unavailable", { status: 503, headers: { "cache-control": "no-store" } });
};
const singleton = (env: KeeperEnv) => env.KEEPER.get(env.KEEPER.idFromName("keeper-production-v1"));

export class KeeperContainer extends DurableObject<KeeperEnv> {
  private execute: StorageExecute;
  private controller: KeeperController;
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: KeeperEnv) {
    super(ctx, env);
    if (!ctx.container) throw new Error("Keeper container binding is missing");
    const operations = createOperations(createDurableSqlDatabase(ctx.storage));
    this.execute = createStorageExecutor(ctx.storage, operations);
    this.controller = createContainerController({ storage: ctx.storage, container: ctx.container,
      waitUntil: task => ctx.waitUntil(task) });
    // Recovery only observes an existing process. It never waits for HTTP
    // readiness, which would deadlock the keeper's startup storage calls.
    this.ready = this.controller.recover().then(async () => {
      if (env.KEEPER_ENABLED !== "true" && ctx.container?.running) await this.controller.stop();
    }).catch(() => {
      console.error(JSON.stringify({ event: "keeper-recovery-failed" }));
    });
  }

  async maintain() {
    await this.ready;
    if (this.env.KEEPER_ENABLED !== "true") {
      if (this.ctx.container?.running) await this.controller.stop();
      return;
    }
    // A heartbeat keeps the existing owner alive but cannot create one.
    if (this.controller.canProxy()) await this.ctx.container!.setInactivityTimeout(21_600_000);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const path = new URL(request.url).pathname;
    if (path === "/rpc") {
      if (this.env.KEEPER_ENABLED !== "true") return unavailable(request);
      const response = await handleStorageRequest(request, { token: this.env.KEEPER_STORAGE_TOKEN, execute: this.execute });
      await discardUnreadBody(request);
      return response;
    }
    if (path === "/admin" || path.startsWith("/admin/")) {
      const response = await handleAdminRequest(request, {
        adminToken: this.env.KEEPER_ADMIN_TOKEN, storageToken: this.env.KEEPER_STORAGE_TOKEN,
        storage: this.ctx.storage, controller: this.controller, manifestSha256: runtimeManifestSha256,
        enabled: this.env.KEEPER_ENABLED, runtimeEnv: () => buildRuntimeEnv(this.env),
      });
      await discardUnreadBody(request);
      return response;
    }
    if (this.env.KEEPER_ENABLED !== "true" || !this.controller.canProxy()) return unavailable(request);
    try {
      const target = new URL(request.url);
      target.protocol = "http:";
      return await this.ctx.container!.getTcpPort(8080).fetch(new Request(target, request));
    } catch {
      // An HTTP failure does not prove that a financial process stopped.
      return unavailable();
    }
  }
}

export default {
  fetch(request: Request, env: KeeperEnv) { return singleton(env).fetch(request); },
  scheduled(_event: ScheduledController, env: KeeperEnv, ctx: ExecutionContext) { ctx.waitUntil(singleton(env).maintain()); },
};
