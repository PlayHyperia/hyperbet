import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { canonicalEvidenceJson, digestEvidence } from "./bettingFeedEvidence";
import {
  verifyPlatformRecoveryRehearsal,
  type VerifyPlatformRecoveryRehearsalInput,
} from "./platformRecoveryRehearsal";

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_APPLICATION_READINESS_BYTES = 512 * 1024;
const MAX_QUERY_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_DUEL_FACTS = 100_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,63}$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const HYPERIA_RECOVERY_QUERY = String.raw`
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SELECT payload
FROM (
  SELECT
    0 AS ordinal,
    ''::text AS duel_sort,
    jsonb_build_object(
      'kind', 'meta',
      'databaseName', current_database(),
      'serverVersionNum', current_setting('server_version_num'),
      'transactionSnapshot', pg_current_snapshot()::text
    )::text AS payload
  UNION ALL
  SELECT
    1 AS ordinal,
    snapshot."duelId" AS duel_sort,
    jsonb_build_object(
      'kind', 'duel',
      'preparationId', snapshot."preparationId",
      'cycleId', snapshot."cycleId",
      'duelId', snapshot."duelId",
      'duelKey', snapshot."duelKey",
      'snapshotVersion', snapshot."snapshotVersion",
      'snapshotDigest', snapshot."snapshotDigest",
      'snapshot', snapshot."snapshot",
      'frozenAt', snapshot."frozenAt"::text,
      'lifecycleStatus', snapshot."lifecycleStatus",
      'agent1Id', preparation."agent1Id",
      'agent2Id', preparation."agent2Id",
      'terminalOutcome', snapshot."terminalOutcome",
      'terminalWinnerId', snapshot."terminalWinnerId",
      'terminalWinReason', snapshot."terminalWinReason",
      'terminalCancellationReason', snapshot."terminalCancellationReason",
      'terminalSeed', snapshot."terminalSeed",
      'terminalReplayHash', snapshot."terminalReplayHash",
      'terminalAt', snapshot."terminalAt"::text
    )::text AS payload
  FROM "streaming_duel_competitive_snapshots" AS snapshot
  JOIN "streaming_duel_preparations" AS preparation
    ON preparation."preparationId" = snapshot."preparationId"
  WHERE snapshot."lifecycleStatus" <> 'retired'
     OR snapshot."terminalAt" IS NOT NULL
) AS recovery_rows
ORDER BY ordinal, duel_sort COLLATE "C";
COMMIT;
`;

type BoundFile = {
  fileName: string;
  sha256: string;
  bytes: number;
};

export type HyperiaRestoredDuelFact = {
  preparationId: string;
  cycleId: string;
  duelId: string;
  duelKey: string;
  snapshotVersion: number;
  snapshotDigest: string;
  snapshot: Record<string, unknown>;
  frozenAt: number;
  lifecycleStatus: "frozen" | "terminal" | "retired";
  agent1Id: string;
  agent2Id: string;
  terminalOutcome: "win" | "draw" | "cancelled" | null;
  terminalWinnerId: string | null;
  terminalWinReason:
    "kill" | "forfeit" | "hp_advantage" | "damage_advantage" | "draw" | null;
  terminalCancellationReason: string | null;
  terminalSeed: string | null;
  terminalReplayHash: string | null;
  terminalAt: number | null;
};

export type HyperiaRestoredDuelInspection = {
  databaseName: string;
  serverVersionNum: string;
  facts: HyperiaRestoredDuelFact[];
  stateSha256: string;
};

type HyperiaDuelQueryInput = {
  databaseName: string;
  timeoutMs: number;
};

export type HyperiaDuelQueryTool = {
  query(input: HyperiaDuelQueryInput): Promise<string>;
};

type ReconciliationPaths = {
  reconciliationManifestPath: string;
  applicationReadinessPath: string;
};

export type CreateRestoredDuelStateReconciliationInput =
  VerifyPlatformRecoveryRehearsalInput &
    ReconciliationPaths & {
      queryTimeoutMs: number;
      psqlExecutable?: string;
      hyperiaQueryTool?: HyperiaDuelQueryTool;
      now?: () => Date;
      createId?: () => string;
    };

export type VerifyRestoredDuelStateReconciliationInput =
  VerifyPlatformRecoveryRehearsalInput &
    ReconciliationPaths & {
      queryTimeoutMs: number;
      psqlExecutable?: string;
      hyperiaQueryTool?: HyperiaDuelQueryTool;
    };

export type RestoredDuelStateReconciliationManifest = {
  schemaVersion: 1;
  createdAt: string;
  reconciliationId: string;
  rehearsalId: string;
  boundaryId: string;
  createdAfterRehearsalMs: number;
  createdAfterApplicationReadinessMs: number;
  verificationScope: "cross_repository_restored_duel_state_and_application_read_projection";
  activationRequiresSeparateApproval: true;
  productionCutoverAuthorized: false;
  hyperia: {
    databaseName: string;
    serverVersionNum: string;
    restoreVerificationId: string;
    duelCount: number;
    terminalDuelCount: number;
    stateSha256: string;
    applicationReadiness: {
      applicationReadinessId: string;
      createdAt: string;
      routeContract: "/api/streaming/leaderboard/details";
      historyLimit: 200;
      recentDuelCount: number;
      projectedCompetitiveDuelCount: number;
      publicRecentDuelsSha256: string;
      projectedCompetitiveDuelStateSha256: string;
    };
  };
  hyperbet: {
    materializationId: string;
    duelCount: number;
    terminalOperationCount: number;
    evidenceFrameCount: number;
    checkpointDuelId: string | null;
    stateSha256: string;
  };
  matchedDuelCount: number;
  matchedTerminalCount: number;
  reconciledStateSha256: string;
  files: {
    platformRecoveryRehearsal: BoundFile;
    keeperMaterializationRecord: BoundFile;
    hyperiaApplicationReadiness: BoundFile;
  };
};

type HyperiaApplicationReadinessEvidence = {
  schemaVersion: 1;
  createdAt: string;
  applicationReadinessId: string;
  restoreVerificationId: string;
  releaseSha: string;
  boundaryId: string;
  restoredDatabaseName: string;
  targetServerVersionNum: string;
  restoreEvidence: BoundFile;
  routeContract: "/api/streaming/leaderboard/details";
  historyLimit: 200;
  recentDuelCount: number;
  projectedCompetitiveDuelCount: number;
  winCount: number;
  drawCount: number;
  cancelledCount: number;
  publicRecentDuelsSha256: string;
  projectedCompetitiveDuelStateSha256: string;
  projectedCompetitiveDuels: HyperiaApplicationDuelFact[];
  verificationScope: "restored_hyperia_application_read_projection_only";
  databaseMutationAuthorized: false;
  activationRequiresSeparateApproval: true;
  productionCutoverAuthorized: false;
};

type HyperiaApplicationDuelFact = {
  cycleId: string;
  duelId: string;
  finishedAt: number;
  outcome: "win" | "draw" | "cancelled";
  agent1Id: string;
  agent2Id: string;
  winnerId: string | null;
  winReason:
    "kill" | "forfeit" | "hp_advantage" | "damage_advantage" | "draw" | null;
  cancellationReason:
    | "insufficient_verified_combat"
    | "contestant_unavailable"
    | "broadcast_interrupted"
    | "no_contest"
    | null;
};

type KeeperSnapshot = {
  duelId: string;
  duelKey: string;
  snapshotDigest: string;
  snapshot: Record<string, unknown>;
  firstSourceEpoch: number;
  firstSeq: number;
  firstEmittedAt: number;
};

type KeeperTerminalOperation = {
  duelId: string;
  duelKey: string;
  fingerprint: string;
  outcome: "WIN" | "DRAW" | "CANCELLED";
  winnerSide: "A" | "B" | null;
  participantAId: string | null;
  participantBId: string | null;
  winnerId: string | null;
  reason: string | null;
  seed: string | null;
  replayHash: string | null;
  status: string;
};

type KeeperInspection = {
  snapshots: KeeperSnapshot[];
  terminals: KeeperTerminalOperation[];
  evidenceFrameCount: number;
  checkpointDuelId: string | null;
  stateSha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function requiredText(value: unknown, label: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nullableText(value: unknown, label: string, max = 256): string | null {
  return value === null ? null : requiredText(value, label, max);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function decimalSafeInteger(
  value: unknown,
  label: string,
  nullable = false,
): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function assertSnapshotIdentity(fact: HyperiaRestoredDuelFact): void {
  const snapshot = fact.snapshot;
  if (
    snapshot.snapshotVersion !== fact.snapshotVersion ||
    snapshot.preparationId !== fact.preparationId ||
    snapshot.cycleId !== fact.cycleId ||
    snapshot.duelId !== fact.duelId ||
    snapshot.duelKey !== fact.duelKey ||
    snapshot.frozenAt !== fact.frozenAt ||
    !Array.isArray(snapshot.contestants) ||
    snapshot.contestants.length !== 2 ||
    !isRecord(snapshot.contestants[0]) ||
    !isRecord(snapshot.contestants[1]) ||
    snapshot.contestants[0].side !== "agent1" ||
    snapshot.contestants[0].agentId !== fact.agent1Id ||
    snapshot.contestants[1].side !== "agent2" ||
    snapshot.contestants[1].agentId !== fact.agent2Id ||
    digestEvidence(snapshot) !== fact.snapshotDigest
  ) {
    throw new Error(
      `Hyperia restored snapshot identity drifted for ${fact.duelId}`,
    );
  }
}

function parseHyperiaDuel(
  value: Record<string, unknown>,
): HyperiaRestoredDuelFact {
  const keys = [
    "kind",
    "preparationId",
    "cycleId",
    "duelId",
    "duelKey",
    "snapshotVersion",
    "snapshotDigest",
    "snapshot",
    "frozenAt",
    "lifecycleStatus",
    "agent1Id",
    "agent2Id",
    "terminalOutcome",
    "terminalWinnerId",
    "terminalWinReason",
    "terminalCancellationReason",
    "terminalSeed",
    "terminalReplayHash",
    "terminalAt",
  ] as const;
  if (!hasExactKeys(value, keys) || value.kind !== "duel") {
    throw new Error("Hyperia restored duel row is invalid");
  }
  const lifecycleStatus = value.lifecycleStatus;
  if (
    lifecycleStatus !== "frozen" &&
    lifecycleStatus !== "terminal" &&
    lifecycleStatus !== "retired"
  ) {
    throw new Error("Hyperia restored duel lifecycle is invalid");
  }
  const terminalOutcome = value.terminalOutcome;
  if (
    terminalOutcome !== null &&
    terminalOutcome !== "win" &&
    terminalOutcome !== "draw" &&
    terminalOutcome !== "cancelled"
  ) {
    throw new Error("Hyperia restored duel outcome is invalid");
  }
  const terminalWinReason = value.terminalWinReason;
  if (
    terminalWinReason !== null &&
    terminalWinReason !== "kill" &&
    terminalWinReason !== "forfeit" &&
    terminalWinReason !== "hp_advantage" &&
    terminalWinReason !== "damage_advantage" &&
    terminalWinReason !== "draw"
  ) {
    throw new Error("Hyperia restored duel win reason is invalid");
  }
  const snapshot = value.snapshot;
  if (!isRecord(snapshot)) {
    throw new Error("Hyperia restored competitive snapshot is invalid");
  }
  const duelKey = requiredText(value.duelKey, "Hyperia restored duel key", 64);
  const snapshotDigest = requiredText(
    value.snapshotDigest,
    "Hyperia restored snapshot digest",
    64,
  );
  if (!SHA256_PATTERN.test(duelKey) || !SHA256_PATTERN.test(snapshotDigest)) {
    throw new Error("Hyperia restored duel digest identity is invalid");
  }
  const fact: HyperiaRestoredDuelFact = {
    preparationId: requiredText(
      value.preparationId,
      "Hyperia restored preparation ID",
      128,
    ),
    cycleId: requiredText(value.cycleId, "Hyperia restored cycle ID", 128),
    duelId: requiredText(value.duelId, "Hyperia restored duel ID", 256),
    duelKey,
    snapshotVersion: safeInteger(
      value.snapshotVersion,
      "Hyperia restored snapshot version",
      1,
    ),
    snapshotDigest,
    snapshot,
    frozenAt: decimalSafeInteger(
      value.frozenAt,
      "Hyperia restored frozen time",
    )!,
    lifecycleStatus,
    agent1Id: requiredText(value.agent1Id, "Hyperia restored agent 1 ID", 128),
    agent2Id: requiredText(value.agent2Id, "Hyperia restored agent 2 ID", 128),
    terminalOutcome,
    terminalWinnerId: nullableText(
      value.terminalWinnerId,
      "Hyperia restored terminal winner",
      128,
    ),
    terminalWinReason,
    terminalCancellationReason: nullableText(
      value.terminalCancellationReason,
      "Hyperia restored cancellation reason",
      128,
    ),
    terminalSeed: nullableText(
      value.terminalSeed,
      "Hyperia restored terminal seed",
      20,
    ),
    terminalReplayHash: nullableText(
      value.terminalReplayHash,
      "Hyperia restored replay hash",
      64,
    ),
    terminalAt: decimalSafeInteger(
      value.terminalAt,
      "Hyperia restored terminal time",
      true,
    ),
  };
  if (fact.agent1Id === fact.agent2Id) {
    throw new Error("Hyperia restored duel participants are not distinct");
  }
  if (fact.terminalOutcome === null) {
    if (
      fact.lifecycleStatus !== "frozen" ||
      fact.terminalWinnerId !== null ||
      fact.terminalWinReason !== null ||
      fact.terminalCancellationReason !== null ||
      fact.terminalSeed !== null ||
      fact.terminalReplayHash !== null ||
      fact.terminalAt !== null
    ) {
      throw new Error(
        "Hyperia restored nonterminal duel contains terminal state",
      );
    }
  } else if (
    fact.lifecycleStatus === "frozen" ||
    fact.terminalAt === null ||
    fact.terminalAt < fact.frozenAt
  ) {
    throw new Error("Hyperia restored terminal duel lifecycle is invalid");
  }
  if (
    fact.terminalOutcome === "win" &&
    (fact.terminalWinnerId === null ||
      ![fact.agent1Id, fact.agent2Id].includes(fact.terminalWinnerId) ||
      fact.terminalWinReason === null ||
      fact.terminalWinReason === "draw" ||
      fact.terminalCancellationReason !== null ||
      fact.terminalSeed === null ||
      !/^(0|[1-9][0-9]{0,19})$/u.test(fact.terminalSeed) ||
      fact.terminalReplayHash === null ||
      !SHA256_PATTERN.test(fact.terminalReplayHash))
  ) {
    throw new Error("Hyperia restored winning duel state is invalid");
  }
  if (
    fact.terminalOutcome === "draw" &&
    (fact.terminalWinnerId !== null ||
      fact.terminalWinReason !== "draw" ||
      fact.terminalCancellationReason !== "draw" ||
      fact.terminalSeed === null ||
      !/^(0|[1-9][0-9]{0,19})$/u.test(fact.terminalSeed) ||
      fact.terminalReplayHash === null ||
      !SHA256_PATTERN.test(fact.terminalReplayHash))
  ) {
    throw new Error("Hyperia restored drawn duel state is invalid");
  }
  if (
    fact.terminalOutcome === "cancelled" &&
    (fact.terminalWinnerId !== null ||
      fact.terminalWinReason !== null ||
      fact.terminalCancellationReason === null ||
      fact.terminalSeed !== null ||
      fact.terminalReplayHash !== null)
  ) {
    throw new Error("Hyperia restored cancelled duel state is invalid");
  }
  assertSnapshotIdentity(fact);
  return fact;
}

export function parseHyperiaRestoredDuelInspection(
  stdout: string,
  expectedDatabaseName: string,
): HyperiaRestoredDuelInspection {
  if (Buffer.byteLength(stdout) > MAX_QUERY_OUTPUT_BYTES) {
    throw new Error("Hyperia restored duel query output exceeded its bound");
  }
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("Hyperia restored duel query returned no state");
  }
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error("Hyperia restored duel query returned invalid JSON");
    }
  });
  const meta = parsed[0];
  if (
    !isRecord(meta) ||
    !hasExactKeys(meta, [
      "kind",
      "databaseName",
      "serverVersionNum",
      "transactionSnapshot",
    ]) ||
    meta.kind !== "meta" ||
    meta.databaseName !== expectedDatabaseName ||
    typeof meta.serverVersionNum !== "string" ||
    !/^[0-9]{5,6}$/u.test(meta.serverVersionNum)
  ) {
    throw new Error("Hyperia restored duel query database identity is invalid");
  }
  requiredText(meta.transactionSnapshot, "Hyperia transaction snapshot", 256);
  const facts = parsed.slice(1).map((value) => {
    if (!isRecord(value))
      throw new Error("Hyperia restored duel row is invalid");
    return parseHyperiaDuel(value);
  });
  if (facts.length > MAX_DUEL_FACTS) {
    throw new Error("Hyperia restored duel count exceeded its bound");
  }
  const duelIds = new Set<string>();
  const duelKeys = new Set<string>();
  const snapshotDigests = new Set<string>();
  for (const fact of facts) {
    if (
      duelIds.has(fact.duelId) ||
      duelKeys.has(fact.duelKey) ||
      snapshotDigests.has(fact.snapshotDigest)
    ) {
      throw new Error("Hyperia restored duel identity is duplicated");
    }
    duelIds.add(fact.duelId);
    duelKeys.add(fact.duelKey);
    snapshotDigests.add(fact.snapshotDigest);
  }
  return {
    databaseName: expectedDatabaseName,
    serverVersionNum: meta.serverVersionNum,
    facts,
    stateSha256: digestEvidence(facts),
  };
}

function assertPrivateFile(filePath: string, label: string, maxBytes: number) {
  const stats = lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.size <= 0 ||
    stats.size > maxBytes ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be a bounded mode-0600 regular file`);
  }
  return stats;
}

function bindPrivateFile(
  filePath: string,
  label: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): BoundFile {
  const pathStats = assertPrivateFile(filePath, label, maxBytes);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== pathStats.dev ||
      opened.ino !== pathStats.ino ||
      opened.size !== pathStats.size ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error(`${label} changed while being hashed`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const final = fstatSync(descriptor);
    if (
      bytes !== opened.size ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label} changed while being hashed`);
    }
    return {
      fileName: path.basename(filePath),
      sha256: hash.digest("hex"),
      bytes,
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function validatePgEnvironment(databaseName: string): NodeJS.ProcessEnv {
  for (const forbidden of [
    "PGPASSWORD",
    "DATABASE_URL",
    "POSTGRES_URL",
    "PGSERVICE",
    "PGOPTIONS",
  ]) {
    if (process.env[forbidden]?.trim()) {
      throw new Error(
        "reconciliation connection cannot use password-bearing aliases or service overrides",
      );
    }
  }
  const host = requiredText(process.env.PGHOST, "PGHOST", 255);
  const port = requiredText(process.env.PGPORT, "PGPORT", 5);
  const user = requiredText(process.env.PGUSER, "PGUSER", 63);
  const configuredDatabase = requiredText(
    process.env.PGDATABASE,
    "PGDATABASE",
    63,
  );
  const sslMode = requiredText(process.env.PGSSLMODE, "PGSSLMODE", 16);
  if (
    !/^[0-9]{1,5}$/u.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65_535 ||
    configuredDatabase !== databaseName ||
    !DATABASE_NAME_PATTERN.test(databaseName) ||
    !["disable", "require", "verify-ca", "verify-full"].includes(sslMode)
  ) {
    throw new Error("reconciliation PostgreSQL connection is invalid");
  }
  const pgpassPath = requiredText(process.env.PGPASSFILE, "PGPASSFILE", 4096);
  const stats = assertPrivateFile(pgpassPath, "PGPASSFILE", 64 * 1024);
  const descriptor = openSync(
    pgpassPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error("PGPASSFILE changed while being validated");
    }
    const text = readFileSync(descriptor, "utf8");
    const final = fstatSync(descriptor);
    if (
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("PGPASSFILE changed while being validated");
    }
    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length !== 1) {
      throw new Error("PGPASSFILE must contain one canonical credential entry");
    }
    const fields: string[] = [];
    let field = "";
    let escaped = false;
    for (const character of lines[0]!) {
      if (escaped) {
        if (character !== ":" && character !== "\\") {
          throw new Error("PGPASSFILE contains an invalid escape");
        }
        field += character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === ":") {
        fields.push(field);
        field = "";
      } else {
        field += character;
      }
    }
    if (escaped) throw new Error("PGPASSFILE contains an incomplete escape");
    fields.push(field);
    if (
      fields.length !== 5 ||
      fields[0] !== host ||
      fields[1] !== port ||
      fields[2] !== databaseName ||
      fields[3] !== user ||
      !fields[4]
    ) {
      throw new Error(
        "PGPASSFILE credential does not exactly match the reconciliation connection",
      );
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    PATH: process.env.PATH,
    PGHOST: host,
    PGPORT: port,
    PGDATABASE: databaseName,
    PGUSER: user,
    PGPASSFILE: pgpassPath,
    PGSSLMODE: sslMode,
    PGAPPNAME: "hyperbet-restored-duel-reconciliation",
    PGCONNECT_TIMEOUT: "10",
  };
}

async function runPsqlQuery(
  executable: string,
  databaseName: string,
  timeoutMs: number,
): Promise<string> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 900_000
  ) {
    throw new Error("reconciliation query timeout is invalid");
  }
  const environment = validatePgEnvironment(databaseName);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        "--no-psqlrc",
        "--quiet",
        "--tuples-only",
        "--no-align",
        "--set=ON_ERROR_STOP=1",
        `--dbname=${databaseName}`,
        `--command=${HYPERIA_RECOVERY_QUERY}`,
      ],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("reconciliation PostgreSQL query timed out"));
      }
    }, timeoutMs);
    const observe = (chunk: Buffer, retain: boolean): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_QUERY_OUTPUT_BYTES) child.kill("SIGKILL");
      if (retain) output.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => observe(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => observe(chunk, false));
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("reconciliation PostgreSQL query could not start"));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || bytes > MAX_QUERY_OUTPUT_BYTES) {
        reject(new Error("reconciliation PostgreSQL query failed"));
        return;
      }
      resolve(Buffer.concat(output).toString("utf8"));
    });
  });
}

function defaultQueryTool(executable = "psql"): HyperiaDuelQueryTool {
  return {
    query: ({ databaseName, timeoutMs }) =>
      runPsqlQuery(executable, databaseName, timeoutMs),
  };
}

function parseKeeperSnapshot(row: Record<string, unknown>): KeeperSnapshot {
  const duelId = requiredText(row.duelId, "keeper snapshot duel ID", 256);
  const duelKey = requiredText(row.duelKey, "keeper snapshot duel key", 64);
  const snapshotDigest = requiredText(
    row.snapshotDigest,
    "keeper snapshot digest",
    64,
  );
  if (!SHA256_PATTERN.test(duelKey) || !SHA256_PATTERN.test(snapshotDigest)) {
    throw new Error("keeper snapshot digest identity is invalid");
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(
      requiredText(
        row.snapshotJson,
        "keeper snapshot JSON",
        MAX_QUERY_OUTPUT_BYTES,
      ),
    );
  } catch {
    throw new Error("keeper competitive snapshot JSON is invalid");
  }
  if (!isRecord(snapshot) || digestEvidence(snapshot) !== snapshotDigest) {
    throw new Error(`keeper competitive snapshot digest drifted for ${duelId}`);
  }
  return {
    duelId,
    duelKey,
    snapshotDigest,
    snapshot,
    firstSourceEpoch: safeInteger(
      row.firstSourceEpoch,
      "keeper snapshot source epoch",
      1,
    ),
    firstSeq: safeInteger(row.firstSeq, "keeper snapshot first sequence", 1),
    firstEmittedAt: safeInteger(
      row.firstEmittedAt,
      "keeper snapshot first emitted time",
      1,
    ),
  };
}

function parseKeeperTerminal(
  row: Record<string, unknown>,
): KeeperTerminalOperation {
  const outcome = row.outcome;
  const winnerSide = row.winnerSide;
  if (
    (outcome !== "WIN" && outcome !== "DRAW" && outcome !== "CANCELLED") ||
    (winnerSide !== null && winnerSide !== "A" && winnerSide !== "B")
  ) {
    throw new Error("keeper terminal operation classification is invalid");
  }
  const operation: KeeperTerminalOperation = {
    duelId: requiredText(row.duelId, "keeper terminal duel ID", 256),
    duelKey: requiredText(row.duelKey, "keeper terminal duel key", 64),
    fingerprint: requiredText(
      row.fingerprint,
      "keeper terminal fingerprint",
      64,
    ),
    outcome,
    winnerSide,
    participantAId: nullableText(
      row.participantAId,
      "keeper participant A",
      128,
    ),
    participantBId: nullableText(
      row.participantBId,
      "keeper participant B",
      128,
    ),
    winnerId: nullableText(row.winnerId, "keeper terminal winner", 128),
    reason: nullableText(row.reason, "keeper terminal reason", 128),
    seed: nullableText(row.seed, "keeper terminal seed", 20),
    replayHash: nullableText(row.replayHash, "keeper terminal replay hash", 64),
    status: requiredText(row.status, "keeper terminal status", 32),
  };
  if (
    !SHA256_PATTERN.test(operation.duelKey) ||
    !SHA256_PATTERN.test(operation.fingerprint) ||
    operation.status !== "SUCCEEDED"
  ) {
    throw new Error("keeper terminal operation is not quiescent and succeeded");
  }
  const expectedFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        duelId: operation.duelId,
        duelKey: operation.duelKey,
        outcome: operation.outcome,
        winnerSide: operation.winnerSide,
        participantAId: operation.participantAId,
        participantBId: operation.participantBId,
        winnerId: operation.winnerId,
        reason: operation.reason,
        seed: operation.seed,
        replayHash: operation.replayHash,
      }),
    )
    .digest("hex");
  if (operation.fingerprint !== expectedFingerprint) {
    throw new Error(
      `keeper terminal fingerprint drifted for ${operation.duelId}`,
    );
  }
  return operation;
}

function inspectKeeper(materializedRootPath: string): KeeperInspection {
  const databasePath = path.join(materializedRootPath, "keeper.sqlite");
  assertPrivateFile(
    databasePath,
    "materialized keeper database",
    Number.MAX_SAFE_INTEGER,
  );
  const database = new Database(databasePath, { readonly: true });
  try {
    database.run("PRAGMA query_only = ON");
    const snapshotRows = database
      .query(
        `SELECT
           duel_id AS duelId,
           duel_key AS duelKey,
           competitive_snapshot_digest AS snapshotDigest,
           competitive_snapshot_json AS snapshotJson,
           first_source_epoch AS firstSourceEpoch,
           first_seq AS firstSeq,
           first_emitted_at AS firstEmittedAt
         FROM betting_feed_competitive_snapshots
         ORDER BY duel_id`,
      )
      .all() as Array<Record<string, unknown>>;
    const terminalRows = database
      .query(
        `SELECT
           duel_id AS duelId,
           duel_key AS duelKey,
           fingerprint,
           outcome,
           winner_side AS winnerSide,
           participant_a_id AS participantAId,
           participant_b_id AS participantBId,
           winner_id AS winnerId,
           reason,
           seed,
           replay_hash AS replayHash,
           status
         FROM terminal_operations
         ORDER BY duel_id`,
      )
      .all() as Array<Record<string, unknown>>;
    const conflict = database
      .query("SELECT COUNT(*) AS count FROM terminal_operation_conflicts")
      .get() as { count?: unknown } | null;
    if (safeInteger(conflict?.count, "keeper terminal conflict count") !== 0) {
      throw new Error("keeper recovery contains terminal operation conflicts");
    }
    const frameCountRow = database
      .query("SELECT COUNT(*) AS count FROM betting_feed_evidence_frames")
      .get() as { count?: unknown } | null;
    const evidenceFrameCount = safeInteger(
      frameCountRow?.count,
      "keeper evidence frame count",
    );
    const checkpointRows = database
      .query(
        `SELECT duel_id AS duelId,
                competitive_snapshot_digest AS snapshotDigest,
                terminal,
                terminal_event_key AS terminalEventKey,
                degraded_reason AS degradedReason
           FROM betting_feed_checkpoint
          ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    if (checkpointRows.length > 1) {
      throw new Error("keeper recovery contains multiple betting checkpoints");
    }
    const snapshots = snapshotRows.map(parseKeeperSnapshot);
    const terminals = terminalRows.map(parseKeeperTerminal);
    if (
      snapshots.length > MAX_DUEL_FACTS ||
      terminals.length > MAX_DUEL_FACTS
    ) {
      throw new Error("keeper recovery duel count exceeded its bound");
    }
    const snapshotIds = new Set(snapshots.map(({ duelId }) => duelId));
    const terminalIds = new Set(terminals.map(({ duelId }) => duelId));
    if (
      snapshotIds.size !== snapshots.length ||
      terminalIds.size !== terminals.length ||
      (snapshots.length > 0 && evidenceFrameCount < snapshots.length)
    ) {
      throw new Error(
        "keeper recovery duel evidence is incomplete or duplicated",
      );
    }
    let checkpointDuelId: string | null = null;
    if (snapshots.length > 0) {
      const checkpoint = checkpointRows[0];
      if (!checkpoint || checkpoint.degradedReason !== null) {
        throw new Error("keeper recovery checkpoint is absent or degraded");
      }
      checkpointDuelId = requiredText(
        checkpoint.duelId,
        "keeper checkpoint duel ID",
        256,
      );
      const latest = snapshots
        .map((snapshot) => ({
          snapshot,
          frozenAt: safeInteger(
            snapshot.snapshot.frozenAt,
            "keeper snapshot frozen time",
          ),
        }))
        .sort(
          (left, right) =>
            right.frozenAt - left.frozenAt ||
            (right.snapshot.duelId < left.snapshot.duelId
              ? -1
              : right.snapshot.duelId > left.snapshot.duelId
                ? 1
                : 0),
        )[0]!.snapshot;
      const checkpointTerminal = terminalIds.has(checkpointDuelId);
      if (
        checkpointDuelId !== latest.duelId ||
        checkpoint.snapshotDigest !== latest.snapshotDigest ||
        checkpoint.terminal !== (checkpointTerminal ? 1 : 0) ||
        (checkpointTerminal &&
          nullableText(
            checkpoint.terminalEventKey,
            "keeper checkpoint terminal event key",
            512,
          ) === null)
      ) {
        throw new Error(
          "keeper recovery checkpoint does not bind the latest duel",
        );
      }
    } else if (checkpointRows.length !== 0 || evidenceFrameCount !== 0) {
      throw new Error("keeper recovery contains orphan betting-feed state");
    }
    return {
      snapshots,
      terminals,
      evidenceFrameCount,
      checkpointDuelId,
      stateSha256: digestEvidence({ snapshots, terminals, checkpointDuelId }),
    };
  } finally {
    database.close(false);
  }
}

function reconcileFacts(
  hyperia: HyperiaRestoredDuelInspection,
  keeper: KeeperInspection,
): { terminalCount: number; stateSha256: string } {
  if (hyperia.facts.length !== keeper.snapshots.length) {
    throw new Error("restored Hyperia and keeper duel counts do not match");
  }
  const keeperSnapshots = new Map(
    keeper.snapshots.map((snapshot) => [snapshot.duelId, snapshot]),
  );
  const keeperTerminals = new Map(
    keeper.terminals.map((terminal) => [terminal.duelId, terminal]),
  );
  const normalized: Array<Record<string, unknown>> = [];
  let terminalCount = 0;
  for (const fact of hyperia.facts) {
    const snapshot = keeperSnapshots.get(fact.duelId);
    if (
      !snapshot ||
      snapshot.duelKey !== fact.duelKey ||
      snapshot.snapshotDigest !== fact.snapshotDigest ||
      canonicalEvidenceJson(snapshot.snapshot) !==
        canonicalEvidenceJson(fact.snapshot)
    ) {
      throw new Error(
        `restored competitive snapshot does not match for ${fact.duelId}`,
      );
    }
    const terminal = keeperTerminals.get(fact.duelId);
    if (fact.terminalOutcome === null) {
      if (terminal) {
        throw new Error(
          `nonterminal Hyperia duel has a keeper terminal for ${fact.duelId}`,
        );
      }
    } else {
      terminalCount += 1;
      if (!terminal) {
        throw new Error(
          `terminal Hyperia duel is absent from the keeper for ${fact.duelId}`,
        );
      }
      const outcome = fact.terminalOutcome.toUpperCase();
      const winnerSide =
        fact.terminalOutcome === "win"
          ? fact.terminalWinnerId === fact.agent1Id
            ? "A"
            : "B"
          : null;
      const reason =
        fact.terminalOutcome === "cancelled"
          ? fact.terminalCancellationReason
          : fact.terminalWinReason;
      if (
        terminal.duelKey !== fact.duelKey ||
        terminal.outcome !== outcome ||
        terminal.winnerSide !== winnerSide ||
        terminal.participantAId !== fact.agent1Id ||
        terminal.participantBId !== fact.agent2Id ||
        terminal.winnerId !== fact.terminalWinnerId ||
        terminal.reason !== reason ||
        terminal.seed !== fact.terminalSeed ||
        terminal.replayHash !== fact.terminalReplayHash
      ) {
        throw new Error(
          `restored terminal truth does not match for ${fact.duelId}`,
        );
      }
    }
    normalized.push({
      duelId: fact.duelId,
      duelKey: fact.duelKey,
      snapshotDigest: fact.snapshotDigest,
      snapshot: fact.snapshot,
      lifecycleStatus: fact.lifecycleStatus,
      terminalOutcome: fact.terminalOutcome,
      terminalWinnerId: fact.terminalWinnerId,
      terminalReason:
        fact.terminalOutcome === "cancelled"
          ? fact.terminalCancellationReason
          : fact.terminalWinReason,
      terminalSeed: fact.terminalSeed,
      terminalReplayHash: fact.terminalReplayHash,
    });
  }
  if (terminalCount !== keeper.terminals.length) {
    throw new Error("keeper recovery contains a terminal absent from Hyperia");
  }
  return { terminalCount, stateSha256: digestEvidence(normalized) };
}

function toPublicCancellationReason(
  reason: string,
): NonNullable<HyperiaApplicationDuelFact["cancellationReason"]> {
  const normalized = reason.toLowerCase();
  if (normalized.includes("no_combat_activity")) {
    return "insufficient_verified_combat";
  }
  if (
    normalized.includes("missing") ||
    normalized.includes("lost") ||
    normalized.includes("disconnect")
  ) {
    return "contestant_unavailable";
  }
  if (normalized.includes("shutdown")) return "broadcast_interrupted";
  return "no_contest";
}

function expectedApplicationFact(
  fact: HyperiaRestoredDuelFact,
): HyperiaApplicationDuelFact {
  if (
    fact.terminalOutcome === null ||
    fact.terminalAt === null ||
    (fact.terminalOutcome === "cancelled" &&
      fact.terminalCancellationReason === null)
  ) {
    throw new Error(
      `application projected duel is not terminal in restored state for ${fact.duelId}`,
    );
  }
  return {
    cycleId: fact.cycleId,
    duelId: fact.duelId,
    finishedAt: fact.terminalAt,
    outcome: fact.terminalOutcome,
    agent1Id: fact.agent1Id,
    agent2Id: fact.agent2Id,
    winnerId: fact.terminalWinnerId,
    winReason:
      fact.terminalOutcome === "win"
        ? fact.terminalWinReason
        : fact.terminalOutcome === "draw"
          ? "draw"
          : null,
    cancellationReason:
      fact.terminalOutcome === "cancelled"
        ? toPublicCancellationReason(fact.terminalCancellationReason!)
        : null,
  };
}

function reconcileApplicationProjection(
  hyperia: HyperiaRestoredDuelInspection,
  application: HyperiaApplicationReadinessEvidence,
): void {
  const terminalByCycleId = new Map<string, HyperiaRestoredDuelFact>();
  for (const fact of hyperia.facts) {
    if (fact.terminalOutcome === null) continue;
    if (terminalByCycleId.has(fact.cycleId)) {
      throw new Error(
        `restored terminal cycle identity is duplicated for ${fact.cycleId}`,
      );
    }
    terminalByCycleId.set(fact.cycleId, fact);
  }
  for (const projected of application.projectedCompetitiveDuels) {
    const restored = terminalByCycleId.get(projected.cycleId);
    if (
      !restored ||
      canonicalEvidenceJson(projected) !==
        canonicalEvidenceJson(expectedApplicationFact(restored))
    ) {
      throw new Error(
        `application projected duel does not match the reconciled restored state for ${projected.cycleId}`,
      );
    }
  }
}

async function inspectComponents(
  input: VerifyRestoredDuelStateReconciliationInput,
) {
  const rehearsal = await verifyPlatformRecoveryRehearsal(input);
  const queryTool =
    input.hyperiaQueryTool ?? defaultQueryTool(input.psqlExecutable ?? "psql");
  const firstHyperia = parseHyperiaRestoredDuelInspection(
    await queryTool.query({
      databaseName: rehearsal.hyperia.restoredDatabaseName,
      timeoutMs: input.queryTimeoutMs,
    }),
    rehearsal.hyperia.restoredDatabaseName,
  );
  if (
    firstHyperia.serverVersionNum !== rehearsal.hyperia.targetServerVersionNum
  ) {
    throw new Error(
      "restored Hyperia server version does not match its certificate",
    );
  }
  const keeper = inspectKeeper(path.resolve(input.materializedRootPath));
  const hyperia = parseHyperiaRestoredDuelInspection(
    await queryTool.query({
      databaseName: rehearsal.hyperia.restoredDatabaseName,
      timeoutMs: input.queryTimeoutMs,
    }),
    rehearsal.hyperia.restoredDatabaseName,
  );
  if (
    hyperia.serverVersionNum !== firstHyperia.serverVersionNum ||
    hyperia.stateSha256 !== firstHyperia.stateSha256 ||
    canonicalEvidenceJson(hyperia.facts) !==
      canonicalEvidenceJson(firstHyperia.facts)
  ) {
    throw new Error(
      "restored Hyperia duel state changed during cross-store reconciliation",
    );
  }
  const reconciliation = reconcileFacts(hyperia, keeper);
  const applicationReadiness = readApplicationReadiness(
    input.applicationReadinessPath,
  );
  if (
    applicationReadiness.restoreVerificationId !==
      rehearsal.hyperia.restoreVerificationId ||
    applicationReadiness.releaseSha !== rehearsal.hyperia.releaseSha ||
    applicationReadiness.boundaryId !== rehearsal.boundaryId ||
    applicationReadiness.restoredDatabaseName !== hyperia.databaseName ||
    applicationReadiness.targetServerVersionNum !== hyperia.serverVersionNum ||
    Date.parse(applicationReadiness.createdAt) <
      Date.parse(rehearsal.hyperia.restoreEvidenceCreatedAt) ||
    !sameFile(
      applicationReadiness.restoreEvidence,
      rehearsal.files.hyperiaRestoreEvidence,
    ) ||
    applicationReadiness.projectedCompetitiveDuelCount >
      reconciliation.terminalCount ||
    (reconciliation.terminalCount > 0 &&
      applicationReadiness.projectedCompetitiveDuelCount === 0)
  ) {
    throw new Error(
      "Hyperia application readiness does not match the reconciled restored state",
    );
  }
  reconcileApplicationProjection(hyperia, applicationReadiness);
  const finalRehearsal = await verifyPlatformRecoveryRehearsal(input);
  if (
    canonicalEvidenceJson(finalRehearsal) !== canonicalEvidenceJson(rehearsal)
  ) {
    throw new Error(
      "platform recovery rehearsal changed during duel reconciliation",
    );
  }
  const files = {
    platformRecoveryRehearsal: bindPrivateFile(
      input.rehearsalManifestPath,
      "platform recovery rehearsal manifest",
      MAX_MANIFEST_BYTES,
    ),
    keeperMaterializationRecord: bindPrivateFile(
      path.join(input.materializedRootPath, "recovery-materialization.json"),
      "keeper recovery materialization record",
      MAX_MANIFEST_BYTES,
    ),
    hyperiaApplicationReadiness: bindPrivateFile(
      input.applicationReadinessPath,
      "Hyperia application readiness evidence",
      MAX_APPLICATION_READINESS_BYTES,
    ),
  };
  return {
    rehearsal,
    hyperia,
    keeper,
    reconciliation,
    applicationReadiness,
    files,
  };
}

function parseBoundFile(value: unknown): BoundFile | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["fileName", "sha256", "bytes"]) ||
    typeof value.fileName !== "string" ||
    value.fileName.length === 0 ||
    value.fileName.length > 255 ||
    path.basename(value.fileName) !== value.fileName ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) <= 0
  ) {
    return null;
  }
  return {
    fileName: value.fileName,
    sha256: value.sha256,
    bytes: Number(value.bytes),
  };
}

function parseApplicationDuelFact(value: unknown): HyperiaApplicationDuelFact {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "cycleId",
      "duelId",
      "finishedAt",
      "outcome",
      "agent1Id",
      "agent2Id",
      "winnerId",
      "winReason",
      "cancellationReason",
    ])
  ) {
    throw new Error("Hyperia application projected duel is invalid");
  }
  const outcome = value.outcome;
  const winnerId = nullableText(
    value.winnerId,
    "Hyperia application projected winner",
    128,
  );
  const winReason = nullableText(
    value.winReason,
    "Hyperia application projected win reason",
    64,
  );
  const cancellationReason = nullableText(
    value.cancellationReason,
    "Hyperia application projected cancellation reason",
    64,
  );
  if (outcome !== "win" && outcome !== "draw" && outcome !== "cancelled") {
    throw new Error("Hyperia application projected outcome is invalid");
  }
  const fact: HyperiaApplicationDuelFact = {
    cycleId: requiredText(
      value.cycleId,
      "Hyperia application projected cycle ID",
      256,
    ),
    duelId: requiredText(
      value.duelId,
      "Hyperia application projected duel ID",
      256,
    ),
    finishedAt: safeInteger(
      value.finishedAt,
      "Hyperia application projected finish time",
    ),
    outcome,
    agent1Id: requiredText(
      value.agent1Id,
      "Hyperia application projected agent 1",
      128,
    ),
    agent2Id: requiredText(
      value.agent2Id,
      "Hyperia application projected agent 2",
      128,
    ),
    winnerId,
    winReason: winReason as HyperiaApplicationDuelFact["winReason"],
    cancellationReason:
      cancellationReason as HyperiaApplicationDuelFact["cancellationReason"],
  };
  if (
    fact.agent1Id === fact.agent2Id ||
    (fact.outcome === "win" &&
      (fact.winnerId === null ||
        ![fact.agent1Id, fact.agent2Id].includes(fact.winnerId) ||
        !["kill", "forfeit", "hp_advantage", "damage_advantage"].includes(
          String(fact.winReason),
        ) ||
        fact.cancellationReason !== null)) ||
    (fact.outcome === "draw" &&
      (fact.winnerId !== null ||
        fact.winReason !== "draw" ||
        fact.cancellationReason !== null)) ||
    (fact.outcome === "cancelled" &&
      (fact.winnerId !== null ||
        fact.winReason !== null ||
        ![
          "insufficient_verified_combat",
          "contestant_unavailable",
          "broadcast_interrupted",
          "no_contest",
        ].includes(String(fact.cancellationReason))))
  ) {
    throw new Error("Hyperia application projected duel is invalid");
  }
  return fact;
}

function parseApplicationReadiness(
  value: unknown,
): HyperiaApplicationReadinessEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "applicationReadinessId",
      "restoreVerificationId",
      "releaseSha",
      "boundaryId",
      "restoredDatabaseName",
      "targetServerVersionNum",
      "restoreEvidence",
      "routeContract",
      "historyLimit",
      "recentDuelCount",
      "projectedCompetitiveDuelCount",
      "winCount",
      "drawCount",
      "cancelledCount",
      "publicRecentDuelsSha256",
      "projectedCompetitiveDuelStateSha256",
      "projectedCompetitiveDuels",
      "verificationScope",
      "databaseMutationAuthorized",
      "activationRequiresSeparateApproval",
      "productionCutoverAuthorized",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.applicationReadinessId !== "string" ||
    !UUID_V4_PATTERN.test(value.applicationReadinessId) ||
    typeof value.restoreVerificationId !== "string" ||
    !UUID_V4_PATTERN.test(value.restoreVerificationId) ||
    typeof value.releaseSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.releaseSha) ||
    typeof value.boundaryId !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{7,63}$/u.test(value.boundaryId) ||
    typeof value.restoredDatabaseName !== "string" ||
    !DATABASE_NAME_PATTERN.test(value.restoredDatabaseName) ||
    typeof value.targetServerVersionNum !== "string" ||
    !/^[0-9]{5,6}$/u.test(value.targetServerVersionNum) ||
    value.routeContract !== "/api/streaming/leaderboard/details" ||
    value.historyLimit !== 200 ||
    !Number.isSafeInteger(value.recentDuelCount) ||
    Number(value.recentDuelCount) < 0 ||
    Number(value.recentDuelCount) > 200 ||
    !Number.isSafeInteger(value.projectedCompetitiveDuelCount) ||
    Number(value.projectedCompetitiveDuelCount) < 0 ||
    Number(value.projectedCompetitiveDuelCount) >
      Number(value.recentDuelCount) ||
    !Number.isSafeInteger(value.winCount) ||
    !Number.isSafeInteger(value.drawCount) ||
    !Number.isSafeInteger(value.cancelledCount) ||
    Number(value.winCount) < 0 ||
    Number(value.drawCount) < 0 ||
    Number(value.cancelledCount) < 0 ||
    Number(value.winCount) +
      Number(value.drawCount) +
      Number(value.cancelledCount) !==
      Number(value.recentDuelCount) ||
    typeof value.publicRecentDuelsSha256 !== "string" ||
    !SHA256_PATTERN.test(value.publicRecentDuelsSha256) ||
    typeof value.projectedCompetitiveDuelStateSha256 !== "string" ||
    !SHA256_PATTERN.test(value.projectedCompetitiveDuelStateSha256) ||
    !Array.isArray(value.projectedCompetitiveDuels) ||
    value.verificationScope !==
      "restored_hyperia_application_read_projection_only" ||
    value.databaseMutationAuthorized !== false ||
    value.activationRequiresSeparateApproval !== true ||
    value.productionCutoverAuthorized !== false
  ) {
    throw new Error("Hyperia application readiness evidence is invalid");
  }
  const restoreEvidence = parseBoundFile(value.restoreEvidence);
  const projectedCompetitiveDuels = Array.isArray(
    value.projectedCompetitiveDuels,
  )
    ? value.projectedCompetitiveDuels.map(parseApplicationDuelFact)
    : [];
  if (
    !restoreEvidence ||
    projectedCompetitiveDuels.length !==
      Number(value.projectedCompetitiveDuelCount) ||
    new Set(projectedCompetitiveDuels.map(({ cycleId }) => cycleId)).size !==
      projectedCompetitiveDuels.length ||
    projectedCompetitiveDuels.some(
      (fact, index) =>
        index > 0 &&
        projectedCompetitiveDuels[index - 1]!.cycleId >= fact.cycleId,
    ) ||
    digestEvidence(projectedCompetitiveDuels) !==
      value.projectedCompetitiveDuelStateSha256
  ) {
    throw new Error("Hyperia application readiness evidence is invalid");
  }
  return {
    ...(value as Omit<
      HyperiaApplicationReadinessEvidence,
      "restoreEvidence" | "projectedCompetitiveDuels"
    >),
    restoreEvidence,
    projectedCompetitiveDuels,
  };
}

function readApplicationReadiness(
  filePath: string,
): HyperiaApplicationReadinessEvidence {
  if (
    path.basename(path.resolve(filePath)) !==
    "hyperia-restored-duel-application-readiness.json"
  ) {
    throw new Error("Hyperia application readiness filename is invalid");
  }
  const stats = assertPrivateFile(
    filePath,
    "Hyperia application readiness evidence",
    MAX_APPLICATION_READINESS_BYTES,
  );
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size
    ) {
      throw new Error("Hyperia application readiness changed while read");
    }
    const bytes = readFileSync(descriptor);
    const final = fstatSync(descriptor);
    if (
      bytes.byteLength !== opened.size ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("Hyperia application readiness changed while read");
    }
    try {
      return parseApplicationReadiness(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Hyperia application readiness evidence is invalid"
      ) {
        throw error;
      }
      throw new Error("Hyperia application readiness evidence is invalid");
    }
  } finally {
    closeSync(descriptor);
  }
}

function parseManifest(
  value: unknown,
): RestoredDuelStateReconciliationManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "createdAt",
      "reconciliationId",
      "rehearsalId",
      "boundaryId",
      "createdAfterRehearsalMs",
      "createdAfterApplicationReadinessMs",
      "verificationScope",
      "activationRequiresSeparateApproval",
      "productionCutoverAuthorized",
      "hyperia",
      "hyperbet",
      "matchedDuelCount",
      "matchedTerminalCount",
      "reconciledStateSha256",
      "files",
    ]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.reconciliationId !== "string" ||
    !UUID_V4_PATTERN.test(value.reconciliationId) ||
    typeof value.rehearsalId !== "string" ||
    !UUID_V4_PATTERN.test(value.rehearsalId) ||
    typeof value.boundaryId !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{7,63}$/u.test(value.boundaryId) ||
    !Number.isSafeInteger(value.createdAfterRehearsalMs) ||
    Number(value.createdAfterRehearsalMs) < 0 ||
    !Number.isSafeInteger(value.createdAfterApplicationReadinessMs) ||
    Number(value.createdAfterApplicationReadinessMs) < 0 ||
    value.verificationScope !==
      "cross_repository_restored_duel_state_and_application_read_projection" ||
    value.activationRequiresSeparateApproval !== true ||
    value.productionCutoverAuthorized !== false ||
    !isRecord(value.hyperia) ||
    !hasExactKeys(value.hyperia, [
      "databaseName",
      "serverVersionNum",
      "restoreVerificationId",
      "duelCount",
      "terminalDuelCount",
      "stateSha256",
      "applicationReadiness",
    ]) ||
    !isRecord(value.hyperia.applicationReadiness) ||
    !hasExactKeys(value.hyperia.applicationReadiness, [
      "applicationReadinessId",
      "createdAt",
      "routeContract",
      "historyLimit",
      "recentDuelCount",
      "projectedCompetitiveDuelCount",
      "publicRecentDuelsSha256",
      "projectedCompetitiveDuelStateSha256",
    ]) ||
    !isRecord(value.hyperbet) ||
    !hasExactKeys(value.hyperbet, [
      "materializationId",
      "duelCount",
      "terminalOperationCount",
      "evidenceFrameCount",
      "checkpointDuelId",
      "stateSha256",
    ]) ||
    !isRecord(value.files) ||
    !hasExactKeys(value.files, [
      "platformRecoveryRehearsal",
      "keeperMaterializationRecord",
      "hyperiaApplicationReadiness",
    ])
  ) {
    throw new Error("restored duel reconciliation manifest is invalid");
  }
  const files = {
    platformRecoveryRehearsal: parseBoundFile(
      value.files.platformRecoveryRehearsal,
    ),
    keeperMaterializationRecord: parseBoundFile(
      value.files.keeperMaterializationRecord,
    ),
    hyperiaApplicationReadiness: parseBoundFile(
      value.files.hyperiaApplicationReadiness,
    ),
  };
  const strings = [
    value.hyperia.databaseName,
    value.hyperia.serverVersionNum,
    value.hyperia.restoreVerificationId,
    value.hyperia.stateSha256,
    value.hyperia.applicationReadiness.applicationReadinessId,
    value.hyperia.applicationReadiness.createdAt,
    value.hyperia.applicationReadiness.publicRecentDuelsSha256,
    value.hyperia.applicationReadiness.projectedCompetitiveDuelStateSha256,
    value.hyperbet.materializationId,
    value.hyperbet.stateSha256,
    value.reconciledStateSha256,
  ];
  const counts = [
    value.hyperia.duelCount,
    value.hyperia.terminalDuelCount,
    value.hyperia.applicationReadiness.recentDuelCount,
    value.hyperia.applicationReadiness.projectedCompetitiveDuelCount,
    value.hyperbet.duelCount,
    value.hyperbet.terminalOperationCount,
    value.hyperbet.evidenceFrameCount,
    value.matchedDuelCount,
    value.matchedTerminalCount,
  ];
  if (
    Object.values(files).some((file) => file === null) ||
    strings.some((entry) => typeof entry !== "string") ||
    !DATABASE_NAME_PATTERN.test(String(value.hyperia.databaseName)) ||
    !/^[0-9]{5,6}$/u.test(String(value.hyperia.serverVersionNum)) ||
    !UUID_V4_PATTERN.test(String(value.hyperia.restoreVerificationId)) ||
    !UUID_V4_PATTERN.test(
      String(value.hyperia.applicationReadiness.applicationReadinessId),
    ) ||
    !isCanonicalIsoTimestamp(value.hyperia.applicationReadiness.createdAt) ||
    value.hyperia.applicationReadiness.routeContract !==
      "/api/streaming/leaderboard/details" ||
    value.hyperia.applicationReadiness.historyLimit !== 200 ||
    Number(value.hyperia.applicationReadiness.recentDuelCount) > 200 ||
    Number(value.hyperia.applicationReadiness.projectedCompetitiveDuelCount) >
      Number(value.hyperia.applicationReadiness.recentDuelCount) ||
    Number(value.hyperia.applicationReadiness.projectedCompetitiveDuelCount) >
      Number(value.matchedTerminalCount) ||
    (Number(value.matchedTerminalCount) > 0 &&
      Number(
        value.hyperia.applicationReadiness.projectedCompetitiveDuelCount,
      ) === 0) ||
    !UUID_V4_PATTERN.test(String(value.hyperbet.materializationId)) ||
    [
      value.hyperia.stateSha256,
      value.hyperia.applicationReadiness.publicRecentDuelsSha256,
      value.hyperia.applicationReadiness.projectedCompetitiveDuelStateSha256,
      value.hyperbet.stateSha256,
      value.reconciledStateSha256,
    ].some(
      (entry) => typeof entry !== "string" || !SHA256_PATTERN.test(entry),
    ) ||
    counts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0) ||
    (value.hyperbet.checkpointDuelId !== null &&
      (typeof value.hyperbet.checkpointDuelId !== "string" ||
        value.hyperbet.checkpointDuelId.trim() !==
          value.hyperbet.checkpointDuelId ||
        value.hyperbet.checkpointDuelId.length === 0 ||
        value.hyperbet.checkpointDuelId.length > 256))
  ) {
    throw new Error("restored duel reconciliation manifest is invalid");
  }
  return value as RestoredDuelStateReconciliationManifest;
}

function readManifest(
  filePath: string,
): RestoredDuelStateReconciliationManifest {
  const stats = assertPrivateFile(
    filePath,
    "restored duel reconciliation manifest",
    MAX_MANIFEST_BYTES,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size
    ) {
      throw new Error(
        "restored duel reconciliation manifest changed while read",
      );
    }
    const bytes = readFileSync(descriptor);
    const final = fstatSync(descriptor);
    if (
      bytes.byteLength !== opened.size ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(
        "restored duel reconciliation manifest changed while read",
      );
    }
    try {
      return parseManifest(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("manifest is invalid")
      ) {
        throw error;
      }
      throw new Error("restored duel reconciliation manifest is invalid");
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function sameFile(left: BoundFile, right: BoundFile): boolean {
  return (
    left.fileName === right.fileName &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes
  );
}

function fsyncParent(filePath: string): void {
  const descriptor = openSync(path.dirname(filePath), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function resolveNewManifest(filePath: string): string {
  const absolute = path.resolve(filePath);
  if (path.basename(absolute) !== "restored-duel-state-reconciliation.json") {
    throw new Error(
      "restored duel reconciliation manifest filename is invalid",
    );
  }
  if (existsSync(absolute)) {
    throw new Error("restored duel reconciliation manifest already exists");
  }
  const parent = lstatSync(path.dirname(absolute));
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) {
    throw new Error("restored duel reconciliation parent must be mode-0700");
  }
  return absolute;
}

function writeManifest(
  filePath: string,
  manifest: RestoredDuelStateReconciliationManifest,
): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    chmodSync(filePath, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  fsyncParent(filePath);
}

function expectedManifest(
  components: Awaited<ReturnType<typeof inspectComponents>>,
  identity: { createdAt: string; reconciliationId: string },
): RestoredDuelStateReconciliationManifest {
  const createdAfterRehearsalMs =
    Date.parse(identity.createdAt) - Date.parse(components.rehearsal.createdAt);
  const createdAfterApplicationReadinessMs =
    Date.parse(identity.createdAt) -
    Date.parse(components.applicationReadiness.createdAt);
  if (createdAfterRehearsalMs < 0 || createdAfterApplicationReadinessMs < 0) {
    throw new Error("restored duel reconciliation clock regressed");
  }
  return {
    schemaVersion: 1,
    createdAt: identity.createdAt,
    reconciliationId: identity.reconciliationId,
    rehearsalId: components.rehearsal.rehearsalId,
    boundaryId: components.rehearsal.boundaryId,
    createdAfterRehearsalMs,
    createdAfterApplicationReadinessMs,
    verificationScope:
      "cross_repository_restored_duel_state_and_application_read_projection",
    activationRequiresSeparateApproval: true,
    productionCutoverAuthorized: false,
    hyperia: {
      databaseName: components.hyperia.databaseName,
      serverVersionNum: components.hyperia.serverVersionNum,
      restoreVerificationId: components.rehearsal.hyperia.restoreVerificationId,
      duelCount: components.hyperia.facts.length,
      terminalDuelCount: components.reconciliation.terminalCount,
      stateSha256: components.hyperia.stateSha256,
      applicationReadiness: {
        applicationReadinessId:
          components.applicationReadiness.applicationReadinessId,
        createdAt: components.applicationReadiness.createdAt,
        routeContract: components.applicationReadiness.routeContract,
        historyLimit: components.applicationReadiness.historyLimit,
        recentDuelCount: components.applicationReadiness.recentDuelCount,
        projectedCompetitiveDuelCount:
          components.applicationReadiness.projectedCompetitiveDuelCount,
        publicRecentDuelsSha256:
          components.applicationReadiness.publicRecentDuelsSha256,
        projectedCompetitiveDuelStateSha256:
          components.applicationReadiness.projectedCompetitiveDuelStateSha256,
      },
    },
    hyperbet: {
      materializationId: components.rehearsal.hyperbet.materializationId,
      duelCount: components.keeper.snapshots.length,
      terminalOperationCount: components.keeper.terminals.length,
      evidenceFrameCount: components.keeper.evidenceFrameCount,
      checkpointDuelId: components.keeper.checkpointDuelId,
      stateSha256: components.keeper.stateSha256,
    },
    matchedDuelCount: components.hyperia.facts.length,
    matchedTerminalCount: components.reconciliation.terminalCount,
    reconciledStateSha256: components.reconciliation.stateSha256,
    files: components.files,
  };
}

export async function createRestoredDuelStateReconciliation(
  input: CreateRestoredDuelStateReconciliationInput,
): Promise<RestoredDuelStateReconciliationManifest> {
  const manifestPath = resolveNewManifest(input.reconciliationManifestPath);
  const components = await inspectComponents(input);
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const reconciliationId = (input.createId ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(reconciliationId)) {
    throw new Error("restored duel reconciliation ID is invalid");
  }
  const manifest = expectedManifest(components, {
    createdAt,
    reconciliationId,
  });
  writeManifest(manifestPath, manifest);
  try {
    return await verifyRestoredDuelStateReconciliation(input);
  } catch (error) {
    unlinkSync(manifestPath);
    fsyncParent(manifestPath);
    throw error;
  }
}

export async function verifyRestoredDuelStateReconciliation(
  input: VerifyRestoredDuelStateReconciliationInput,
): Promise<RestoredDuelStateReconciliationManifest> {
  return (await verifyRestoredDuelStateReconciliationWithFacts(input)).manifest;
}

export async function verifyRestoredDuelStateReconciliationWithFacts(
  input: VerifyRestoredDuelStateReconciliationInput,
): Promise<{
  manifest: RestoredDuelStateReconciliationManifest;
  duels: HyperiaRestoredDuelFact[];
}> {
  const manifestPath = path.resolve(input.reconciliationManifestPath);
  const manifest = readManifest(manifestPath);
  const components = await inspectComponents(input);
  const expected = expectedManifest(components, {
    createdAt: manifest.createdAt,
    reconciliationId: manifest.reconciliationId,
  });
  if (
    canonicalEvidenceJson(manifest) !== canonicalEvidenceJson(expected) ||
    !sameFile(
      manifest.files.platformRecoveryRehearsal,
      components.files.platformRecoveryRehearsal,
    ) ||
    !sameFile(
      manifest.files.keeperMaterializationRecord,
      components.files.keeperMaterializationRecord,
    ) ||
    !sameFile(
      manifest.files.hyperiaApplicationReadiness,
      components.files.hyperiaApplicationReadiness,
    )
  ) {
    throw new Error("restored duel reconciliation state or identity changed");
  }
  return {
    manifest,
    duels: structuredClone(components.hyperia.facts),
  };
}
