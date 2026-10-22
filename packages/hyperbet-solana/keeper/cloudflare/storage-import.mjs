import { StorageAdmissionError } from "./storage-executor.mjs";

const tables = Object.freeze([
  "agent_ratings", "bets", "identity_members", "invite_codes", "invited_wallets",
  "perps_markets", "perps_oracle_snapshots", "points_events", "referral_fees", "referrals",
  "sqlite_sequence", "wallet_canonical", "wallet_display", "wallet_gold_state", "wallet_points",
]);
const plain = value => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const cell = value => value === null || typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
const fail = code => { throw new StorageAdmissionError(code); };
const schemaKey = row => JSON.stringify([row.type, row.name, row.tbl_name, row.sql]);
const schemaList = rows => rows.map(schemaKey).sort();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const preparedImports = new WeakSet();
function freezeTree(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/** Audit snapshots without an explicit quiesced export are never importable. */
export async function prepareStorageImport(input, expectedManifestSha256) {
  if (!plain(input) || input.version !== 1 || input.sourceQuiesced !== true ||
      typeof expectedManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedManifestSha256) ||
      input.runtimeManifestSha256 !== expectedManifestSha256 ||
      typeof input.capturedAt !== "string" || !Number.isFinite(Date.parse(input.capturedAt)) ||
      !Array.isArray(input.tables) || !Array.isArray(input.schema)) fail("invalid-snapshot");
  if (!same(input.tables.map(table => table?.name).sort(), [...tables].sort())) fail("incomplete-snapshot");
  for (const table of input.tables) {
    if (!plain(table) || !Array.isArray(table.rows)) fail("invalid-table");
    for (const row of table.rows) {
      if (!plain(row) || !Object.values(row).every(cell)) fail("invalid-row");
    }
  }
  const names = new Set();
  for (const item of input.schema) {
    if (!plain(item) || !["table", "index", "trigger", "view"].includes(item.type) ||
        typeof item.name !== "string" || names.has(item.name) || !tables.includes(item.tbl_name) ||
        typeof item.sql !== "string") fail("invalid-schema");
    names.add(item.name);
  }
  // Copy before awaiting so the caller cannot change rows after hashing them.
  const serialized = JSON.stringify(input);
  const snapshot = JSON.parse(serialized);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  const digest = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const prepared = Object.freeze({ snapshot: freezeTree(snapshot), digest });
  preparedImports.add(prepared);
  return prepared;
}

/** The caller must use prepareStorageImport, then keep this value private. */
export function importPreparedStorage(storage, prepared) {
  if (!preparedImports.has(prepared)) fail("unverified-import");
  const { snapshot, digest } = prepared;
  return storage.transactionSync(() => {
    const control = storage.sql.exec("SELECT phase,snapshot_sha256 FROM _keeper_control WHERE id=1").one();
    const replay = control.phase === "imported" && control.snapshot_sha256 === digest;
    if (control.phase !== "prepared" && !replay) fail("import-not-admitted");
    const metadata = new Set(["_keeper_control", "_keeper_receipts", "__miniflare_do_name"]);
    const targetSchema = storage.sql.exec("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").toArray()
      .filter(item => !metadata.has(item.tbl_name));
    if (!same(schemaList(snapshot.schema), schemaList(targetSchema))) fail("schema-mismatch");
    const byName = new Map(snapshot.tables.map(table => [table.name, table]));
    const columns = new Map();
    for (const name of tables) {
      const names = [...storage.sql.exec(`SELECT * FROM "${name}" LIMIT 0`).columnNames];
      columns.set(name, names);
      for (const row of byName.get(name).rows) {
        if (!same(Object.keys(row).sort(), [...names].sort())) fail("column-mismatch");
      }
      if (!replay && storage.sql.exec(`SELECT COUNT(*) AS n FROM "${name}"`).one().n !== 0) fail("target-not-empty");
    }
    if (!replay) {
      // AUTOINCREMENT inserts populate sqlite_sequence. Restore its exact source
      // values last, including counters above the largest remaining row ID.
      for (const name of [...tables.filter(name => name !== "sqlite_sequence"), "sqlite_sequence"]) {
        if (name === "sqlite_sequence") storage.sql.exec("DELETE FROM sqlite_sequence");
        const names = columns.get(name);
        if (!names.every(column => /^[a-z_]+$/.test(column))) fail("unsupported-column");
        const sql = `INSERT INTO "${name}" (${names.map(column => `"${column}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`;
        for (const row of byName.get(name).rows) storage.sql.exec(sql, ...names.map(column => row[column]));
      }
    }
    const counts = {};
    for (const name of tables) {
      const names = columns.get(name);
      const canonical = rows => rows.map(row => JSON.stringify(names.map(column => row[column]))).sort();
      const target = storage.sql.exec(`SELECT * FROM "${name}"`).toArray();
      if (!same(canonical(target), canonical(byName.get(name).rows))) fail("import-verification-failed");
      counts[name] = target.length;
    }
    storage.sql.exec("UPDATE _keeper_control SET phase='imported',snapshot_sha256=? WHERE id=1", digest);
    return { digest, counts, phase: "imported" };
  });
}
