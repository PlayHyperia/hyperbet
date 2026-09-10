import { TerminalLedger } from "./terminalLedger";

const dbPath = process.argv[2]?.trim();
if (!dbPath) {
  throw new Error("terminal crash worker requires a database path");
}
const expectedClaimCountText = process.argv[3]?.trim() || "1";
const expectedClaimCount = Number.parseInt(expectedClaimCountText, 10);
if (
  !/^[1-9][0-9]*$/.test(expectedClaimCountText) ||
  !Number.isSafeInteger(expectedClaimCount) ||
  expectedClaimCount > 100
) {
  throw new Error(
    "terminal crash worker claim count must be an integer from 1 through 100",
  );
}

const ledger = new TerminalLedger(dbPath);
const claimed = ledger.claimDue({
  ownerId: "crashed-child",
  now: 1_000,
  leaseMs: 1_000,
  limit: expectedClaimCount,
});
if (claimed.length !== expectedClaimCount) {
  throw new Error(
    `terminal crash worker claimed ${claimed.length} operations; expected ${expectedClaimCount}`,
  );
}

for (const operation of claimed) {
  const event = operation.event as Partial<{
    schemaVersion: number;
    sourceEpoch: number;
    seq: number;
    emittedAt: number;
    duelId: string;
    competitiveSnapshotDigest: string;
    cancellationReason: string;
  }>;
  if (
    event.schemaVersion !== 3 ||
    !Number.isSafeInteger(event.sourceEpoch) ||
    !Number.isSafeInteger(event.seq) ||
    !Number.isSafeInteger(event.emittedAt) ||
    event.duelId !== operation.duelId ||
    typeof event.competitiveSnapshotDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(event.competitiveSnapshotDigest) ||
    event.cancellationReason !== "competitive_snapshot_recovery_window_elapsed"
  ) {
    throw new Error(
      "terminal crash worker requires canonical Hyperia recovery-window-elapsed events",
    );
  }
}

const checkpointOperation = claimed[0];
const event = checkpointOperation.event as {
  sourceEpoch: number;
  seq: number;
  emittedAt: number;
  competitiveSnapshotDigest: string;
};
const checkpoint = ledger.saveBettingFeedCheckpoint({
  sourceEpoch: event.sourceEpoch,
  lastAppliedSeq: event.seq - 1,
  lastEmittedAt: event.emittedAt - 1,
  duelId: checkpointOperation.duelId,
  competitiveSnapshotDigest: event.competitiveSnapshotDigest,
  phase: "FIGHTING",
  terminal: false,
  updatedAt: 1_100,
});
if (checkpoint.duelId !== checkpointOperation.duelId || checkpoint.terminal) {
  throw new Error("terminal crash worker failed to persist its recovery state");
}

setInterval(() => undefined, 60_000);
await new Promise<never>(() => undefined);
