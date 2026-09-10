import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PublicKey } from "@solana/web3.js";

import { resolveSolanaV1Deployment } from "../deployments/v1";

export type EmergencyAction =
  | "market-pause"
  | "market-unpause"
  | "oracle-pause"
  | "oracle-unpause"
  | "cancel-duel";

type EmergencyCluster = "devnet" | "mainnet-beta";

type EmergencyInstructionPlanInput = {
  action: EmergencyAction;
  cluster: EmergencyCluster;
  releaseSha: string;
  expectedSigner: string;
  duelKey?: string;
  metadataUri?: string;
  now?: () => Date;
};

export type EmergencyInstructionPlan = {
  schemaVersion: 1;
  generatedAt: string;
  scope: "solana-duel-v1";
  releaseSha: string;
  cluster: EmergencyCluster;
  action: EmergencyAction;
  expectedSigner: string;
  programId: string;
  instructionName: "set_market_paused" | "set_oracle_paused" | "cancel_duel";
  instructionDataBase64: string;
  instructionDataSha256: string;
  accounts: Array<{
    role: "authority" | "config" | "oracle_config" | "duel_state";
    address: string;
    signer: boolean;
    writable: boolean;
  }>;
  expectedPostState:
    | { orderPlacementPaused: boolean; marketCreationPaused: boolean }
    | { oraclePaused: boolean }
    | { duelKey: string; status: "cancelled"; metadataUri: string };
  broadcastAuthorized: false;
  requiresIndependentReadback: true;
  requiresSimulation: true;
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function parseReleaseSha(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(
      "release SHA must be one full lowercase 40-character commit SHA",
    );
  }
  return normalized;
}

export function parseEmergencyCluster(value: string): EmergencyCluster {
  if (value !== "devnet" && value !== "mainnet-beta") {
    throw new Error("emergency plan cluster must be devnet or mainnet-beta");
  }
  return value;
}

export function parseEmergencyAction(value: string): EmergencyAction {
  if (
    value === "market-pause" ||
    value === "market-unpause" ||
    value === "oracle-pause" ||
    value === "oracle-unpause" ||
    value === "cancel-duel"
  ) {
    return value;
  }
  throw new Error("unsupported emergency action");
}

function parseSigner(value: string): PublicKey {
  const signer = new PublicKey(value.trim());
  if (signer.equals(PublicKey.default)) {
    throw new Error("expected signer cannot be the zero key");
  }
  return signer;
}

function parseCancellation(input: EmergencyInstructionPlanInput): {
  duelKey: Buffer;
  duelKeyHex: string;
  metadataUri: string;
} {
  const duelKeyHex = input.duelKey?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/u.test(duelKeyHex)) {
    throw new Error("cancel-duel requires one 32-byte lowercase hex duel key");
  }
  const metadataUri = input.metadataUri?.trim() ?? "";
  let parsed: URL;
  try {
    parsed = new URL(metadataUri);
  } catch {
    throw new Error("cancel-duel metadata URI must be absolute");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "hyperia:") {
    throw new Error("cancel-duel metadata URI must use https: or hyperia:");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "cancel-duel metadata URI must not contain URL credentials",
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:api[-_]?key|auth|secret|signature|token)/iu.test(key)) {
      throw new Error(
        "cancel-duel metadata URI must not contain secret parameters",
      );
    }
  }
  if (Buffer.byteLength(metadataUri, "utf8") > 200) {
    throw new Error(
      "cancel-duel metadata URI exceeds the on-chain 200-byte limit",
    );
  }
  return { duelKey: Buffer.from(duelKeyHex, "hex"), duelKeyHex, metadataUri };
}

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function buildEmergencyInstructionPlan(
  input: EmergencyInstructionPlanInput,
): EmergencyInstructionPlan {
  const action = parseEmergencyAction(input.action);
  const cluster = parseEmergencyCluster(input.cluster);
  const releaseSha = parseReleaseSha(input.releaseSha);
  const expectedSigner = parseSigner(input.expectedSigner);
  const deployment = resolveSolanaV1Deployment(cluster);

  let programId: PublicKey;
  let instructionName: EmergencyInstructionPlan["instructionName"];
  let instructionData: Buffer;
  let accounts: EmergencyInstructionPlan["accounts"];
  let expectedPostState: EmergencyInstructionPlan["expectedPostState"];

  if (action === "market-pause" || action === "market-unpause") {
    if (input.duelKey || input.metadataUri) {
      throw new Error(
        "market pause actions do not accept duel cancellation input",
      );
    }
    programId = new PublicKey(deployment.duelMarketProgramId);
    const config = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programId,
    )[0];
    const paused = action === "market-pause";
    instructionName = "set_market_paused";
    instructionData = Buffer.concat([
      instructionDiscriminator(instructionName),
      Buffer.from([paused ? 1 : 0, paused ? 1 : 0]),
    ]);
    accounts = [
      {
        role: "authority",
        address: expectedSigner.toBase58(),
        signer: true,
        writable: false,
      },
      {
        role: "config",
        address: config.toBase58(),
        signer: false,
        writable: true,
      },
    ];
    expectedPostState = {
      orderPlacementPaused: paused,
      marketCreationPaused: paused,
    };
  } else {
    programId = new PublicKey(deployment.fightOracleProgramId);
    const oracleConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle_config")],
      programId,
    )[0];
    if (action === "cancel-duel") {
      const cancellation = parseCancellation(input);
      const duelState = PublicKey.findProgramAddressSync(
        [Buffer.from("duel"), cancellation.duelKey],
        programId,
      )[0];
      instructionName = "cancel_duel";
      instructionData = Buffer.concat([
        instructionDiscriminator(instructionName),
        cancellation.duelKey,
        encodeString(cancellation.metadataUri),
      ]);
      accounts = [
        {
          role: "authority",
          address: expectedSigner.toBase58(),
          signer: true,
          writable: true,
        },
        {
          role: "oracle_config",
          address: oracleConfig.toBase58(),
          signer: false,
          writable: false,
        },
        {
          role: "duel_state",
          address: duelState.toBase58(),
          signer: false,
          writable: true,
        },
      ];
      expectedPostState = {
        duelKey: cancellation.duelKeyHex,
        status: "cancelled",
        metadataUri: cancellation.metadataUri,
      };
    } else {
      if (input.duelKey || input.metadataUri) {
        throw new Error(
          "oracle pause actions do not accept duel cancellation input",
        );
      }
      const paused = action === "oracle-pause";
      instructionName = "set_oracle_paused";
      instructionData = Buffer.concat([
        instructionDiscriminator(instructionName),
        Buffer.from([paused ? 1 : 0]),
      ]);
      accounts = [
        {
          role: "authority",
          address: expectedSigner.toBase58(),
          signer: true,
          writable: false,
        },
        {
          role: "oracle_config",
          address: oracleConfig.toBase58(),
          signer: false,
          writable: true,
        },
      ];
      expectedPostState = { oraclePaused: paused };
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    scope: "solana-duel-v1",
    releaseSha,
    cluster,
    action,
    expectedSigner: expectedSigner.toBase58(),
    programId: programId.toBase58(),
    instructionName,
    instructionDataBase64: instructionData.toString("base64"),
    instructionDataSha256: sha256(instructionData),
    accounts,
    expectedPostState,
    broadcastAuthorized: false,
    requiresIndependentReadback: true,
    requiresSimulation: true,
  };
}

export function writeEmergencyInstructionPlan(
  outputPath: string,
  plan: EmergencyInstructionPlan,
): void {
  const absolutePath = path.resolve(outputPath);
  writeFileSync(absolutePath, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(absolutePath, 0o600);
}
