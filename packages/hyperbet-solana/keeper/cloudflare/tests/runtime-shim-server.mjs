import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createOperations } from "../.runtime/operations.ts";
import { createDurableSqlDatabase } from "../durable-sql.mjs";
import { createStorageExecutor } from "../storage-executor.mjs";
import { activateStorageOwner } from "../storage-owner.mjs";
import { handleStorageRequest } from "../storage-request.mjs";

const native = new Database(":memory:");
const storage = {
  sql: { exec(sql, ...args) {
    const statement = native.query(sql), rows = statement.all(...args);
    return { columnNames: statement.columnNames, toArray: () => rows, one: () => {
      if (rows.length !== 1) throw new Error("Fixture expected one row"); return rows[0];
    } };
  } },
  transactionSync: fn => native.transaction(fn)(),
};
const execute = createStorageExecutor(storage, createOperations(createDurableSqlDatabase(storage)));
storage.sql.exec("UPDATE _keeper_control SET phase='imported',snapshot_sha256=?", "b".repeat(64));
activateStorageOwner(storage, "b".repeat(64), process.env.KEEPER_STORAGE_OWNER_ID);
const token = "a".repeat(32);
const server = createServer({ key: readFileSync("/certs/key.pem"), cert: readFileSync("/certs/cert.pem") }, async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
  if (request.url.startsWith("/fixture/receipt/")) {
    const id = request.url.slice("/fixture/receipt/".length);
    response.end(JSON.stringify({
      receipts: storage.sql.exec("SELECT COUNT(*) AS n FROM _keeper_receipts WHERE request_id=?", id).one().n,
      writes: storage.sql.exec("SELECT COUNT(*) AS n FROM wallet_display WHERE normalized_wallet='uncertain-wallet'").one().n,
    })); return;
  }
  let body = "";
  for await (const part of request) body += part;
  const result = await handleStorageRequest(new Request(`https://localhost${request.url}`, {
    method: request.method, headers: request.headers, body,
  }), { token, execute(...args) {
    const value = execute(...args);
    if (args[1] === "saveWalletDisplay" && args[2][0] === "uncertain-wallet") throw new Error("Fixture response failure after commit");
    return value;
  } });
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(await result.text());
});
server.listen(0, "127.0.0.1", () => console.log(`https://localhost:${server.address().port}/rpc`));
