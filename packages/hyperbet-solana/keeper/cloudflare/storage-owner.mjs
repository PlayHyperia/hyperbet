import { StorageAdmissionError } from "./storage-executor.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

/** Called only after the controller confirms the previous container stopped. */
export function activateStorageOwner(storage, snapshotDigest, ownerId) {
  if (!uuid(ownerId) || typeof snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(snapshotDigest)) {
    throw new StorageAdmissionError("invalid-owner-activation");
  }
  return storage.transactionSync(() => {
    const control = storage.sql.exec("SELECT phase,snapshot_sha256,owner_id FROM _keeper_control WHERE id=1").one();
    if (!["imported", "frozen"].includes(control.phase) || control.snapshot_sha256 !== snapshotDigest ||
        control.owner_id === ownerId) throw new StorageAdmissionError("owner-activation-not-admitted");
    if (storage.sql.exec("SELECT owner_id FROM _keeper_owners WHERE owner_id=?", ownerId).toArray().length) {
      throw new StorageAdmissionError("owner-id-reused");
    }
    storage.sql.exec("INSERT INTO _keeper_owners (owner_id,snapshot_sha256,created_at) VALUES (?,?,?)", ownerId, snapshotDigest, Date.now());
    storage.sql.exec("UPDATE _keeper_control SET phase='active',owner_id=? WHERE id=1", ownerId);
    return { ownerId, phase: "active" };
  });
}

/** A delayed stop event for an old owner must not freeze its replacement. */
export function freezeStorageOwner(storage, ownerId) {
  if (!uuid(ownerId)) throw new StorageAdmissionError("invalid-owner");
  return storage.transactionSync(() => {
    const control = storage.sql.exec("SELECT phase,owner_id FROM _keeper_control WHERE id=1").one();
    if (control.owner_id !== ownerId || !["active", "frozen"].includes(control.phase)) {
      throw new StorageAdmissionError("stale-owner");
    }
    storage.sql.exec("UPDATE _keeper_control SET phase='frozen' WHERE id=1");
    return { ownerId, phase: "frozen" };
  });
}
