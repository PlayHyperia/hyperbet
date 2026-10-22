import assert from "node:assert/strict";
import { buildRuntimeEnv } from "../runtime-config.mjs";
const env = {
  KEEPER_STORAGE_TOKEN: "s".repeat(40), KEEPER_ADMIN_TOKEN: "a".repeat(40),
  KEEPER_PUBLIC_ORIGIN: "https://keeper.example.com", KEEPER_RUNTIME_CONFIG: JSON.stringify({
    BOT_ENABLED: "true", RPC_URL: "https://rpc.example.com", RAILWAY_SERVICE_ID: "source", PORT: "3000", KEEPER_DB_PATH: "/data/keeper.sqlite",
  }),
};
const result = buildRuntimeEnv(env);
assert.equal(result.BOT_ENABLED, "true");
assert.equal(result.PORT, "8080");
assert.equal(result.KEEPER_STORAGE_URL, "https://keeper.example.com/rpc");
assert.equal(result.RAILWAY_SERVICE_ID, undefined);
assert.equal(result.KEEPER_ADMIN_TOKEN, undefined);
for (const origin of ["http://keeper.example.com", "https://user:pass@keeper.example.com", "https://keeper.example.com/secret", "https://keeper.example.com?q=1", "https://127.0.0.1", "https://keeper.internal"]) {
  assert.throws(() => buildRuntimeEnv({ ...env, KEEPER_PUBLIC_ORIGIN: origin }), /Invalid keeper runtime configuration/);
}
for (const settings of [[], null, { BOT_ENABLED: true }, { KEEPER_STORAGE_OWNER_ID: "injected" }, { KEEPER_PROCESS_GROUP_ID: "1" }, { RPC_URL: "https://host.railway.internal/rpc" }]) {
  assert.throws(() => buildRuntimeEnv({ ...env, KEEPER_RUNTIME_CONFIG: JSON.stringify(settings) }), /Invalid keeper runtime configuration/);
}
assert.throws(() => buildRuntimeEnv({ ...env, KEEPER_ADMIN_TOKEN: env.KEEPER_STORAGE_TOKEN }));
console.log("Runtime config: source flags preserved, reserved settings isolated, credentials separated, and public origin validated");
