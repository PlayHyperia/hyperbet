import { decodeValue, encodeValue } from "./value-codec.mjs";
import { validateOperation } from "./storage-request.mjs";

export class StorageAdmissionError extends Error {
  constructor(code) {
    super(`Keeper storage admission: ${code}`);
    this.name = "StorageAdmissionError";
    this.code = code;
  }
}

/** No endpoint here activates storage. A verified import/handoff must do that. */
export function createStorageExecutor(storage, operations) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS _keeper_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL CHECK (phase IN ('prepared', 'imported', 'active', 'frozen')),
    snapshot_sha256 TEXT,
    owner_id TEXT
  )`);
  storage.sql.exec("INSERT OR IGNORE INTO _keeper_control (id,phase) VALUES (1,'prepared')");
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS _keeper_owners (
    owner_id TEXT PRIMARY KEY,
    snapshot_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS _keeper_receipts (
    request_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  return (requestId, operation, args, fingerprint, ownerId) => storage.transactionSync(() => {
    const control = storage.sql.exec("SELECT phase,snapshot_sha256,owner_id FROM _keeper_control WHERE id = 1").one();
    if (control.phase !== "active" || typeof control.snapshot_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(control.snapshot_sha256)) throw new StorageAdmissionError("inactive");
    if (typeof ownerId !== "string" || ownerId !== control.owner_id) throw new StorageAdmissionError("stale-owner");
    if (!validateOperation(operation, args) || !Object.hasOwn(operations, operation) ||
        typeof operations[operation] !== "function" || typeof fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(fingerprint) || typeof requestId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) {
      throw new StorageAdmissionError("invalid-request");
    }
    const receipt = storage.sql.exec("SELECT operation,fingerprint,result FROM _keeper_receipts WHERE request_id = ?", requestId).toArray()[0];
    if (receipt) {
      if (receipt.operation !== operation || receipt.fingerprint !== fingerprint) throw new StorageAdmissionError("request-id-conflict");
      return decodeValue(JSON.parse(receipt.result));
    }
    const value = operations[operation](...args);
    if (value && typeof value.then === "function") throw new StorageAdmissionError("asynchronous-operation");
    // Encoding must succeed inside the transaction, before any write commits.
    const encoded = JSON.stringify(encodeValue(value));
    if (operation.startsWith("save") || operation.startsWith("delete")) {
      storage.sql.exec("INSERT INTO _keeper_receipts (request_id,operation,fingerprint,result,created_at) VALUES (?,?,?,?,?)",
        requestId, operation, fingerprint, encoded, Date.now());
    }
    return value;
  });
}
