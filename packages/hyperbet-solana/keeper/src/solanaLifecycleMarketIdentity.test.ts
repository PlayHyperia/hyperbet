import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  requireCanonicalLifecycleMarketIdentity,
  requireCanonicalMarketCreationIdentity,
} from "./solanaLifecycleMarketIdentity";

const DUEL_WINNER_MARKET_KIND = 1;
const fightProgramId = Keypair.generate().publicKey;
const marketProgramId = Keypair.generate().publicKey;
const duelKey = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
const duelState = PublicKey.findProgramAddressSync(
  [Buffer.from("duel"), Buffer.from(duelKey)],
  fightProgramId,
)[0];
const marketRef = deriveMarket(
  marketProgramId,
  duelState,
  DUEL_WINNER_MARKET_KIND,
);
const operator = Keypair.generate().publicKey;
const configRef = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  marketProgramId,
)[0];
const vaultRef = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), marketRef.toBuffer()],
  marketProgramId,
)[0];

function deriveMarket(
  programId: PublicKey,
  duelStatePda: PublicKey,
  marketKind: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), duelStatePda.toBuffer(), Uint8Array.of(marketKind)],
    programId,
  )[0];
}

function verify(overrides: Record<string, unknown> = {}) {
  return requireCanonicalLifecycleMarketIdentity({
    fightProgramId,
    marketProgramId,
    marketRef,
    duelState,
    duelKey,
    marketKind: DUEL_WINNER_MARKET_KIND,
    ...overrides,
  });
}

describe("finalized SOL lifecycle market identity", () => {
  test("binds the exact duel key, oracle PDA, launch kind, and market PDA", () => {
    expect(verify()).toEqual({
      marketRef: marketRef.toBase58(),
      duelStateRef: duelState.toBase58(),
      duelKeyHex: Buffer.from(duelKey).toString("hex"),
      marketKind: DUEL_WINNER_MARKET_KIND,
    });
  });

  test("rejects a self-consistent nonlaunch market kind", () => {
    const otherKind = 2;
    expect(() =>
      verify({
        marketKind: otherKind,
        marketRef: deriveMarket(marketProgramId, duelState, otherKind),
      }),
    ).toThrow("noncanonical");
  });

  test("rejects a self-consistent market around the wrong oracle account", () => {
    const wrongDuelState = Keypair.generate().publicKey;
    expect(() =>
      verify({
        duelState: wrongDuelState,
        marketRef: deriveMarket(
          marketProgramId,
          wrongDuelState,
          DUEL_WINNER_MARKET_KIND,
        ),
      }),
    ).toThrow("noncanonical");
  });

  test("rejects every malformed or singly drifted identity field", () => {
    for (const mutation of [
      { marketRef: Keypair.generate().publicKey },
      { duelState: Keypair.generate().publicKey },
      { duelKey: Uint8Array.from({ length: 32 }, () => 99) },
      { duelKey: Uint8Array.from([1, 2, 3]) },
      { duelKey: [...duelKey.slice(0, 31), 256] },
      { duelKey: [...duelKey.slice(0, 31), "32"] },
      { marketKind: 0 },
      { marketKind: 1.5 },
      { marketKind: "1" },
      { marketKind: { toString: () => "01" } },
    ]) {
      expect(() => verify(mutation)).toThrow("noncanonical");
    }
  });
});

function verifyCreation(overrides: Record<string, unknown> = {}) {
  return requireCanonicalMarketCreationIdentity({
    fightProgramId,
    marketProgramId,
    instructionDuelKey: duelKey,
    instructionMarketKind: DUEL_WINNER_MARKET_KIND,
    eventDuelKey: duelKey,
    eventMarketKind: DUEL_WINNER_MARKET_KIND,
    eventMarketRef: marketRef,
    accounts: [
      operator,
      configRef,
      duelState,
      marketRef,
      vaultRef,
      SystemProgram.programId,
    ],
    operatorSigned: true,
    nativeTransferCount: 0,
    ...overrides,
  });
}

describe("finalized SOL market creation identity", () => {
  test("binds one signed launch creation instruction to its exact event and accounts", () => {
    expect(verifyCreation()).toMatchObject({
      marketRef: marketRef.toBase58(),
      duelStateRef: duelState.toBase58(),
      duelKeyHex: Buffer.from(duelKey).toString("hex"),
      marketKind: DUEL_WINNER_MARKET_KIND,
      operatorRef: operator.toBase58(),
      configRef: configRef.toBase58(),
      vaultRef: vaultRef.toBase58(),
    });
  });

  test("rejects every creation argument, event, account, signer, or transfer drift", () => {
    const canonicalAccounts = [
      operator,
      configRef,
      duelState,
      marketRef,
      vaultRef,
      SystemProgram.programId,
    ];
    const wrong = Keypair.generate().publicKey;
    for (const mutation of [
      { eventDuelKey: Uint8Array.from({ length: 32 }, () => 88) },
      { instructionMarketKind: 2 },
      { eventMarketKind: 2 },
      { eventMarketRef: wrong },
      { accounts: canonicalAccounts.slice(0, 5) },
      {
        accounts: canonicalAccounts.map((value, index) =>
          index === 1 ? wrong : value,
        ),
      },
      {
        accounts: canonicalAccounts.map((value, index) =>
          index === 2 ? wrong : value,
        ),
      },
      {
        accounts: canonicalAccounts.map((value, index) =>
          index === 3 ? wrong : value,
        ),
      },
      {
        accounts: canonicalAccounts.map((value, index) =>
          index === 4 ? wrong : value,
        ),
      },
      {
        accounts: canonicalAccounts.map((value, index) =>
          index === 5 ? wrong : value,
        ),
      },
      { operatorSigned: false },
      { nativeTransferCount: 1 },
    ]) {
      expect(() => verifyCreation(mutation)).toThrow("noncanonical");
    }
  });
});
