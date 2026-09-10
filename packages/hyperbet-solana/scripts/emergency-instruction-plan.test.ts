import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PublicKey } from "@solana/web3.js";
import { describe, expect, test } from "bun:test";

import { resolveSolanaV1Deployment } from "../deployments/v1";
import {
  buildEmergencyInstructionPlan,
  writeEmergencyInstructionPlan,
} from "./emergency-instruction-plan";

const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678";
const SIGNER = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

describe("unsigned emergency instruction plans", () => {
  test("matches the synchronized Anchor instruction contracts", () => {
    const anchorRoot = fileURLToPath(new URL("../anchor/", import.meta.url));
    const marketIdl = JSON.parse(
      readFileSync(
        path.join(anchorRoot, "target/idl/duel_market.json"),
        "utf8",
      ),
    ) as { instructions: Array<Record<string, unknown>> };
    const oracleIdl = JSON.parse(
      readFileSync(
        path.join(anchorRoot, "target/idl/fight_oracle.json"),
        "utf8",
      ),
    ) as { instructions: Array<Record<string, unknown>> };
    expect(
      marketIdl.instructions.find(
        (instruction) => instruction.name === "set_market_paused",
      ),
    ).toMatchObject({
      discriminator: [233, 31, 161, 248, 178, 111, 102, 65],
      accounts: [
        { name: "authority", signer: true },
        { name: "config", writable: true },
      ],
      args: [
        { name: "order_placement_paused", type: "bool" },
        { name: "market_creation_paused", type: "bool" },
      ],
    });
    expect(
      oracleIdl.instructions.find(
        (instruction) => instruction.name === "set_oracle_paused",
      ),
    ).toMatchObject({
      discriminator: [61, 243, 64, 36, 121, 38, 141, 241],
      accounts: [
        { name: "authority", signer: true },
        { name: "oracle_config", writable: true },
      ],
      args: [{ name: "paused", type: "bool" }],
    });
    const cancelInstruction = oracleIdl.instructions.find(
      (instruction) => instruction.name === "cancel_duel",
    ) as {
      discriminator?: number[];
      accounts?: Array<{ name?: string; signer?: boolean; writable?: boolean }>;
      args?: unknown[];
    };
    expect({
      discriminator: cancelInstruction.discriminator,
      accounts: cancelInstruction.accounts?.map(
        ({ name, signer, writable }) => ({
          name,
          signer: signer ?? false,
          writable: writable ?? false,
        }),
      ),
      args: cancelInstruction.args,
    }).toEqual({
      discriminator: [83, 124, 224, 237, 235, 44, 38, 57],
      accounts: [
        { name: "authority", writable: true, signer: true },
        { name: "oracle_config", writable: false, signer: false },
        { name: "duel_state", writable: true, signer: false },
      ],
      args: [
        { name: "_duel_key", type: { array: ["u8", 32] } },
        { name: "metadata_uri", type: "string" },
      ],
    });
  });

  test("builds the exact market-pause instruction and canonical accounts", () => {
    const plan = buildEmergencyInstructionPlan({
      action: "market-pause",
      cluster: "devnet",
      releaseSha: RELEASE_SHA,
      expectedSigner: SIGNER,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    });
    const deployment = resolveSolanaV1Deployment("devnet");
    const programId = new PublicKey(deployment.duelMarketProgramId);
    const config = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programId,
    )[0];
    expect(plan.programId).toBe(programId.toBase58());
    expect(plan.accounts).toEqual([
      { role: "authority", address: SIGNER, signer: true, writable: false },
      {
        role: "config",
        address: config.toBase58(),
        signer: false,
        writable: true,
      },
    ]);
    expect(Buffer.from(plan.instructionDataBase64, "base64")).toEqual(
      Buffer.from([233, 31, 161, 248, 178, 111, 102, 65, 1, 1]),
    );
    expect(plan.expectedPostState).toEqual({
      orderPlacementPaused: true,
      marketCreationPaused: true,
    });
    expect(plan.broadcastAuthorized).toBe(false);
  });

  test("builds exact oracle-pause and duel-cancellation instructions", () => {
    const oracle = buildEmergencyInstructionPlan({
      action: "oracle-pause",
      cluster: "mainnet-beta",
      releaseSha: RELEASE_SHA,
      expectedSigner: SIGNER,
    });
    expect(Buffer.from(oracle.instructionDataBase64, "base64")).toEqual(
      Buffer.from([61, 243, 64, 36, 121, 38, 141, 241, 1]),
    );

    const duelKey = "ab".repeat(32);
    const metadataUri = `hyperia://duel/${duelKey}?outcome=cancelled`;
    const cancellation = buildEmergencyInstructionPlan({
      action: "cancel-duel",
      cluster: "devnet",
      releaseSha: RELEASE_SHA,
      expectedSigner: SIGNER,
      duelKey,
      metadataUri,
    });
    const metadata = Buffer.from(metadataUri, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(metadata.length);
    expect(Buffer.from(cancellation.instructionDataBase64, "base64")).toEqual(
      Buffer.concat([
        Buffer.from([83, 124, 224, 237, 235, 44, 38, 57]),
        Buffer.from(duelKey, "hex"),
        length,
        metadata,
      ]),
    );
    expect(cancellation.accounts.map((account) => account.role)).toEqual([
      "authority",
      "oracle_config",
      "duel_state",
    ]);
    expect(cancellation.expectedPostState).toEqual({
      duelKey,
      status: "cancelled",
      metadataUri,
    });
  });

  test("rejects ambiguous or unsafe plan inputs", () => {
    const base = {
      action: "market-pause" as const,
      cluster: "devnet" as const,
      releaseSha: RELEASE_SHA,
      expectedSigner: SIGNER,
    };
    expect(() =>
      buildEmergencyInstructionPlan({ ...base, releaseSha: "short" }),
    ).toThrow("release SHA");
    expect(() =>
      buildEmergencyInstructionPlan({
        ...base,
        expectedSigner: PublicKey.default.toBase58(),
      }),
    ).toThrow("zero key");
    expect(() =>
      buildEmergencyInstructionPlan({
        ...base,
        action: "cancel-duel",
        duelKey: "ab".repeat(32),
        metadataUri: "file:///unsafe",
      }),
    ).toThrow("https: or hyperia:");
    expect(() =>
      buildEmergencyInstructionPlan({
        ...base,
        action: "cancel-duel",
        duelKey: "AB".repeat(32),
        metadataUri: "hyperia://duel/cancelled",
      }),
    ).toThrow("lowercase hex");
    expect(() =>
      buildEmergencyInstructionPlan({
        ...base,
        action: "cancel-duel",
        duelKey: "ab".repeat(32),
        metadataUri: "https://metadata.invalid/cancelled?token=private",
      }),
    ).toThrow("secret parameters");
    expect(() =>
      buildEmergencyInstructionPlan({
        ...base,
        action: "market-pause",
        duelKey: "ab".repeat(32),
      }),
    ).toThrow("do not accept duel cancellation input");
  });

  test("writes a private plan exactly once", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "hyperbet-emergency-plan-"),
    );
    const outputPath = path.join(directory, "plan.json");
    try {
      const plan = buildEmergencyInstructionPlan({
        action: "market-unpause",
        cluster: "devnet",
        releaseSha: RELEASE_SHA,
        expectedSigner: SIGNER,
      });
      writeEmergencyInstructionPlan(outputPath, plan);
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(plan);
      expect(() => writeEmergencyInstructionPlan(outputPath, plan)).toThrow(
        /EEXIST/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
