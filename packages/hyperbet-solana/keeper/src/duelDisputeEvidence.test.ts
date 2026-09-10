import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import {
  buildBettingFeedDuelEvidence,
  digestEvidence,
  normalizeBettingFeedEvidenceFrame,
} from "./bettingFeedEvidence";
import {
  buildDuelDisputeEvidence,
  verifyDuelDisputeEvidencePackage,
  type DuelDisputeBuildEvidence,
  type DuelDisputeChainAction,
  type DuelDisputeChainTransaction,
  type DuelDisputeMarketState,
  type DuelDisputeOracleState,
} from "./duelDisputeEvidence";
import {
  verifyDuelDisputeEvidenceArtifact,
  writeDuelDisputeEvidenceArtifact,
} from "./duelDisputeEvidenceCollector";
import { buildDuelCorrelationId } from "./duelCorrelation";
import type { StreamingCycle } from "./game-client";
import { buildResultHash } from "./resultHash";
import { buildTestCompetitiveSnapshot } from "./testCompetitiveSnapshot";
import type { TerminalOperationRecord } from "./terminalLedger";

const duelId = "duel-dispute-1";
const duelKey = "41".repeat(32);
const cycleId = "cycle-dispute-1";
const betOpenTime = 1_700_000_000_000;
const betCloseTime = 1_700_000_060_000;
const fightStartTime = 1_700_000_064_000;
const duelEndTime = 1_700_000_094_000;
const seed = "42";
const replayHash = "ab".repeat(32);
const fightProgramId = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const marketProgramId = new PublicKey(Buffer.alloc(32, 8)).toBase58();
const duelStatePda = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const marketStatePda = new PublicKey(Buffer.alloc(32, 10)).toBase58();

const snapshot = buildTestCompetitiveSnapshot({
  cycleId,
  duelId,
  duelKey,
  betOpenTime,
  betCloseTime,
});

function agent(side: "A" | "B", hp = 30, damage = 0) {
  const first = side === "A";
  return {
    id: first ? "agent-a" : "agent-b",
    name: first ? "Agent A" : "Agent B",
    provider: first ? "provider-a" : "provider-b",
    model: first ? "model-a" : "model-b",
    hp,
    maxHp: 30,
    combatLevel: 42,
    wins: first ? 12 : 10,
    losses: first ? 4 : 6,
    damageDealtThisFight: damage,
    rank: first ? 1 : 2,
    headToHeadWins: first ? 3 : 2,
    headToHeadLosses: first ? 2 : 3,
  };
}

function cycle(
  seq: number,
  phase: StreamingCycle["phase"],
  overrides: Partial<StreamingCycle> = {},
): StreamingCycle {
  return {
    sourceEpoch: 12,
    seq,
    emittedAt:
      phase === "ANNOUNCEMENT"
        ? betOpenTime
        : phase === "COUNTDOWN"
          ? betCloseTime
          : phase === "FIGHTING"
            ? fightStartTime + 5_000
            : duelEndTime,
    phaseVersion: seq,
    cycleId,
    phase,
    duelId,
    duelKeyHex: duelKey,
    competitiveSnapshotVersion: snapshot.competitiveSnapshotVersion,
    competitiveSnapshotDigest: snapshot.competitiveSnapshotDigest,
    competitiveSnapshot: snapshot.competitiveSnapshot,
    betOpenTime,
    betCloseTime,
    fightStartTime:
      phase === "ANNOUNCEMENT" || phase === "COUNTDOWN"
        ? phase === "COUNTDOWN"
          ? fightStartTime
          : null
        : fightStartTime,
    duelEndTime: phase === "RESOLUTION" ? duelEndTime : null,
    winnerId: phase === "RESOLUTION" ? "agent-a" : null,
    outcome: phase === "RESOLUTION" ? "win" : null,
    cancellationReason: null,
    winReason: phase === "RESOLUTION" ? "kill" : null,
    seed: phase === "RESOLUTION" ? seed : null,
    replayHash: phase === "RESOLUTION" ? replayHash : null,
    agent1:
      phase === "RESOLUTION"
        ? agent("A", 18, 30)
        : phase === "FIGHTING"
          ? agent("A", 24, 6)
          : agent("A"),
    agent2:
      phase === "RESOLUTION"
        ? agent("B", 0, 12)
        : phase === "FIGHTING"
          ? agent("B", 26, 4)
          : agent("B"),
    ...overrides,
  };
}

function timeline() {
  const normalized = [
    cycle(1, "ANNOUNCEMENT"),
    cycle(2, "COUNTDOWN"),
    cycle(3, "FIGHTING"),
    cycle(4, "RESOLUTION"),
  ].map((frame) => normalizeBettingFeedEvidenceFrame(frame)!);
  return buildBettingFeedDuelEvidence({
    snapshot: normalized[0]!.snapshot,
    frames: normalized.map(({ frame }) => frame),
  });
}

function terminalOperation(): TerminalOperationRecord {
  return {
    id: 3,
    duelId,
    duelKey,
    correlationId: buildDuelCorrelationId({ duelId, duelKey }),
    outcome: "WIN",
    winnerSide: "A",
    participantAId: "agent-a",
    participantBId: "agent-b",
    winnerId: "agent-a",
    reason: null,
    seed,
    replayHash,
    event: {},
    fingerprint: "cd".repeat(32),
    status: "SUCCEEDED",
    attempts: 1,
    nextAttemptAt: duelEndTime,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: duelEndTime,
    updatedAt: duelEndTime + 2_000,
    completedAt: duelEndTime + 2_000,
    requeueCount: 0,
    lastRequeuedAt: null,
    lastRequeuedBy: null,
  };
}

function participantHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function oracle(): DuelDisputeOracleState {
  return {
    programId: fightProgramId,
    duelStatePda,
    accountSchemaVersion: 2,
    status: "RESOLVED",
    winnerSide: "A",
    participantAHash: participantHash("agent-a"),
    participantBHash: participantHash("agent-b"),
    competitiveSnapshotVersion: snapshot.competitiveSnapshotVersion,
    competitiveSnapshotDigest: snapshot.competitiveSnapshotDigest,
    betOpenTs: Math.floor(betOpenTime / 1_000),
    betCloseTs: Math.floor(betCloseTime / 1_000),
    duelStartTs: Math.floor(fightStartTime / 1_000),
    duelEndTs: Math.floor(duelEndTime / 1_000),
    seed,
    replayHash,
    resultHash: Buffer.from(
      buildResultHash(
        duelKey,
        "A",
        seed,
        replayHash,
        snapshot.competitiveSnapshotVersion,
        snapshot.competitiveSnapshotDigest,
      ),
    ).toString("hex"),
    metadataUri: "hyperia://duel-dispute-1",
  };
}

function market(): DuelDisputeMarketState {
  return {
    programId: marketProgramId,
    marketStatePda,
    duelStatePda,
    status: "RESOLVED",
    winnerSide: "A",
    marketKind: 1,
    tradeTreasuryFeeBpsSnapshot: 100,
    tradeMarketMakerFeeBpsSnapshot: 100,
    winningsMarketMakerFeeBpsSnapshot: 200,
    nextOrderId: "3",
    bestBid: 0,
    bestAsk: 0,
    bidBitmapHex: "0".repeat(256),
    askBitmapHex: "0".repeat(256),
    accruedTradeTreasuryFeeLamports: "0",
    accruedTradeMarketMakerFeeLamports: "0",
    authority: new PublicKey(Buffer.alloc(32, 11)).toBase58(),
    treasury: new PublicKey(Buffer.alloc(32, 12)).toBase58(),
    marketMaker: new PublicKey(Buffer.alloc(32, 13)).toBase58(),
  };
}

function buildEvidence(): DuelDisputeBuildEvidence {
  return {
    hyperia: {
      sourceRevision: "working-tree:hyperia-test",
      workingTreeDirty: true,
      files: [
        { path: "packages/server/src/index.ts", sha256: "11".repeat(32) },
      ],
    },
    hyperbet: {
      sourceRevision: "working-tree:hyperbet-test",
      workingTreeDirty: true,
      files: [
        {
          path: "packages/hyperbet-solana/keeper/src/duelBot.ts",
          sha256: "22".repeat(32),
        },
      ],
    },
    programs: [
      {
        name: "fight_oracle",
        programId: fightProgramId,
        binarySha256: "33".repeat(32),
        idlSha256: "44".repeat(32),
      },
      {
        name: "duel_market",
        programId: marketProgramId,
        binarySha256: "55".repeat(32),
        idlSha256: "66".repeat(32),
      },
    ],
  };
}

function transactions(
  excludedAction?: DuelDisputeChainAction,
): DuelDisputeChainTransaction[] {
  const actions: Array<{
    programId: string;
    action: DuelDisputeChainAction;
  }> = [
    { programId: fightProgramId, action: "oracle_betting_open" },
    { programId: marketProgramId, action: "market_initialized" },
    { programId: fightProgramId, action: "oracle_locked" },
    { programId: fightProgramId, action: "oracle_result_proposed" },
    { programId: fightProgramId, action: "oracle_result_finalized" },
    { programId: marketProgramId, action: "market_synced_resolved" },
  ];
  return actions
    .filter(({ action }) => action !== excludedAction)
    .map(({ programId, action }, index) => ({
      signature: bs58.encode(Buffer.alloc(64, index + 1)),
      slot: index + 1,
      blockTime: 1_700_000_000 + index,
      finalized: true,
      succeeded: true,
      transactionDigest: createHash("sha256")
        .update(`transaction-${index}`)
        .digest("hex"),
      programIds: [programId],
      instructionNames: [`${action}:${index}`],
      actions: [action],
    }));
}

function validInput() {
  return {
    generatedAt: duelEndTime + 5_000,
    classification: {
      chain: "solana" as const,
      cluster: "localnet" as const,
      externalValue: false,
      productionEquivalentInfrastructure: false,
      releaseEligible: false,
    },
    buildEvidence: buildEvidence(),
    timeline: timeline(),
    terminalOperation: terminalOperation(),
    oracle: oracle(),
    market: market(),
    transactions: transactions(),
  };
}

describe("SOL duel dispute evidence package", () => {
  test("binds the competitive snapshot, material timeline, terminal truth, programs, and finalized chain actions", () => {
    const evidence = buildDuelDisputeEvidence(validInput());
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      proof: "hyperia-hyperbet-sol-duel-dispute-evidence",
      identity: {
        duelId,
        duelKey,
        correlationId: buildDuelCorrelationId({ duelId, duelKey }),
        participantAId: "agent-a",
        participantBId: "agent-b",
      },
      terminal: {
        operationId: 3,
        outcome: "WIN",
        winnerSide: "A",
        replayHash,
      },
      oracle: {
        status: "RESOLVED",
        winnerSide: "A",
        accountSchemaVersion: 2,
      },
      market: { status: "RESOLVED", winnerSide: "A" },
    });
    expect(evidence.terminal.resultHash).toBe(oracle().resultHash);
    expect(evidence.timeline.frames.map(({ phase }) => phase)).toEqual([
      "ANNOUNCEMENT",
      "COUNTDOWN",
      "FIGHTING",
      "RESOLUTION",
    ]);
    expect(verifyDuelDisputeEvidencePackage(evidence)).toBe(true);
  });

  test("retains legacy evidence while rejecting correlation drift", () => {
    const evidence = buildDuelDisputeEvidence(validInput());
    const schemaV1Evidence = structuredClone(evidence);
    schemaV1Evidence.schemaVersion = 1;
    delete schemaV1Evidence.oracle.accountSchemaVersion;
    const { packageDigest: _schemaV1Digest, ...schemaV1Payload } =
      schemaV1Evidence;
    schemaV1Evidence.packageDigest = digestEvidence(schemaV1Payload);
    expect(verifyDuelDisputeEvidencePackage(schemaV1Evidence)).toBe(true);

    const legacyEvidence = structuredClone(evidence);
    delete legacyEvidence.identity.correlationId;
    const { packageDigest: _legacyDigest, ...legacyPayload } = legacyEvidence;
    legacyEvidence.packageDigest = digestEvidence(legacyPayload);
    expect(verifyDuelDisputeEvidencePackage(legacyEvidence)).toBe(true);

    const drifted = structuredClone(evidence);
    drifted.identity.correlationId = "ff".repeat(32);
    const { packageDigest: _driftedDigest, ...driftedPayload } = drifted;
    drifted.packageDigest = digestEvidence(driftedPayload);
    expect(verifyDuelDisputeEvidencePackage(drifted)).toBe(false);

    expect(() =>
      buildDuelDisputeEvidence({
        ...validInput(),
        terminalOperation: {
          ...terminalOperation(),
          correlationId: "ff".repeat(32),
        },
      }),
    ).toThrow("terminal operation is not final");
  });

  test("fails closed on result, participant, timing, or required-action drift", () => {
    expect(() =>
      buildDuelDisputeEvidence({
        ...validInput(),
        oracle: { ...oracle(), accountSchemaVersion: 1 },
      }),
    ).toThrow("account schema v1 is unsupported");
    expect(() =>
      buildDuelDisputeEvidence({
        ...validInput(),
        oracle: { ...oracle(), resultHash: "ff".repeat(32) },
      }),
    ).toThrow("resolved result drifted: resultHash");
    expect(() =>
      buildDuelDisputeEvidence({
        ...validInput(),
        terminalOperation: {
          ...terminalOperation(),
          participantAId: "other-agent",
        },
      }),
    ).toThrow("participant identity drifted");
    expect(() =>
      buildDuelDisputeEvidence({
        ...validInput(),
        oracle: { ...oracle(), duelEndTs: oracle().duelEndTs + 1 },
      }),
    ).toThrow("drifted");
    expect(() =>
      buildDuelDisputeEvidence({
        ...validInput(),
        transactions: transactions("oracle_result_finalized"),
      }),
    ).toThrow("oracle_result_finalized");
  });

  test("cannot label a local dirty package release-eligible", () => {
    expect(() =>
      buildDuelDisputeEvidence({
        ...validInput(),
        classification: {
          chain: "solana",
          cluster: "mainnet-beta",
          externalValue: true,
          productionEquivalentInfrastructure: true,
          releaseEligible: true,
        },
      }),
    ).toThrow("cannot mark this build release-eligible");
  });

  test("binds a pre-fight cancellation without inventing an on-chain end timestamp", () => {
    const announcement = normalizeBettingFeedEvidenceFrame(
      cycle(1, "ANNOUNCEMENT"),
    )!;
    const cancelled = normalizeBettingFeedEvidenceFrame(
      cycle(2, "RESOLUTION", {
        emittedAt: betCloseTime - 5_000,
        fightStartTime: null,
        duelEndTime: betCloseTime - 5_000,
        winnerId: null,
        outcome: "cancelled",
        cancellationReason: "preparation-failed",
        winReason: null,
        seed: null,
        replayHash: null,
        agent1: agent("A"),
        agent2: agent("B"),
      }),
    )!;
    const cancelledTimeline = buildBettingFeedDuelEvidence({
      snapshot: announcement.snapshot,
      frames: [announcement.frame, cancelled.frame],
    });
    const actionRows: Array<{
      programId: string;
      action: DuelDisputeChainAction;
    }> = [
      { programId: fightProgramId, action: "oracle_betting_open" },
      { programId: marketProgramId, action: "market_initialized" },
      { programId: fightProgramId, action: "oracle_cancelled" },
      { programId: marketProgramId, action: "market_synced_cancelled" },
    ];
    const evidence = buildDuelDisputeEvidence({
      ...validInput(),
      timeline: cancelledTimeline,
      terminalOperation: {
        ...terminalOperation(),
        outcome: "CANCELLED",
        winnerSide: null,
        winnerId: null,
        reason: "preparation-failed",
        seed: null,
        replayHash: null,
      },
      oracle: {
        ...oracle(),
        status: "CANCELLED",
        winnerSide: null,
        duelEndTs: 0,
        seed: "0",
        replayHash: "0".repeat(64),
        resultHash: "0".repeat(64),
      },
      market: { ...market(), status: "CANCELLED", winnerSide: null },
      transactions: actionRows.map(({ programId, action }, index) => ({
        signature: bs58.encode(Buffer.alloc(64, 20 + index)),
        slot: 20 + index,
        blockTime: 1_700_000_020 + index,
        finalized: true,
        succeeded: true,
        transactionDigest: createHash("sha256")
          .update(`cancel-transaction-${index}`)
          .digest("hex"),
        programIds: [programId],
        instructionNames: [`${action}:${index}`],
        actions: [action],
      })),
    });
    expect(evidence.terminal.outcome).toBe("CANCELLED");
    expect(evidence.oracle.duelEndTs).toBe(0);
    expect(verifyDuelDisputeEvidencePackage(evidence)).toBe(true);
  });

  test("detects any mutation after package generation", () => {
    const evidence = buildDuelDisputeEvidence(validInput());
    expect(
      verifyDuelDisputeEvidencePackage({
        ...evidence,
        terminal: { ...evidence.terminal, winnerId: "agent-b" },
      }),
    ).toBe(false);
  });

  test("rejects a semantically forged package even when its digest is recomputed", () => {
    const evidence = buildDuelDisputeEvidence(validInput());
    const forgedPayload = {
      ...evidence,
      terminal: { ...evidence.terminal, winnerId: "agent-b" },
    };
    const { packageDigest: _ignored, ...payload } = forgedPayload;
    expect(
      verifyDuelDisputeEvidencePackage({
        ...forgedPayload,
        packageDigest: digestEvidence(payload),
      }),
    ).toBe(false);
  });

  test("writes one private canonical artifact and refuses to overwrite it", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "duel-dispute-evidence-"),
    );
    try {
      const outputPath = path.join(directory, "duel.json");
      const evidence = buildDuelDisputeEvidence(validInput());
      const result = writeDuelDisputeEvidenceArtifact({
        outputPath,
        evidence,
      });
      expect(result.packageDigest).toBe(evidence.packageDigest);
      expect(result.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual(evidence);
      expect(() =>
        writeDuelDisputeEvidenceArtifact({ outputPath, evidence }),
      ).toThrow();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("independently verifies canonical artifact bytes and exact reviewer expectations", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "duel-dispute-verify-"),
    );
    try {
      const outputPath = path.join(directory, "duel.json");
      const evidence = buildDuelDisputeEvidence(validInput());
      const written = writeDuelDisputeEvidenceArtifact({
        outputPath,
        evidence,
      });
      expect(
        verifyDuelDisputeEvidenceArtifact({
          inputPath: outputPath,
          expectedArtifactSha256: written.artifactSha256,
          expectedPackageDigest: written.packageDigest,
          expectedDuelId: duelId,
          expectedDuelKey: duelKey,
          expectedCluster: "localnet",
        }),
      ).toMatchObject({
        artifactSha256: written.artifactSha256,
        packageDigest: written.packageDigest,
        duelId,
        duelKey,
        transactionCount: 6,
      });
      expect(() =>
        verifyDuelDisputeEvidenceArtifact({
          inputPath: outputPath,
          expectedArtifactSha256: "ff".repeat(32),
        }),
      ).toThrow("artifact SHA-256 mismatch");
      expect(() =>
        verifyDuelDisputeEvidenceArtifact({
          inputPath: outputPath,
          requireReleaseEligible: true,
        }),
      ).toThrow("not release-eligible");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects noncanonical or mutated artifact files", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "duel-dispute-noncanonical-"),
    );
    try {
      const evidence = buildDuelDisputeEvidence(validInput());
      const noncanonicalPath = path.join(directory, "pretty.json");
      fs.writeFileSync(noncanonicalPath, JSON.stringify(evidence, null, 2));
      expect(() =>
        verifyDuelDisputeEvidenceArtifact({ inputPath: noncanonicalPath }),
      ).toThrow("not canonical");

      const mutatedPath = path.join(directory, "mutated.json");
      fs.writeFileSync(
        mutatedPath,
        `${JSON.stringify({
          ...evidence,
          terminal: { ...evidence.terminal, winnerId: "agent-b" },
        })}\n`,
      );
      expect(() =>
        verifyDuelDisputeEvidenceArtifact({ inputPath: mutatedPath }),
      ).toThrow("package verification failed");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
