import { StorageAdmissionError } from "./storage-executor.mjs";
import { activateStorageOwner, freezeStorageOwner } from "./storage-owner.mjs";

const fail = code => { throw new StorageAdmissionError(code); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Explicit lifecycle only: requests and alarms never start a financial owner. */
export function createContainerController({ storage, container, waitUntil }) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS _keeper_lifecycle (
    id INTEGER PRIMARY KEY CHECK (id=1),
    state TEXT NOT NULL CHECK (state IN ('idle','starting','running','reconcile')),
    owner_id TEXT,
    reason TEXT,
    reconciliation_sha256 TEXT
  )`);
  storage.sql.exec("INSERT OR IGNORE INTO _keeper_lifecycle (id,state) VALUES (1,'idle')");
  let busy = false;
  let watchedOwner;
  const lifecycle = () => storage.sql.exec("SELECT state,owner_id,reason,reconciliation_sha256 FROM _keeper_lifecycle WHERE id=1").one();
  const control = () => storage.sql.exec("SELECT phase,snapshot_sha256,owner_id FROM _keeper_control WHERE id=1").one();
  const exclusive = async action => {
    if (busy) fail("lifecycle-operation-in-progress");
    busy = true;
    try { return await action(); } finally { busy = false; }
  };
  function freeze(ownerId, reason) {
    storage.transactionSync(() => {
      if (control().owner_id !== ownerId) return;
      freezeStorageOwner(storage, ownerId);
      storage.sql.exec("UPDATE _keeper_lifecycle SET state='reconcile',owner_id=?,reason=?,reconciliation_sha256=NULL WHERE id=1", ownerId, reason);
    });
  }
  function watch(ownerId) {
    if (watchedOwner === ownerId) return;
    watchedOwner = ownerId;
    let monitor;
    try { monitor = container.monitor(); } catch {
      freeze(ownerId, "monitor-unavailable");
      throw new StorageAdmissionError("monitor-unavailable");
    }
    waitUntil(Promise.resolve(monitor).then(
      () => freeze(ownerId, "container-stopped"),
      () => freeze(ownerId, "container-failed"),
    ).finally(() => { if (watchedOwner === ownerId) watchedOwner = undefined; }));
  }
  return {
    status() { return { ...control(), ...lifecycle(), running: container.running }; },
    /** Run once on DO construction, before serving RPCs or administrative calls. */
    recover() {
      return exclusive(async () => {
        const current = control();
        const life = lifecycle();
        if (container.running && current.phase === "active" &&
            current.owner_id === life.owner_id && ["starting", "running"].includes(life.state)) {
          try {
            const info = await container.inspect();
            if (info?.labels?.owner !== current.owner_id) fail("container-owner-mismatch");
            watch(current.owner_id);
            await container.setInactivityTimeout(21_600_000);
          } catch {
            freeze(current.owner_id, "recovery-failed");
            if (container.running) await container.destroy();
            throw new StorageAdmissionError("recovery-failed");
          }
        } else {
          if (current.phase === "active") freeze(current.owner_id, "owner-interrupted");
          // Unknown or frozen processes must never be adopted by a new owner.
          if (container.running) await container.destroy();
        }
      });
    },
    activate(snapshotDigest, env) {
      return exclusive(async () => {
        if (container.running || lifecycle().state !== "idle") fail("container-not-stopped");
        if (!digest(snapshotDigest) || !env || typeof env !== "object" || Array.isArray(env) ||
            Object.values(env).some(value => typeof value !== "string")) fail("invalid-start-options");
        const ownerId = crypto.randomUUID();
        storage.transactionSync(() => {
          activateStorageOwner(storage, snapshotDigest, ownerId);
          storage.sql.exec("UPDATE _keeper_lifecycle SET state='starting',owner_id=?,reason=NULL WHERE id=1", ownerId);
        });
        try {
          container.start({ enableInternet: true, labels: { owner: ownerId }, env: { ...env, KEEPER_STORAGE_OWNER_ID: ownerId } });
          watch(ownerId);
          await container.setInactivityTimeout(21_600_000);
          if (control().phase !== "active" || lifecycle().state !== "starting") fail("container-stopped-during-start");
          storage.sql.exec("UPDATE _keeper_lifecycle SET state='running' WHERE id=1");
          // Running is process state, not application readiness.
          return { ownerId, state: "running" };
        } catch {
          freeze(ownerId, "start-failed");
          if (container.running) await container.destroy();
          throw new StorageAdmissionError("container-start-failed");
        }
      });
    },
    stop() {
      return exclusive(async () => {
        const current = control();
        if (current.owner_id) freeze(current.owner_id, "operator-stop");
        if (container.running) await container.destroy();
        if (container.running) fail("container-stop-unconfirmed");
        return { state: lifecycle().state, running: false };
      });
    },
    /** An operator supplies the digest of their completed receipt/chain reconciliation. */
    reconcile(ownerId, evidenceDigest) {
      return exclusive(async () => {
        if (!digest(evidenceDigest) || container.running || watchedOwner) fail("reconciliation-not-admitted");
        storage.transactionSync(() => {
          const current = control();
          const life = lifecycle();
          if (current.phase !== "frozen" || current.owner_id !== ownerId ||
              life.owner_id !== ownerId || life.state !== "reconcile") fail("reconciliation-not-admitted");
          storage.sql.exec("UPDATE _keeper_lifecycle SET state='idle',reconciliation_sha256=? WHERE id=1", evidenceDigest);
        });
        return { state: "idle", ownerId, reconciliationSha256: evidenceDigest };
      });
    },
    canProxy() {
      const current = control();
      const life = lifecycle();
      return container.running && current.phase === "active" && life.state === "running" &&
        current.owner_id === life.owner_id;
    },
  };
}
